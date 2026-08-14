/**
 * Pure task vocabulary types: ids, status, operations, views, and the two
 * session-event metas. Types only, no runtime code.
 * Spec: docs/design/05-seam-spec.md (this file is its §2 translation).
 * @module @task-center/task/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Stable task identity, unique within the task domain. */
export type TaskId = Branded<'TaskId'>

/** Monotonic task-domain event identity, unique within the domain event stream. */
export type TaskEventId = Branded<'TaskEventId'>

/** Task lifecycle states. Archived tasks keep their status and move to the domain-global archive set. */
export type TaskStatus = 'todo' | 'active' | 'blocked' | 'review' | 'done'

/** State-changing verbs. Closed union; see the transition table in 05-seam-spec.md §1. */
export type TaskOperation =
  | 'create'
  | 'edit'
  | 'claim'
  | 'progress'
  | 'block'
  | 'submit'
  | 'approve'
  | 'reject'
  | 'abandon'
  | 'wake-set'
  | 'wake-clear'

/** Structured block/reject reason, mirroring the goal block-reason shape. */
export interface TaskReason {
  readonly code: string
  readonly message: string
}

/** Optional wake rule attached to a task. Record shapes mirror dsh-schedule's. */
export type WakeRule =
  | { readonly kind: 'after'; readonly afterSeconds: number }
  | { readonly kind: 'at'; readonly scheduledAt: string }
  | { readonly kind: 'every'; readonly everySeconds: number; readonly anchorAt: string }

/** Durable task record stored in the task domain (02-data-model.md §1). */
export interface TaskRecord {
  readonly id: TaskId
  readonly revision: number
  readonly objective: string
  readonly acceptance: string
  readonly status: TaskStatus
  readonly blockedReason?: TaskReason
  readonly workspaceIds: readonly string[]
  readonly sessionIds: readonly SessionId[]
  readonly contextPack: string
  readonly wakeRule?: WakeRule
  readonly subtasks: readonly TaskId[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** Read-only projection served by `ctx.tasks`, with derived fields. */
export interface TaskView {
  readonly record: TaskRecord
  /** Live claiming session, present only while status is active/blocked. */
  readonly holder?: SessionId
  /** True while blocked longer than the configured alert threshold. */
  readonly blockedOverdue: boolean
  readonly archived: boolean
}

/** Who performed one task mutation. */
export type TaskActor =
  | { readonly kind: 'model'; readonly sessionId: SessionId }
  | { readonly kind: 'human' }
  | { readonly kind: 'wake' }

/** Snapshot-style session-event receipt written when a session's model mutates a task (05 §2). */
export interface TaskSnapshotChangeMeta {
  readonly kind: 'task/change'
  readonly version: 1
  readonly operation: TaskOperation
  readonly taskId: TaskId
  readonly revision: number
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
