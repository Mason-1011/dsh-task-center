/**
 * The board's external store: one module-level state, `useSyncExternalStore`
 * snapshots, 10-second polling while open, latest-wins refreshes, and the
 * action wrappers that refetch after every mutation. CAS races surface as a
 * notice plus an immediate refresh — two humans clicking the same card never
 * overwrite each other silently.
 * @module @task-center/task-web/client/store
 */

import { useSyncExternalStore } from 'react'
import type { ActResult, BoardPayload, CreateResult, IgnoreResult, PromoteResult, ShowResult } from '../wire.ts'
import { callApi } from './api.ts'
import type { ConnectionService } from './context.ts'

/** Poll cadence while the board is open (no push channel for SRC services). */
const POLL_MS = 10_000

/** Everything the UI renders from. */
export interface BoardState {
  /** Whether the overlay is up. */
  readonly open: boolean
  /** A refresh is in flight (drives the spin state). */
  readonly loading: boolean
  /** Latest board snapshot. */
  readonly payload: BoardPayload | undefined
  /** Last refresh failure, when the channel itself errored. */
  readonly error: string | undefined
  /** ISO instant of the last successful fetch (the「刷新」affordance shows it). */
  readonly fetchedAt: string | undefined
  /** Ephemeral action feedback (CAS-stale notice, action errors). */
  readonly notice: string | undefined
  /** Bumped on every notice so an identical repeated message remounts the Toast. */
  readonly noticeSeq: number
}

type Listener = () => void

let state: BoardState = {
  open: false, loading: false, payload: undefined, error: undefined, fetchedAt: undefined, notice: undefined, noticeSeq: 0,
}
const listeners = new Set<Listener>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let refreshSeq = 0

function setState(patch: Partial<BoardState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

/** Latest-wins board fetch; `quiet` skips the loading flip (polls, priming). */
async function refresh(connection: ConnectionService, options: { quiet?: boolean } = {}): Promise<void> {
  const seq = ++refreshSeq
  if (options.quiet !== true) setState({ loading: true })
  const result = await callApi<BoardPayload>(connection, 'board', {})
  if (seq !== refreshSeq) return
  if ('ok' in result) {
    setState({ loading: false, error: `${result.code}: ${result.message}` })
    return
  }
  setState({ loading: false, error: undefined, payload: result, fetchedAt: new Date().toISOString() })
}

function startPolling(connection: ConnectionService): void {
  stopPolling()
  pollTimer = setInterval(() => { void refresh(connection, { quiet: true }) }, POLL_MS)
}

function stopPolling(): void {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

/** The board store: subscribe/getSnapshot for React, commands for the UI. */
export const boardStore = {
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot: (): BoardState => state,

  /** Open the overlay: fetch now, poll while open. */
  openBoard: (connection: ConnectionService): void => {
    setState({ open: true, notice: undefined })
    void refresh(connection)
    startPolling(connection)
  },
  /** Close the overlay and stop polling. */
  closeBoard: (): void => {
    stopPolling()
    setState({ open: false, notice: undefined })
  },
  /** Manual refresh (the「刷新」button). */
  manualRefresh: (connection: ConnectionService): void => { void refresh(connection) },
  /** Prime the footer button's ⚠ dot without opening anything. */
  prime: (connection: ConnectionService): void => { void refresh(connection, { quiet: true }) },
  /** connection/reset: everything cached is suspect; drop it. */
  reset: (): void => {
    stopPolling()
    refreshSeq++
    setState({ payload: undefined, error: undefined, fetchedAt: undefined })
  },

  /** One card action; every outcome triggers a refetch (stale or not). */
  act: async (
    connection: ConnectionService, taskId: string, expectedRevision: number,
    action: string, reason: string | undefined,
  ): Promise<ActResult> => {
    const result = await callApi<ActResult>(connection, 'act', { taskId, expectedRevision, action, reason })
    if (result.ok === false) {
      setState(result.code === 'TASK_STALE_REVISION'
        ? { notice: '任务已被他人变更,看板已刷新', noticeSeq: state.noticeSeq + 1 }
        : { notice: `${result.code}: ${result.message}`, noticeSeq: state.noticeSeq + 1 })
    } else {
      setState({ notice: undefined })
    }
    await refresh(connection)
    return result
  },
  /** Create one task; success triggers a refetch. */
  create: async (
    connection: ConnectionService, objective: string, acceptance: string, projectId: string | undefined,
  ): Promise<CreateResult> => {
    const result = await callApi<CreateResult>(connection, 'create', { objective, acceptance, projectId })
    if (result.ok !== false) await refresh(connection)
    return result
  },
  /** Detail fetch for one card (no cache — opened rarely, freshness wins). */
  show: (connection: ConnectionService, taskId: string): Promise<ShowResult> =>
    callApi<ShowResult>(connection, 'show', { taskId }),
  /** Promote one pending candidate; success triggers a refetch. */
  promote: async (
    connection: ConnectionService, candidateId: string, expectedRevision: number,
    acceptance: string, objective: string | undefined,
  ): Promise<PromoteResult> => {
    const result = await callApi<PromoteResult>(connection, 'promote', { candidateId, expectedRevision, acceptance, objective })
    if (result.ok !== false) await refresh(connection)
    return result
  },
  /** Ignore one pending candidate; success triggers a refetch. */
  ignore: async (
    connection: ConnectionService, candidateId: string, expectedRevision: number,
  ): Promise<IgnoreResult> => {
    const result = await callApi<IgnoreResult>(connection, 'ignore', { candidateId, expectedRevision })
    if (result.ok !== false) await refresh(connection)
    return result
  },
  /** Dismiss the ephemeral notice (the Toast's onDone). */
  clearNotice: (): void => { setState({ notice: undefined }) },
}

/** React binding over the store. */
export function useBoard(): BoardState {
  return useSyncExternalStore(boardStore.subscribe, boardStore.getSnapshot)
}
