/**
 * Pure task vocabulary types: ids, status, mutations, views, and the event
 * metas of both ledgers. Types plus the two brand-cast factories — like dsh's
 * SessionId, a compile-time cast is the whole runtime, so the factory lives
 * beside its type to export one merged symbol.
 * Spec: docs/design/05-seam-spec.md (this file is its §1–§3 translation).
 * @module @task-center/task/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Stable task identity, unique within the task domain. */
export type TaskId = Branded<'TaskId'>

/**
 * Brand a string as a {@link TaskId}.
 * @param id - the raw task id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function TaskId(id: string): TaskId {
  return id as TaskId
}

/** Monotonic task-domain event identity, unique within the domain event stream. */
export type TaskEventId = Branded<'TaskEventId'>

/**
 * Brand a string as a {@link TaskEventId}.
 * @param id - the raw event id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function TaskEventId(id: string): TaskEventId {
  return id as TaskEventId
}

/** Task lifecycle states. Archived tasks keep their status and move to the domain-global archive set. */
export type TaskStatus = 'todo' | 'active' | 'blocked' | 'review' | 'done'

/** State-changing verbs. Closed union; see the transition table in fold.ts. */
export type TaskOperation =
  | 'create'
  | 'edit'
  | 'claim'
  | 'progress'
  | 'block'
  | 'submit'
  | 'approve'
  | 'reject'
  | 'release'
  | 'abandon'
  | 'wake-set'
  | 'wake-clear'

/** Structured block reason, mirroring the goal block-reason shape. */
export interface TaskReason {
  readonly code: string
  readonly message: string
}

/** Optional wake rule attached to a task. Record shapes mirror dsh-schedule's. */
export type WakeRule =
  | { readonly kind: 'after'; readonly afterSeconds: number }
  | { readonly kind: 'at'; readonly scheduledAt: string }
  | { readonly kind: 'every'; readonly everySeconds: number; readonly anchorAt: string }

/** One mutation request. Discriminated union over the operation verbs. */
export type TaskMutation =
  | { readonly operation: 'create'; readonly taskId: TaskId; readonly objective: string; readonly acceptance: string; readonly workspaceIds?: readonly string[] }
  | { readonly operation: 'edit'; readonly objective?: string; readonly acceptance?: string }
  | { readonly operation: 'claim' }
  | { readonly operation: 'progress'; readonly note: string; readonly next?: string }
  | { readonly operation: 'block'; readonly reason: TaskReason }
  | { readonly operation: 'submit'; readonly completionNote: string }
  | { readonly operation: 'approve' }
  | { readonly operation: 'reject'; readonly reason: string }
  | { readonly operation: 'release' }
  | { readonly operation: 'abandon' }
  | { readonly operation: 'wake-set'; readonly rule: WakeRule }
  | { readonly operation: 'wake-clear' }

/** Durable task state, derived by folding the domain event stream. */
export interface TaskRecord {
  readonly id: TaskId
  readonly revision: number
  readonly objective: string
  readonly acceptance: string
  readonly status: TaskStatus
  readonly blockedReason?: TaskReason
  /** The live claiming session; absent while unclaimed, done, or abandoned. */
  readonly holder?: SessionId
  readonly workspaceIds: readonly string[]
  readonly sessionIds: readonly SessionId[]
  readonly contextPack: string
  readonly wakeRule?: WakeRule
  readonly subtasks: readonly TaskId[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Read-only projection served by `ctx.tasks`, with derived flags. */
export interface TaskView {
  readonly record: TaskRecord
  /** True while blocked longer than the alert threshold (P1; always false in S1). */
  readonly blockedOverdue: boolean
  readonly archived: boolean
}

/** Who performed one task mutation. */
export type TaskActor =
  | { readonly kind: 'model'; readonly sessionId: SessionId }
  | { readonly kind: 'human' }
  | { readonly kind: 'wake' }
  | { readonly kind: 'system' }

/** Snapshot-style session-event receipt for a session's model-initiated change (05 §2). */
export interface TaskSnapshotChangeMeta {
  readonly kind: 'task/change'
  readonly version: 1
  readonly operation: TaskOperation
  readonly taskId: TaskId
  readonly revision: number
  /** The mutation that committed — the receipt replays without the domain ledger. */
  readonly mutation: TaskMutation
  readonly task: TaskView
}

/** Session-event receipt for a context-pack injection at claim time (05 §2). */
export interface TaskContextInjectedMeta {
  readonly kind: 'task/context-injected'
  readonly version: 1
  readonly taskId: TaskId
  readonly revision: number
  readonly content: string
}

/** Authoritative task-domain event (the domain ledger entry, 05 §3). */
export interface TaskDomainEvent {
  readonly eventId: TaskEventId
  readonly taskId: TaskId
  readonly revision: number
  readonly actor: TaskActor
  readonly at: string
  readonly change: TaskSnapshotChangeMeta
}

/** Stable error codes for rejected task reads and mutations (05 §1). */
export type TaskErrorCode =
  | 'TASK_NOT_FOUND'
  | 'TASK_STALE_REVISION'
  | 'TASK_ALREADY_CLAIMED'
  | 'TASK_NOT_CLAIMED'
  | 'TASK_FORBIDDEN'
  | 'TASK_INVALID_OBJECTIVE'
  | 'TASK_INVALID_ACCEPTANCE'
  | 'TASK_INVALID_NOTE'
  | 'TASK_INVALID_REASON'
  | 'TASK_INVALID_TRANSITION'
  | 'TASK_WAKE_INVALID_RULE'
  | 'TASK_INVALID_FILTER'

/** Task service error carrying one stable code. */
export interface TaskError {
  readonly code: TaskErrorCode
  readonly message: string
}
