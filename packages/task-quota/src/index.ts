/**
 * `task-quota`: the quota face of the task seam — an `llm/stream` waterfall
 * listener that watches every model call. When a request ends in provider
 * quota exhaustion (`QUOTA`), the guard parks every task the failing session
 * holds BEFORE the loop sees the failure: block with a structured quota
 * reason (the pack line names the wall and the reset time), release the hold
 * (active/blocked → todo, so a fresh session may claim), and — while the
 * resume knob is on — set a one-shot wake rule at the reset instant.
 * task-wake then fires at reset and the continuation reads the pack — the
 * closed loop: 额度用尽 → 挂起释放 → 到点续做;with the knob off the loop ends
 * at 挂起释放 and a human resumes. The knob defaults from the
 * `resumeOnReset` config and flips at runtime through the `task-quota/*`
 * remotes (the web board's head toggle), the last flip persisting in this
 * plugin's own storage domain. The continuation's target is likewise
 * runtime-choosable: a fresh wake session (default), the session that hit
 * the wall, or one named session — the latter two ride the scheduled-send
 * channel at the reset instant, exactly like a human-scheduled `cont`.
 * @module @task-center/task-quota
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: carries the `task-sched` service augmentation into the build
// program; the reset-point send rides it when present, otherwise the wake
// rule takes over.
import type { SchedBoardService } from '@task-center/task-sched'
import type { TaskActor, TaskRecord, TaskView } from '@task-center/task'
import { decide, parkLine } from './signal.ts'
import type { ParkDecision, ResumeTarget } from './signal.ts'
import { memoryResume, openResume } from './state.ts'
import type { ResumeStore } from './state.ts'
import type { QuotaGetResult, QuotaSetResult, QuotaTargetSetResult } from './wire.ts'

export { decide, parkLine } from './signal.ts'
export type { ParkDecision, QuotaDecision, ResumeTarget } from './signal.ts'
export type { QuotaGetResult, QuotaSetResult, QuotaTargetSetResult } from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    'task-quota': TaskQuotaService
  }
}

/** Deployment knobs for the quota guard. */
export interface Config {
  /**
   * Declared plan window in seconds, used as the worst-case reset estimate when
   * the provider sends no delay with its exhaustion error (e.g. a 5-hour
   * coding-plan window declared as 18000). Optional: without it and without a
   * provider delay, tasks park without a wake rule and a human decides.
   */
  readonly fallbackWindowSeconds?: number
  /**
   * Default for the resume knob: whether a parked task carries the one-shot
   * wake rule at the expected reset instant, so task-wake resumes it
   * automatically. Default true; `false` parks and releases only — the pack
   * line then says a human decides — for deployments that want quota walls to
   * stay quiet until someone moves. The web board's head toggle overrides
   * this default at runtime; the flip persists across restarts.
   */
  readonly resumeOnReset?: boolean
}

/** Terminal error finish facts of one stream, or undefined. */
function terminalFailure(chunk: StreamChunk): LlmFailure | undefined {
  return chunk.type === 'finish' && chunk.reason.kind === 'error' ? chunk.reason.failure : undefined
}

/** The message the reset-point send delivers into the target session. */
function resumeMessage(record: TaskRecord): string {
  return [
    '[task-quota] 额度已恢复,续做以下任务。',
    `目标: ${record.objective}`,
    `验收: ${record.acceptance}`,
    `状态: ${record.status}`,
    '上下文包(历次会话的累积记录):',
    record.contextPack === '' ? '(尚无记录)' : record.contextPack,
    '指令:先用 task_claim 认领该任务,然后完成它;以 task_report(outcome=review)提交,completion note 逐条对照验收标准。',
  ].join('\n')
}

/**
 * The quota guard and knob RPC service (`task-quota/*` endpoints over the /api
 * channel). SRC mode: every `@Remote` method uses unique plain identifier
 * parameters and returns JSON-safe values.
 */
export class TaskQuotaService extends TypertRemoteService {
  /** The task seam must be present; the `llm/stream` waterfall comes with the LLM runtime. */
  static inject = ['tasks', 'llm'] as const

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'task-quota')
    if (config.resumeOnReset !== undefined && typeof config.resumeOnReset !== 'boolean') {
      throw new Error(`task-quota: resumeOnReset must be a boolean when set, got ${String(config.resumeOnReset)}`)
    }
    this.resumeDefault = config.resumeOnReset !== false
    // The park target for the generator below: a plain `function*` has no
    // lexical `this`, so the service travels as a local.
    const service: TaskQuotaService = this
    this.ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
      (async function* (inner: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
        for await (const chunk of inner) {
          const failure = terminalFailure(chunk)
          // Park before the loop observes the failure: state commits at the decision point.
          if (failure !== undefined && options.sessionId !== undefined) {
            const decision = decide(failure, config.fallbackWindowSeconds, new Date())
            if (decision.kind !== 'ignore') await service.park(options.sessionId, decision)
          }
          yield chunk
        }
      })(next()))
  }

  /** Config default of the resume knob; validated at construction. */
  private readonly resumeDefault: boolean

  /** The board toggle's last flip; undefined while it has never been flipped. */
  private resumeOverride: boolean | undefined

  /** The chosen resume target; undefined while never chosen (fresh default). */
  private targetOverride: ResumeTarget | undefined

  /** The resume store; memory until `[Service.init]` swaps in the durable one. */
  private store: ResumeStore = memoryResume()

  /** Open the durable resume store and prime the overrides from it. */
  async [Service.init](): Promise<void> {
    const facility = this.ctx.get('storageDomain')
    if (facility === undefined) {
      this.ctx.logger('task-quota').warn('no storage-domain facility mounted; the resume knob is memory-only')
      return
    }
    const opened = await openResume(facility)
    this.store = opened.resume
    this.resumeOverride = opened.resume.override()
    this.targetOverride = opened.resume.target()
    this.ctx.effect(() => () => void opened.close())
  }

  /** The effective resume knob: the toggle's last flip, else the config default. */
  getResume(): boolean {
    return this.resumeOverride ?? this.resumeDefault
  }

  /** The effective resume target: the chosen one, else a fresh wake session. */
  getTarget(): ResumeTarget {
    return this.targetOverride ?? { kind: 'fresh' }
  }

  /** Park every task the dying session holds: block → release → wake. */
  private async park(sessionId: SessionId, decision: ParkDecision): Promise<void> {
    const actor: TaskActor = { kind: 'model', sessionId }
    const held: TaskView[] = this.ctx.tasks.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })
      .filter(view => view.record.holder === sessionId && !view.archived)
    for (const view of held) {
      try {
        const blocked = await this.ctx.tasks.mutate(view.record.id, view.record.revision, {
          operation: 'block',
          reason: { code: 'quota', message: parkLine(decision, this.getResume(), this.getTarget()) },
        }, actor)
        if ('code' in blocked) throw new Error(blocked.code)
        const released = await this.ctx.tasks.mutate(view.record.id, blocked.record.revision, { operation: 'release' }, actor)
        if ('code' in released) throw new Error(released.code)
        if (decision.kind === 'park' && this.getResume()) {
          await this.armResume(released, sessionId, decision)
        }
        this.ctx.logger('task-quota').info('parked task at quota wall', { taskId: view.record.id, status: released.record.status })
      } catch (error) {
        // A concurrent park or the loop's own teardown may race us; the ledger keeps the first write.
        this.ctx.logger('task-quota').warn('park failed', { taskId: view.record.id, error })
      }
    }
  }

  /**
   * Arm the reset-point continuation of one parked task. `fresh` (and any
   * refusal or missing sched channel) lands on the one-shot wake rule the
   * same way; `origin`/`session` ride the scheduled-send channel at the reset
   * instant, exactly like a human-scheduled `cont`.
   */
  private async armResume(released: TaskView, sessionId: SessionId, decision: Extract<ParkDecision, { kind: 'park' }>): Promise<void> {
    const target = this.getTarget()
    if (target.kind !== 'fresh') {
      const sched: SchedBoardService | undefined = this.ctx.get('task-sched')
      const targetSession = target.kind === 'origin' ? sessionId : SessionId(target.sessionId)
      if (sched !== undefined) {
        const armed = await sched.schedCreate(targetSession, resumeMessage(released.record), decision.resetAt)
        if (armed.ok) {
          this.ctx.logger('task-quota').info('resume send armed', { taskId: released.record.id, session: targetSession, at: decision.resetAt })
          return
        }
        // The send channel refused (unknown session, time already past); the wake rule is the fallback.
        this.ctx.logger('task-quota').warn('resume send refused, falling back to fresh wake', { taskId: released.record.id, code: armed.code })
      } else {
        this.ctx.logger('task-quota').warn('no task-sched mounted, falling back to fresh wake', { taskId: released.record.id })
      }
    }
    const woken = await this.ctx.tasks.mutate(released.record.id, released.record.revision, {
      operation: 'wake-set',
      rule: { kind: 'at', scheduledAt: decision.resetAt },
    }, { kind: 'model', sessionId })
    if ('code' in woken) throw new Error(woken.code)
  }

  /** The effective knob and target, for the board head toggle. */
  @Remote('quotaGet')
  quotaGet(): QuotaGetResult {
    const target = this.getTarget()
    return {
      ok: true,
      resume: this.getResume(),
      target: target.kind,
      ...target.kind === 'session' ? { session: target.sessionId } : {},
    }
  }

  /**
   * Flip the resume knob (the board head toggle); the flip persists across
   * restarts and takes effect at the next quota wall — rules already parked
   * keep their wake.
   * @param value - the chosen state; booleans only, this crosses the wire.
   */
  @Remote('quotaSet')
  async quotaSet(value: boolean): Promise<QuotaSetResult> {
    if (typeof value !== 'boolean') {
      return { ok: false, code: 'QUOTA_INVALID_VALUE', message: 'value 必须是布尔值' }
    }
    await this.store.set(value)
    this.resumeOverride = value
    this.ctx.logger('task-quota').info('resume knob set', { value })
    return { ok: true, resume: this.getResume() }
  }

  /**
   * Choose where the armed continuation goes; the choice persists across
   * restarts and takes effect at the next quota wall.
   * @param target - `fresh` (a new wake session), `origin` (the session that
   *   hit the wall), or `session` (one named session).
   * @param sessionId - the named session's id; required only for `session`.
   *   (Named `sessionId`, not `session`: the SRC gateway reads a bare `session`
   *   parameter as a required SessionId lookup.)
   */
  @Remote('quotaTargetSet')
  async quotaTargetSet(target: string, sessionId: string | undefined): Promise<QuotaTargetSetResult> {
    if (target !== 'fresh' && target !== 'origin' && target !== 'session') {
      return { ok: false, code: 'QUOTA_INVALID_TARGET', message: 'target 必须是 fresh / origin / session' }
    }
    const chosen: ResumeTarget = target === 'session'
      ? { kind: 'session', sessionId: (sessionId ?? '').trim() }
      : { kind: target }
    if (chosen.kind === 'session' && chosen.sessionId === '') {
      return { ok: false, code: 'QUOTA_INVALID_SESSION', message: '指定会话时 session 不能为空' }
    }
    await this.store.setTarget(chosen)
    this.targetOverride = chosen
    this.ctx.logger('task-quota').info('resume target set', { target: chosen.kind, ...chosen.kind === 'session' ? { session: chosen.sessionId } : {} })
    return { ok: true, target: chosen.kind, ...chosen.kind === 'session' ? { session: chosen.sessionId } : {} }
  }
}

export default TaskQuotaService
