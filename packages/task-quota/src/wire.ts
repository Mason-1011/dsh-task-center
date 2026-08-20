/**
 * Wire contracts for the `task-quota/*` RPC endpoints: the resume knob the
 * web board's head toggle reads and flips. Errors cross the wire as
 * `{ok:false,code,message}` envelopes, the same vocabulary as every other
 * task-family remote.
 * @module dsh-task-center-task-quota/wire
 */

/** Domain failure passthrough: the host's error codes reach the client verbatim. */
export interface QuotaError {
  readonly ok: false
  readonly code: string
  readonly message: string
}

/** Which session the reset-point continuation goes to. */
export type ResumeTargetKind = 'fresh' | 'origin' | 'session'

/** `quotaGet` outcome: the effective knob and its target. */
export interface QuotaGetResult {
  readonly ok: true
  readonly resume: boolean
  readonly target: ResumeTargetKind
  /** The named session; present only while `target` is `session`. */
  readonly session?: string
}

/** `quotaSet` outcome: success echoes the effective knob. */
export type QuotaSetResult = { readonly ok: true; readonly resume: boolean } | QuotaError

/** `quotaTargetSet` outcome: success echoes the effective target. */
export type QuotaTargetSetResult =
  | { readonly ok: true; readonly target: ResumeTargetKind; readonly session?: string }
  | QuotaError
