/**
 * The scheduler's external store: one module-level state over every scheduled
 * send, `useSyncExternalStore` snapshots, refcounted 10-second polling while
 * any surface is mounted, and the action wrappers that refetch after every
 * mutation. The store serves both session-page surfaces; the board detail
 * calls the same RPCs directly from its own bundle.
 * @module dsh-task-center-task-sched/client/store
 */

import { useSyncExternalStore } from 'react'
import type { SchedCancelResult, SchedCreateResult, SchedListResult, SchedSend } from '../wire.ts'
import { callSched } from './api.ts'
import type { ConnectionService } from './context.ts'

/** Poll cadence while any scheduling surface is mounted. */
const POLL_MS = 10_000

/** Everything the UI renders from. */
export interface SchedState {
  /** Latest sends snapshot; undefined before the first fetch lands. */
  readonly sends: readonly SchedSend[] | undefined
  /** Last refresh failure, when the channel itself errored. */
  readonly error: string | undefined
  /** Ephemeral action feedback (action errors). */
  readonly notice: string | undefined
  /** Bumped on every notice so an identical repeated message remounts the Toast. */
  readonly noticeSeq: number
}

type Listener = () => void

let state: SchedState = {
  sends: undefined, error: undefined, notice: undefined, noticeSeq: 0,
}
const listeners = new Set<Listener>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let mounted = 0
let refreshSeq = 0

function setState(patch: Partial<SchedState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

/** Latest-wins sends fetch; `quiet` skips the error overwrite during polls. */
async function refresh(connection: ConnectionService, options: { quiet?: boolean } = {}): Promise<void> {
  const seq = ++refreshSeq
  const result = await callSched<SchedListResult>(connection, 'schedList', {})
  if (seq !== refreshSeq) return
  if (result.ok === false) {
    if (options.quiet !== true) setState({ error: `${result.code}: ${result.message}` })
    return
  }
  setState({ error: undefined, sends: result.sends })
}

/** The sched store: subscribe/getSnapshot for React, commands for the UI. */
export const schedStore = {
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: (): SchedState => state,

  /**
   * A surface mounted: fetch now and poll while any surface stays mounted.
   * @param connection - the connection service to fetch through.
   * @returns the unmount cleanup for the effect that called this.
   */
  mount: (connection: ConnectionService): () => void => {
    mounted++
    if (mounted === 1) {
      void refresh(connection)
      pollTimer = setInterval(() => { void refresh(connection, { quiet: true }) }, POLL_MS)
    }
    return () => {
      mounted = Math.max(0, mounted - 1)
      if (mounted === 0 && pollTimer !== undefined) {
        clearInterval(pollTimer)
        pollTimer = undefined
      }
    }
  },
  /** Manual refresh. */
  manualRefresh: (connection: ConnectionService): void => { void refresh(connection) },
  /** connection/reset: everything cached is suspect; drop it. */
  reset: (): void => {
    refreshSeq++
    setState({ sends: undefined, error: undefined })
  },

  /** Schedule one send; success triggers a refetch. */
  create: async (
    connection: ConnectionService, sessionId: string, content: string, scheduledAt: string,
  ): Promise<SchedCreateResult> => {
    const result = await callSched<SchedCreateResult>(connection, 'schedCreate', { sessionId, content, scheduledAt })
    if (result.ok === false) setState({ notice: `${result.code}: ${result.message}`, noticeSeq: state.noticeSeq + 1 })
    else setState({ notice: undefined })
    await refresh(connection)
    return result
  },
  /** Cancel one send; every outcome triggers a refetch. */
  cancel: async (connection: ConnectionService, sendId: string): Promise<SchedCancelResult> => {
    const result = await callSched<SchedCancelResult>(connection, 'schedCancel', { sendId })
    if (result.ok === false) setState({ notice: `${result.code}: ${result.message}`, noticeSeq: state.noticeSeq + 1 })
    else setState({ notice: undefined })
    await refresh(connection)
    return result
  },
  /** Dismiss the ephemeral notice. */
  clearNotice: (): void => { setState({ notice: undefined }) },
}

/** React binding over the store. */
export function useSched(): SchedState {
  return useSyncExternalStore(schedStore.subscribe, schedStore.getSnapshot)
}
