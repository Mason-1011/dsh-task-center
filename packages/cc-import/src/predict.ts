/**
 * Pure-fold prediction: run the SAME folds task-source's extractor runs over a
 * mapped log and report which tier will speak and whether it births — so a
 * dry-run can say what the sweep will do before anything is written. The goal
 * tier is unreachable for CC transcripts (CC has no goal concept), so the
 * branch order here mirrors extractSession minus goals.
 * @module @task-center/cc-import/predict
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldApprovedPlan, foldTodos } from '@task-center/task-source'
import type { CcSession } from './parse.ts'
import { ccSessionId } from './materialize.ts'

// pnpm resolves two physical copies of dsh-session for this package and for
// task-source's compiled dist, so the two `SessionEvent` types are nominally
// distinct. The folds are pure functions over the same JSON wire format — the
// cross-boundary cast is type-level only, and the closed-loop test exercises
// these exact calls against the real folds at runtime.
type FoldableEvents = Parameters<typeof foldApprovedPlan>[0]

/** Bridge the two type identities of the same wire format. */
export function asFoldable(events: readonly SessionEvent[]): FoldableEvents {
  return events as FoldableEvents
}

/** What the extractor will do with one mapped session. */
export type TierPrediction =
  | { readonly tier: 'plan'; readonly title: string; readonly willBirth: boolean; readonly reason: string }
  | { readonly tier: 'todo'; readonly objective: string; readonly willBirth: boolean; readonly reason: string }
  | { readonly tier: 'summary'; readonly humanLines: number; readonly reason: string }
  | { readonly tier: 'none'; readonly reason: string }

/** One session's dry-run verdict. */
export interface SessionPrediction {
  readonly id: string
  readonly cwd: string | undefined
  readonly createdAt: number | undefined
  readonly humanPrompts: number
  readonly events: number
  readonly prediction: TierPrediction
}

/** Aggregates over a whole import run, for the report header. */
export interface PredictSummary {
  readonly sessions: number
  readonly planBirths: number
  readonly todoBirths: number
  readonly summaryQueue: number
  readonly noBirth: number
}

/**
 * Predict the tier verdict for one mapped event log. Mirrors the extractor's
 * branch order and birth conditions exactly — a divergence here is a bug in
 * this file, not a license to guess.
 * @param events - the mapped log (seq order).
 * @returns what the sweep will do with the session.
 */
export function predictTier(events: readonly SessionEvent[]): TierPrediction {
  const plan = foldApprovedPlan(asFoldable(events))
  if (plan !== undefined) {
    if (plan.todos === 'done') {
      return { tier: 'plan', title: plan.title, willBirth: false, reason: 'todo 全部完成——计划层退休,不出生' }
    }
    if (plan.todos === 'unfinished') {
      return { tier: 'plan', title: plan.title, willBirth: true, reason: '已批准的计划 + 未完成 todo——立即出生(无模型)' }
    }
    if (plan.activityAfterApproval) {
      return { tier: 'plan', title: plan.title, willBirth: false, reason: '计划已批准、之后有模型活动、但无 todo 跟踪——v1 归属空档:不出生也不总结' }
    }
    return { tier: 'plan', title: plan.title, willBirth: true, reason: '已批准的计划且尚未开工——立即出生(无模型)' }
  }
  const todos = foldTodos(asFoldable(events))
  if (todos !== undefined) {
    if (todos.unfinished.length === 0) {
      return { tier: 'todo', objective: todos.anchorText, willBirth: false, reason: 'todo 已全部完成——todo 层退休,不出生' }
    }
    if (todos.anchorSeq === null) {
      return { tier: 'todo', objective: todos.anchorText, willBirth: false, reason: 'todo 链前无人类消息锚点——不出生' }
    }
    return {
      tier: 'todo', objective: todos.anchorText, willBirth: true,
      reason: `锚定人类消息 seq ${todos.anchorSeq},${todos.unfinished.length} 项未完成——立即出生(无模型)`,
    }
  }
  const humanLines = conversationLines(events).filter(line => line.startsWith('用户: ')).length
  if (humanLines > 0) {
    return { tier: 'summary', humanLines, reason: '无结构信号、有人类发言——进总结层,由模型判定(受空闲门限流)' }
  }
  return { tier: 'none', reason: '无结构信号、无人类发言——不产生候选' }
}

/**
 * Predict one parsed CC session's outcome from its mapped log.
 * @param session - the parsed transcript.
 * @param events - its mapped event log.
 */
export function predictSession(session: CcSession, events: readonly SessionEvent[]): SessionPrediction {
  return {
    id: ccSessionId(session.sessionUuid),
    cwd: session.cwd,
    createdAt: session.createdAt,
    humanPrompts: session.counts.humanPrompts,
    events: events.length,
    prediction: predictTier(events),
  }
}

/** Fold predictions into report totals. */
export function summarizePredictions(predictions: readonly SessionPrediction[]): PredictSummary {
  let planBirths = 0
  let todoBirths = 0
  let summaryQueue = 0
  let noBirth = 0
  for (const { prediction } of predictions) {
    if (prediction.tier === 'plan' && prediction.willBirth) planBirths++
    else if (prediction.tier === 'todo' && prediction.willBirth) todoBirths++
    else if (prediction.tier === 'summary') summaryQueue++
    else noBirth++
  }
  return { sessions: predictions.length, planBirths, todoBirths, summaryQueue, noBirth }
}

/**
 * The conversation surface the summarizer tier reads — replicated from
 * task-source's private helper so the summary-tier prediction sees the same
 * eligibility line the extractor does (last 40 surface lines, `用户: `/`模型: `
 * prefixed).
 */
function conversationLines(events: readonly SessionEvent[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      lines.push(`用户: ${text}`)
    } else if (event.type === 'assistant/message') {
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text.trim() !== '') lines.push(`模型: ${text}`)
    }
  }
  return lines
}
