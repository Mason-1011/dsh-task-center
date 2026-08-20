/**
 * Wire vocabulary between the sched host half (`task-sched/*` endpoints over
 * the web client's /api channel) and its browser consumers (the session-page
 * surfaces and the board detail). Pure JSON-safe shapes: optional facts are
 * OMITTED keys, never `undefined`/`null`.
 * @module dsh-task-center-task-sched/wire
 */

/** Lifecycle of one scheduled send. */
export type SendStatus = 'pending' | 'firing' | 'fired' | 'failed'

/** One scheduled user send, as stored and as crossed. */
export interface SchedSend {
  readonly id: string
  readonly sessionId: string
  /** Message text delivered verbatim as one user message (e.g. `cont`). */
  readonly content: string
  /** ISO instant the send is due. */
  readonly scheduledAt: string
  readonly status: SendStatus
  readonly createdAt: string
  /** ISO instant of settlement; omitted while pending or firing. */
  readonly settledAt?: string
  /** Failure note; set exactly when status is `failed`. */
  readonly note?: string
}

/** `schedList` outcome: every send, soonest first. */
export interface SchedListResult {
  readonly ok: true
  readonly sends: readonly SchedSend[]
}

/** Domain failure passthrough: the host's error codes reach the client verbatim. */
export interface SchedError {
  readonly ok: false
  readonly code: string
  readonly message: string
}

/** `schedCreate` success carries the new identity. */
export type SchedCreateResult =
  | { readonly ok: true; readonly id: string; readonly scheduledAt: string }
  | SchedError

/** `schedCancel` outcome. */
export type SchedCancelResult = { readonly ok: true } | SchedError
