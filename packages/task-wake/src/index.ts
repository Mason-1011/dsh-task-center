/**
 * `task-wake`: the time face of the task seam — a host-level timer that reads
 * due `wakeRule`s, probes the fired-session route once (quota still exhausted
 * → defer: no consume, no fire, hold per the provider's delay), then consumes
 * the occurrence in the domain ledger as the wake actor (one-shots clear,
 * `every` advances its anchor past now — state commits before the session
 * starts, so a crash never double-fires) and starts a fresh agent session
 * whose first message injects the task and its context pack. The fired
 * session is an ordinary model actor: it claims and works the task through
 * the task tools. The timer itself performs no work operations, per the
 * authority matrix.
 * Spec: docs/design/03-plugins.md §2, 05-seam-spec.md §1 and §4.
 * @module @task-center/task-wake
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskId, TaskRecord, TaskView, WakeRule } from '@task-center/task'

/** Cordis plugin name. */
export const name = 'task-wake'

/** The task seam, the agent factory, and the model-call service must be present. */
export const inject = ['tasks', 'agentLoop', 'llm']

/** Deployment knobs for the wake host (no hardcoded tunables). */
export interface Config {
  /** Tick cadence in seconds. Required, positive. */
  readonly pollSeconds: number
  /** Model route for fired sessions. Both fields required. */
  readonly agent: { readonly provider: string; readonly model: string }
}

/**
 * The rule after this occurrence consumes it: one-shots (`after`, `at`) end,
 * `every` advances its anchor to the first occurrence strictly after `now`.
 * @param rule - the rule that just fired.
 * @param now - the wall-clock decision time.
 * @returns the replacement rule, or `'clear'` when the rule is spent.
 */
export function consumeOccurrence(rule: WakeRule, now: Date): WakeRule | 'clear' {
  if (rule.kind !== 'every') return 'clear'
  const step = rule.everySeconds * 1000
  let anchor = Date.parse(rule.anchorAt) + step
  while (anchor <= now.getTime()) anchor += step
  return { kind: 'every', everySeconds: rule.everySeconds, anchorAt: new Date(anchor).toISOString() }
}

/** First message of one fired session: the task and its pack, then the instruction. */
function injection(record: TaskRecord): string {
  return [
    '[task-wake] 定时唤醒:以下任务到点。',
    `目标: ${record.objective}`,
    `验收: ${record.acceptance}`,
    `状态: ${record.status}`,
    `上下文包(历次会话的累积记录):`,
    record.contextPack === '' ? '(尚无记录)' : record.contextPack,
    '指令:先用 task_claim 认领该任务,然后完成它;以 task_report(outcome=review)提交,completion note 逐条对照验收标准。',
  ].join('\n')
}

/** Outcome of one preflight probe of the fired-session route. */
interface Probe {
  /** Whether the route still reports quota exhaustion. */
  readonly walled: boolean
  /** Provider-requested delay to hold further probes, when it sent one. */
  readonly holdMs?: number
}

/**
 * Arm the poll timer and run one immediate tick. Fired sessions are
 * fire-and-forget: LLM failures are contained (the occurrence is already
 * consumed in the ledger) and logged.
 * @param ctx - Plugin context.
 * @param config - Tick cadence and fired-session model route.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isFinite(config.pollSeconds) || config.pollSeconds <= 0) {
    throw new Error('task-wake: pollSeconds must be a positive number of seconds')
  }
  if (config.agent.provider.trim() === '' || config.agent.model.trim() === '') {
    throw new Error('task-wake: agent.provider and agent.model must name the fired sessions\' route')
  }
  const logger = ctx.logger('task-wake')

  /**
   * One minimal request (no session identity) asking whether the route's quota
   * window reopened. Only a positive `QUOTA` answer defers; every other
   * finish — success, auth or transport error — and a thrown stream both mean
   * fire: a broken probe never blocks work.
   */
  const probe = async (): Promise<Probe> => {
    const options: GenerateOptions = {
      provider: config.agent.provider,
      model: config.agent.model,
      maxTokens: 1,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })],
    }
    try {
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk.type !== 'finish') continue
        if (chunk.reason.kind === 'error' && chunk.reason.failure.code === QUOTA_EXCEEDED_CODE) {
          const ms = chunk.reason.failure.providerRetryAfterMs
          return { walled: true, holdMs: ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : undefined }
        }
        return { walled: false }
      }
      return { walled: false }
    } catch (error) {
      // The stream contract keeps middleware and consumer failures thrown; firing
      // surfaces the real failure instead of silently parking on a broken probe.
      logger.warn('probe failed; firing anyway', { error })
      return { walled: false }
    }
  }

  const fire = (record: TaskRecord): void => {
    const agent = ctx.agentLoop.create(SessionId(`wake-${record.id.slice(0, 8)}-${Date.now()}`), config.agent)
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: injection(record) }],
      source: { kind: 'user' },
    }))
    void idle.catch(error => logger.warn('fired session failed', { taskId: record.id, error }))
  }

  /**
   * Consume one due occurrence in the ledger as the wake actor.
   * @returns the settled view, or undefined when the CAS lost a race.
   */
  const consume = async (taskId: TaskId, revision: number, rule: WakeRule): Promise<TaskView | undefined> => {
    const consumed = consumeOccurrence(rule, new Date())
    const bookkeeping = consumed === 'clear'
      ? { operation: 'wake-clear' as const }
      : { operation: 'wake-set' as const, rule: consumed }
    const settled = await ctx.tasks.mutate(taskId, revision, bookkeeping, { kind: 'wake' })
    if ('code' in settled) {
      logger.warn('wake bookkeeping rejected', { taskId, code: settled.code })
      return undefined
    }
    return settled
  }

  let probeHoldUntil = 0

  const tick = async (): Promise<void> => {
    if (Date.now() < probeHoldUntil) return
    let probed: Probe | undefined
    for (const due of ctx.tasks.wakeRules()) {
      const view = ctx.tasks.get(due.taskId)
      if (view === undefined || view.record.revision !== due.revision) continue
      const rule = view.record.wakeRule
      if (rule === undefined) continue
      // A held task consumes its occurrence without a probe: nothing would be fired.
      if (view.record.holder !== undefined) {
        if (await consume(due.taskId, due.revision, rule) === undefined) continue
        logger.info('due task is held by a live session; occurrence consumed without firing', { taskId: due.taskId })
        continue
      }
      if (probed === undefined) probed = await probe()
      if (probed.walled) {
        if (probed.holdMs !== undefined) probeHoldUntil = Date.now() + probed.holdMs
        logger.info('wake deferred: route still quota-exhausted', { taskId: due.taskId })
        continue
      }
      const settled = await consume(due.taskId, due.revision, rule)
      if (settled === undefined) continue
      logger.info('firing wake session', { taskId: due.taskId, status: settled.record.status })
      fire(settled.record)
    }
  }

  const guarded = (): void => void tick().catch(error => logger.warn('tick failed', { error }))
  const timer = setInterval(guarded, config.pollSeconds * 1000)
  ctx.effect(() => () => clearInterval(timer))
  guarded()
}
