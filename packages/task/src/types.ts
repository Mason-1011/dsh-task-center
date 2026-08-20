/**
 * Pure task vocabulary types: ids, status, mutations, views, and the event
 * metas of both ledgers. Types plus the two brand-cast factories — like dsh's
 * SessionId, a compile-time cast is the whole runtime, so the factory lives
 * beside its type to export one merged symbol.
 * Spec: docs/design/05-seam-spec.md (this file is its §1–§3 translation).
 * @module dsh-task-center-task/types
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

/** Stable project identity, unique within the task domain ledger. */
export type ProjectId = Branded<'ProjectId'>

/**
 * Brand a string as a {@link ProjectId}.
 * @param id - the raw project id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function ProjectId(id: string): ProjectId {
  return id as ProjectId
}

/** Stable candidate identity, unique within the task domain ledger. */
export type CandidateId = Branded<'CandidateId'>

/**
 * Brand a string as a {@link CandidateId}.
 * @param id - the raw candidate id string.
 * @returns the same string, branded (a compile-time cast — no runtime cost).
 */
export function CandidateId(id: string): CandidateId {
  return id as CandidateId
}

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
  | 'subtask-add'
  | 'subtask-remove'
  | 'abandon'
  | 'wake-set'
  | 'wake-clear'
  | 'patrol'

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

/**
 * Where a task was born. Promotions carry the candidate and its session; a
 * task surfaced straight from a session whose goal completed without a human
 * reply carries the session and that goal — the goal id is the dedup key, so
 * a re-trigger of the same completion never births twice.
 */
export type TaskOrigin =
  | { readonly candidateId: CandidateId; readonly sessionId: SessionId }
  | { readonly sessionId: SessionId; readonly goalId: string }

/**
 * One mutation request. Discriminated union over the operation verbs. A
 * `create` carrying `completionNote` is the acceptance birth: the task starts
 * in `review` (source actor only) — work a session declared complete surfaces
 * for the human verdict without ever being worked in the ledger.
 */
export type TaskMutation =
  | { readonly operation: 'create'; readonly taskId: TaskId; readonly objective: string; readonly acceptance: string; readonly projectId?: ProjectId; readonly workspacePath?: string; readonly origin?: TaskOrigin; readonly completionNote?: string }
  | { readonly operation: 'edit'; readonly objective?: string; readonly acceptance?: string; readonly projectId?: ProjectId | null }
  | { readonly operation: 'claim' }
  | { readonly operation: 'progress'; readonly note: string; readonly next?: string }
  | { readonly operation: 'block'; readonly reason: TaskReason }
  | { readonly operation: 'submit'; readonly completionNote: string }
  | { readonly operation: 'approve' }
  | { readonly operation: 'reject'; readonly reason: string }
  | { readonly operation: 'release' }
  | { readonly operation: 'subtask-add'; readonly childId: TaskId }
  | { readonly operation: 'subtask-remove'; readonly childId: TaskId }
  | { readonly operation: 'abandon' }
  | { readonly operation: 'wake-set'; readonly rule: WakeRule }
  | { readonly operation: 'wake-clear' }
  | { readonly operation: 'patrol'; readonly note: string; readonly next?: string; readonly blocker?: string }

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
  /** Birth workspace: the creating session's directory, stamped once at create and never rewritten. */
  readonly workspacePath?: string
  /** The project this task belongs to; absent while unassigned. */
  readonly projectId?: ProjectId
  readonly sessionIds: readonly SessionId[]
  readonly contextPack: string
  /** Birth provenance: set when the task was promoted from an extracted candidate. */
  readonly origin?: TaskOrigin
  readonly wakeRule?: WakeRule
  readonly subtasks: readonly TaskId[]
  readonly createdAt: string
  readonly updatedAt: string
  /**
   * Last instant this task was *worked* — any operation except patrol and wake
   * bookkeeping. Idleness reads this, so an observation-only patrol never
   * refreshes a task away from the stale banner.
   */
  readonly workedAt: string
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
  | { readonly kind: 'source' }

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

/** State-changing project verbs. Closed union; projects carry no status machine. */
export type ProjectOperation = 'project-create' | 'project-rename' | 'project-archive'

/** One project mutation request. */
export type ProjectMutation =
  | { readonly operation: 'project-create'; readonly projectId: ProjectId; readonly name: string }
  | { readonly operation: 'project-rename'; readonly name: string }
  | { readonly operation: 'project-archive' }

/** Durable project state, derived by folding the same domain event stream. */
export interface ProjectRecord {
  readonly id: ProjectId
  readonly revision: number
  readonly name: string
  readonly archived: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** Read-only project projection served by `ctx.tasks`. */
export interface ProjectView {
  readonly record: ProjectRecord
}

/** Snapshot-style receipt for one committed project change (the live twin of the domain event). */
export interface ProjectSnapshotChangeMeta {
  readonly kind: 'project/change'
  readonly version: 1
  readonly operation: ProjectOperation
  readonly projectId: ProjectId
  readonly revision: number
  readonly mutation: ProjectMutation
  readonly project: ProjectView
}

/** Authoritative project-domain event; shares the ledger and stream with tasks. */
export interface ProjectDomainEvent {
  readonly eventId: TaskEventId
  readonly projectId: ProjectId
  readonly revision: number
  readonly actor: TaskActor
  readonly at: string
  readonly change: ProjectSnapshotChangeMeta
}

/** Candidate lifecycle: pending until a human promotes or ignores it, or the source finishes the work. */
export type CandidateStatus = 'pending' | 'promoted' | 'ignored' | 'superseded'

/**
 * Which extractor tier produced a candidate and from which session. `key` is
 * stable per source record (goal id, plan exit, todo anchor, summary verdict),
 * so a re-trigger of the same source deduplicates on it.
 */
export interface CandidateOrigin {
  readonly sessionId: SessionId
  readonly tier: 'goal' | 'plan' | 'todo' | 'summary'
  readonly key: string
}

/** Durable candidate state, derived by folding the same domain event stream. */
export interface CandidateRecord {
  readonly id: CandidateId
  readonly revision: number
  readonly status: CandidateStatus
  readonly objective: string
  /** Acceptance draft; goal/plan/todo tiers leave it for the promoting human. */
  readonly acceptance: string
  /** Provenance note: blocker, unfinished todos, plan body. */
  readonly note: string
  readonly origin: CandidateOrigin
  /** The task this candidate became at promote time. */
  readonly promotedTaskId?: TaskId
  readonly createdAt: string
  readonly updatedAt: string
}

/** Read-only candidate projection served by `ctx.tasks`. */
export interface CandidateView {
  readonly record: CandidateRecord
}

/** State-changing candidate verbs. Closed union; `pending` is the only live status. */
export type CandidateOperation = 'candidate-create' | 'candidate-promote' | 'candidate-ignore' | 'candidate-supersede'

/** One candidate mutation request. */
export type CandidateMutation =
  | { readonly operation: 'candidate-create'; readonly candidateId: CandidateId; readonly objective: string; readonly acceptance?: string; readonly note?: string; readonly origin: CandidateOrigin }
  | { readonly operation: 'candidate-promote'; readonly acceptance: string; readonly objective?: string; readonly taskId: TaskId }
  | { readonly operation: 'candidate-ignore' }
  | { readonly operation: 'candidate-supersede'; readonly reason: string }

/** Snapshot-style receipt for one committed candidate change. */
export interface CandidateSnapshotChangeMeta {
  readonly kind: 'candidate/change'
  readonly version: 1
  readonly operation: CandidateOperation
  readonly candidateId: CandidateId
  readonly revision: number
  readonly mutation: CandidateMutation
  readonly candidate: CandidateView
}

/** Authoritative candidate-domain event; shares the ledger and stream with tasks and projects. */
export interface CandidateDomainEvent {
  readonly eventId: TaskEventId
  readonly candidateId: CandidateId
  readonly revision: number
  readonly actor: TaskActor
  readonly at: string
  readonly change: CandidateSnapshotChangeMeta
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
  | 'TASK_SUBTASK_SELF'
  | 'TASK_SUBTASK_CYCLE'
  | 'TASK_SUBTASK_DUPLICATE'
  | 'TASK_SUBTASK_NOT_CHILD'
  | 'TASK_WAKE_INVALID_RULE'
  | 'TASK_INVALID_FILTER'
  | 'TASK_DUPLICATE_ORIGIN'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ALREADY_EXISTS'
  | 'PROJECT_INVALID_NAME'
  | 'PROJECT_FORBIDDEN'
  | 'PROJECT_ARCHIVED'
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_ALREADY_EXISTS'
  | 'CANDIDATE_INVALID_OBJECTIVE'
  | 'CANDIDATE_INVALID_ACCEPTANCE'
  | 'CANDIDATE_INVALID_TRANSITION'
  | 'CANDIDATE_FORBIDDEN'
  | 'CANDIDATE_DUPLICATE_ORIGIN'
  | 'CANDIDATE_INVALID_REASON'

/** Task service error carrying one stable code. */
export interface TaskError {
  readonly code: TaskErrorCode
  readonly message: string
}
