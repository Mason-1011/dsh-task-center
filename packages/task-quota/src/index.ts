/**
 * `task-quota`: the quota face of the task seam — an `llm/stream` waterfall
 * listener that watches every model call. When a request ends in provider
 * quota exhaustion (`QUOTA`), the guard parks every task the failing session
 * holds BEFORE the loop sees the failure: block with a structured quota
 * reason (the pack line names the wall and the reset time), release the hold
 * (active/blocked → todo, so a fresh session may claim), and set a one-shot
 * wake rule at the reset instant. task-wake then fires at reset and the
 * continuation reads the pack — the closed loop: 额度用尽 → 挂起释放 → 到点续做.
 * @module @task-center/task-quota
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskActor, TaskView } from '@task-center/task'
import { decide, parkLine } from './signal.ts'
import type { ParkDecision } from './signal.ts'

export { decide, parkLine } from './signal.ts'
export type { ParkDecision, QuotaDecision } from './signal.ts'

/** Cordis plugin name. */
export const name = 'task-quota'

/** The task seam must be present; the `llm/stream` waterfall comes with the LLM runtime. */
export const inject = ['tasks', 'llm']

/** Deployment knobs for the quota guard. */
export interface Config {
  /**
   * Declared plan window in seconds, used as the worst-case reset estimate when
   * the provider sends no delay with its exhaustion error (e.g. a 5-hour
   * coding-plan window declared as 18000). Optional: without it and without a
   * provider delay, tasks park without a wake rule and a human decides.
   */
  readonly fallbackWindowSeconds?: number
}

/** Terminal error finish facts of one stream, or undefined. */
function terminalFailure(chunk: StreamChunk): LlmFailure | undefined {
  return chunk.type === 'finish' && chunk.reason.kind === 'error' ? chunk.reason.failure : undefined
}

/**
 * Register the waterfall listener.
 * @param ctx - Plugin context.
 * @param config - Fallback window declaration.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('task-quota')

  /** Park every task the dying session holds: block → release → wake. */
  const park = async (sessionId: SessionId, decision: ParkDecision): Promise<void> => {
    const actor: TaskActor = { kind: 'model', sessionId }
    const held: TaskView[] = ctx.tasks.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })
      .filter(view => view.record.holder === sessionId && !view.archived)
    for (const view of held) {
      try {
        const blocked = await ctx.tasks.mutate(view.record.id, view.record.revision, {
          operation: 'block',
          reason: { code: 'quota', message: parkLine(decision) },
        }, actor)
        if ('code' in blocked) throw new Error(blocked.code)
        const released = await ctx.tasks.mutate(view.record.id, blocked.record.revision, { operation: 'release' }, actor)
        if ('code' in released) throw new Error(released.code)
        if (decision.kind === 'park') {
          const woken = await ctx.tasks.mutate(view.record.id, released.record.revision, {
            operation: 'wake-set',
            rule: { kind: 'at', scheduledAt: decision.resetAt },
          }, actor)
          if ('code' in woken) throw new Error(woken.code)
        }
        logger.info('parked task at quota wall', { taskId: view.record.id, status: released.record.status })
      } catch (error) {
        // A concurrent park or the loop's own teardown may race us; the ledger keeps the first write.
        logger.warn('park failed', { taskId: view.record.id, error })
      }
    }
  }

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
    (async function* (inner: AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
      for await (const chunk of inner) {
        const failure = terminalFailure(chunk)
        // Park before the loop observes the failure: state commits at the decision point.
        if (failure !== undefined && options.sessionId !== undefined) {
          const decision = decide(failure, config.fallbackWindowSeconds, new Date())
          if (decision.kind !== 'ignore') await park(options.sessionId, decision)
        }
        yield chunk
      }
    })(next()))
}
