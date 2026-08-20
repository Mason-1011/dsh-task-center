/**
 * Wire contracts for the `task-quota/*` RPC endpoints: the resume knob the
 * web board's head toggle reads and flips. Errors cross the wire as
 * `{ok:false,code,message}` envelopes, the same vocabulary as every other
 * task-family remote.
 * @module @task-center/task-quota/wire
 */

/** Domain failure passthrough: the host's error codes reach the client verbatim. */
export interface QuotaError {
  readonly ok: false
  readonly code: string
  readonly message: string
}

/** `quotaGet` outcome: the effective resume knob. */
export interface QuotaGetResult {
  readonly ok: true
  readonly resume: boolean
}

/** `quotaSet` outcome: success echoes the effective knob. */
export type QuotaSetResult = { readonly ok: true; readonly resume: boolean } | QuotaError
