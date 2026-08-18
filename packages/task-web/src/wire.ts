/**
 * Wire vocabulary between the host RPC half (`task-board/*` endpoints) and the
 * browser kanban client. Pure JSON-safe shapes: optional facts are OMITTED
 * keys, never `undefined`/`null` — the gateway rejects undefined values, and
 * the client treats absence as "not applicable".
 * @module @task-center/task-web/wire
 */

import type { CandidateStatus, TaskStatus } from '@task-center/task'

export type { CandidateStatus, TaskStatus } from '@task-center/task'

/** Human-triggered card action; each maps onto one seam mutation. */
export type BoardAction = 'approve' | 'reject' | 'block' | 'release' | 'abandon'

/** One project filter chip with its live task count. */
export interface ProjectChip {
  readonly id: string
  readonly name: string
  readonly archived: boolean
  readonly taskCount: number
}

/**
 * One kanban card. `idleDays` is the subtree-aware effective idle; open tasks
 * with `idleDays >= 1` earn the「闲置 N 天」marker client-side.
 */
export interface TaskCard {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly acceptance: string
  readonly status: TaskStatus
  readonly archived: boolean
  readonly idleDays: number
  readonly subtaskCount: number
  /** Holding session id; omitted when unclaimed. */
  readonly holder?: string
  /** Owning project id; omitted for the unassigned bucket. */
  readonly projectId?: string
  /** Blocking reason code; omitted unless status is blocked. */
  readonly blockedCode?: string
  /** Blocking reason message; omitted unless status is blocked. */
  readonly blockedMessage?: string
  /** Present (true) when a wake rule is armed. */
  readonly hasWake?: boolean
}

/** The stalest open task pinned over the board once it crosses `staleDays`. */
export interface BoardPayload {
  readonly staleDays: number
  readonly now: string
  readonly projects: readonly ProjectChip[]
  readonly tasks: readonly TaskCard[]
  /** The 待确认 column: pending candidates, oldest first. */
  readonly candidates: readonly CandidateCard[]
  /** The ⚠ banner card; omitted when no open task is stale enough. */
  readonly stalest?: TaskCard
}

/**
 * One extraction candidate card: work the source extractor found in an idle
 * session, waiting for the human verdict (晋升 with an acceptance, or 忽略).
 */
export interface CandidateCard {
  readonly id: string
  readonly revision: number
  readonly status: CandidateStatus
  readonly objective: string
  /** Extractor note (e.g. the goal's blocker); empty string when none. */
  readonly note: string
  /** Which dsh record family the candidate came from. */
  readonly tier: 'goal' | 'plan' | 'todo' | 'summary'
  /** The session the candidate was extracted from. */
  readonly sessionId: string
  readonly createdAt: string
}

/** One child row inside the detail view. */
export interface ChildLine {
  readonly id: string
  readonly revision: number
  readonly objective: string
  readonly status: TaskStatus
  readonly archived: boolean
  readonly idleDays: number
}

/** Detail payload of one task (`show`). */
export interface ShowPayload {
  readonly task: TaskCard
  /** Owning project name; omitted for the unassigned bucket. */
  readonly projectName?: string
  readonly children: readonly ChildLine[]
  /** Last 8 lines of the context pack; empty string when nothing is recorded. */
  readonly packTail: string
}

/** Domain failure passthrough: TaskError codes reach the client verbatim. */
export interface RpcError {
  readonly ok: false
  readonly code: string
  readonly message: string
}

/** `show` outcome. */
export type ShowResult = ({ readonly ok: true } & ShowPayload) | RpcError

/** `act` success carries the post-mutation revision and status. */
export type ActResult =
  | { readonly ok: true; readonly revision: number; readonly status: TaskStatus }
  | RpcError

/** `create` success carries the new identity. */
export type CreateResult =
  | { readonly ok: true; readonly id: string; readonly revision: number }
  | RpcError

/** `promote` success carries the born task's id. */
export type PromoteResult =
  | { readonly ok: true; readonly taskId: string }
  | RpcError

/** `ignore` outcome. */
export type IgnoreResult =
  | { readonly ok: true }
  | RpcError
