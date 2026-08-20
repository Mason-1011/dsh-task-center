/**
 * Pure quota-decision math: one terminal provider failure as a park decision.
 * Providers are already normalized — dsh-llm adapters classify exhaustion as
 * the provider-neutral `QUOTA` code and retain the provider-requested delay —
 * so this module only decides what the task seam should do with that signal.
 * @module @task-center/task-quota/signal
 */

import { QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** What the guard should do with one terminal model-request failure. */
export type QuotaDecision =
  | {
    /** Park every task the failing session holds: block, release, wake at resetAt. */
    readonly kind: 'park'
    /** ISO-8601 instant when the quota window is expected to reset. */
    readonly resetAt: string
    /** Where the reset time came from: the provider's own delay, or the declared fallback window. */
    readonly from: 'provider' | 'fallback'
  }
  | {
    /** Quota is exhausted but no reset time exists anywhere: park without a wake rule; a human decides. */
    readonly kind: 'park-without-wake'
  }
  | {
    /** Not an exhaustion failure (auth error, transient rate limit, transport): the seam stays out of it. */
    readonly kind: 'ignore'
  }

/**
 * Decide the park action for one terminal failure.
 * @param failure - the terminal `error` finish facts, provider-neutral.
 * @param fallbackWindowSeconds - declared plan window used when the provider
 *   sent no usable delay (worst case: the window just restarted).
 * @param now - the decision-time wall clock.
 * @returns the decision for the guard to execute.
 */
export function decide(failure: LlmFailure, fallbackWindowSeconds: number | undefined, now: Date): QuotaDecision {
  if (failure.code !== QUOTA_EXCEEDED_CODE) return { kind: 'ignore' }
  const providerMs = failure.providerRetryAfterMs
  if (providerMs !== undefined && Number.isFinite(providerMs) && providerMs > 0) {
    return { kind: 'park', resetAt: new Date(now.getTime() + providerMs).toISOString(), from: 'provider' }
  }
  if (fallbackWindowSeconds !== undefined && Number.isFinite(fallbackWindowSeconds) && fallbackWindowSeconds > 0) {
    return { kind: 'park', resetAt: new Date(now.getTime() + fallbackWindowSeconds * 1000).toISOString(), from: 'fallback' }
  }
  return { kind: 'park-without-wake' }
}

/** A park decision the guard will execute (everything but `ignore`). */
export type ParkDecision = Exclude<QuotaDecision, { kind: 'ignore' }>

/**
 * Human-readable pack line for one park, so the next session resumes from the
 * wall it hit.
 * @param decision - the executed park decision.
 * @param resumeOnReset - whether the guard set the reset-instant wake rule
 *   (the plugin's `resumeOnReset` knob; the line must say who continues).
 * @returns the pack line naming the wall, the expected reset, and the mover.
 */
export function parkLine(decision: ParkDecision, resumeOnReset = true): string {
  if (decision.kind === 'park-without-wake') return '额度用尽,平台未给出恢复时间;任务已释放,等人工设唤醒或换 key'
  const wall = `额度用尽(预计 ${decision.resetAt} 恢复${decision.from === 'fallback' ? ',按声明窗口推算' : ''});任务已释放`
  return resumeOnReset ? `${wall},到点自动唤醒续做` : `${wall},自动续做已关闭,等人工唤醒`
}
