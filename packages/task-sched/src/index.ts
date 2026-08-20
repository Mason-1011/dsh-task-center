/**
 * `task-sched`: 定时发送 — the human schedules a user message (default `cont`)
 * into any known session, from the board detail or the session page, and a
 * host-level timer delivers it at the due instant: a live session takes the
 * message directly; a shelved one is resumed from persistence for one turn
 * (composed onto the preset its own log recorded) and released after it. The
 * delivery path is the acceptance-rejection push's, so a scheduled `cont`
 * reads to the model exactly like the human typing it then and there.
 *
 * Sends live in this plugin's own storage domain (`task_sched`), beside —
 * never inside — the task ledger: a send is scheduling bookkeeping, not task
 * domain state. One runner per table is assumed (the web daemon); a row left
 * `firing` by a crash is handed back to pending at boot, so delivery resumes
 * rather than doubles. Errors cross the wire as `{ok:false,code}` envelopes.
 * @module dsh-task-center-task-sched
 */

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: carries the `agents` registry augmentation and the `AgentSetup`
// composition hook into the build program; delivery runs through `ctx.agents`.
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: carries the `sessionPersistence` service augmentation into the
// build program; the create-time existence check reads it optionally.
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { recordedPresetSetup } from 'dsh-task-center-task-source'
import { memorySends, openSends } from './sends.ts'
import type { Sends } from './sends.ts'
import type { SchedCancelResult, SchedCreateResult, SchedListResult, SchedSend } from './wire.ts'

export type * from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    'task-sched': SchedBoardService
  }
}

/** Deployment knobs for the sched host (no hardcoded tunables). */
export interface Config {
  /** Tick cadence in seconds. Required, positive. */
  readonly pollSeconds: number
  /** Model route a resumed (shelved) target session's turn rides. Both fields required. */
  readonly agent: { readonly provider: string; readonly model: string }
}

/**
 * Deliver one message into its target session as one user message. A live
 * session takes the message directly; a shelved one is resumed for one turn —
 * composed onto the preset its own log recorded, without which the turn would
 * hear `unknown tool` for every call its original session made — and
 * released after it. The message stays in the session's log whatever happens
 * to the turn.
 * @param ctx - Context carrying `agents`.
 * @param config - the route a resumed session's turn rides.
 * @param sessionId - the target session.
 * @param content - the message text, delivered verbatim.
 */
export async function deliverSend(ctx: Context, config: Config, sessionId: SessionId, content: string): Promise<void> {
  const live = ctx.agents.get(sessionId)
  const handle = live === undefined
    ? await ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: config.agent,
        setup: await recordedPresetSetup(ctx, sessionId),
      })
    : undefined
  const agent = live ?? handle!.agent
  try {
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: content }],
      source: { kind: 'user' },
    }))
    await idle
  } finally {
    await handle?.dispose()
  }
}

/**
 * The scheduling RPC service and timer. SRC mode: every `@Remote` method uses
 * unique plain identifier parameters and returns JSON-safe values — optional
 * facts are omitted keys, never undefined.
 */
export class SchedBoardService extends TypertRemoteService {
  /** Delivery runs through the agent registry; the create-time existence check reads the session store. */
  static inject = ['agents', 'sessions']

  constructor(ctx: Context, config: Config) {
    super(ctx, 'task-sched')
    if (!Number.isFinite(config.pollSeconds) || config.pollSeconds <= 0) {
      throw new Error('task-sched: pollSeconds must be a positive number of seconds')
    }
    if (config.agent.provider.trim() === '' || config.agent.model.trim() === '') {
      throw new Error('task-sched: agent.provider and agent.model must name the resumed sessions\' route')
    }
    this.config = config
  }

  /** The route a resumed session's turn rides; validated at construction. */
  private readonly config: Config

  /** The sends table; memory until `[Service.init]` swaps in the durable one. */
  private sends: Sends = memorySends()

  /** Open the durable sends, recover crash-interrupted firings, arm the timer. */
  async [Service.init](): Promise<void> {
    const facility = this.ctx.get('storageDomain')
    if (facility !== undefined) {
      const opened = await openSends(facility)
      this.sends = opened.sends
      this.ctx.effect(() => () => void opened.close())
    } else {
      this.ctx.logger('task-sched').warn('no storage-domain facility mounted; scheduled sends are memory-only')
    }
    // A row stuck in firing means the runner died mid-delivery (one runner per
    // table is assumed); hand it back so the timer re-fires it.
    for (const row of this.sends.list()) {
      if (row.status === 'firing') await this.sends.put({ ...row, status: 'pending' })
    }
    const timer = setInterval(
      () => void this.tick().catch(error => this.ctx.logger('task-sched').warn('tick failed', { error })),
      this.config.pollSeconds * 1000,
    )
    this.ctx.effect(() => () => clearInterval(timer))
  }

  /** Fire every due pending send: claim durably as firing, deliver, settle. */
  private async tick(): Promise<void> {
    for (const row of this.sends.list()) {
      if (row.status !== 'pending' || Date.parse(row.scheduledAt) > Date.now()) continue
      // The claim is durable: a crash between here and settlement leaves the
      // row firing, which boot recovery hands back to pending.
      await this.sends.put({ ...row, status: 'firing' })
      try {
        await deliverSend(this.ctx, this.config, SessionId(row.sessionId), row.content)
        await this.sends.put({ ...row, status: 'fired', settledAt: new Date().toISOString() })
        this.ctx.logger('task-sched').info('scheduled send delivered', { id: row.id, sessionId: row.sessionId })
      } catch (error) {
        await this.sends.put({ ...row, status: 'failed', settledAt: new Date().toISOString(), note: String(error) })
        this.ctx.logger('task-sched').warn('scheduled send failed', { id: row.id, sessionId: row.sessionId, error })
      }
    }
  }

  /** Every send, soonest first; terminal rows included so the UI can show history. */
  @Remote('schedList')
  schedList(): SchedListResult {
    return { ok: true, sends: this.sends.list() }
  }

  /**
   * Schedule one send. The target must be a known session (live or persisted)
   * and the due instant strictly in the future; content arrives non-empty or
   * is rejected — the `cont` default is the client's choice, not the host's.
   */
  @Remote('schedCreate')
  async schedCreate(sessionId: string, content: string, scheduledAt: string): Promise<SchedCreateResult> {
    const trimmedSession = (sessionId ?? '').trim()
    const trimmedContent = (content ?? '').trim()
    if (trimmedSession === '') return { ok: false, code: 'SCHED_INVALID_SESSION', message: '会话 id 不能为空' }
    if (trimmedContent === '') return { ok: false, code: 'SCHED_INVALID_CONTENT', message: '发送内容不能为空' }
    const due = Date.parse(scheduledAt ?? '')
    if (Number.isNaN(due) || due <= Date.now()) {
      return { ok: false, code: 'SCHED_INVALID_TIME', message: '发送时间必须是未来的时刻' }
    }
    if (this.ctx.sessions.get(SessionId(trimmedSession)) === undefined) {
      const persistence: SessionPersistence | undefined = this.ctx.get('sessionPersistence')
      const persisted = persistence !== undefined && (await persistence.list()).some(entry => entry.id === trimmedSession)
      if (!persisted) return { ok: false, code: 'SCHED_UNKNOWN_SESSION', message: '没有这个会话(既不在运行中,也不在历史里)' }
    }
    const row: SchedSend = {
      id: randomUUID(),
      sessionId: trimmedSession,
      content: trimmedContent,
      scheduledAt: new Date(due).toISOString(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    await this.sends.put(row)
    return { ok: true, id: row.id, scheduledAt: row.scheduledAt }
  }

  /** Cancel one pending send, or clear one settled row from the list. */
  @Remote('schedCancel')
  async schedCancel(sendId: string): Promise<SchedCancelResult> {
    const row = this.sends.get((sendId ?? '').trim())
    if (row === undefined) return { ok: false, code: 'SCHED_NOT_FOUND', message: '没有这条定时发送' }
    if (row.status === 'firing') return { ok: false, code: 'SCHED_FIRING', message: '正在发送,无法取消' }
    await this.sends.delete(row.id)
    return { ok: true }
  }
}

export default SchedBoardService
