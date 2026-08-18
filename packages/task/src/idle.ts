/**
 * Idle-time vocabulary shared by every human surface (panel, board): whole
 * days since a task was last *worked*, the subtree-aware effective idle under
 * live delegation, and the display-side join with the holder session's live
 * activity. Pure functions over view readers — no context.
 * @module @task-center/task/idle
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskId, TaskRecord, TaskView } from './types.ts'

/** The minimum record-reading face {@link effectiveIdle} needs. */
export interface TaskReader {
  /** Read one task view by id; absent ids are skipped. */
  get(id: TaskId): TaskView | undefined
}

/**
 * Live holder-session activity: epoch ms of a live session's last durable
 * event, or undefined when the session is not live in this process. A holder
 * session at work is activity the ledger has not heard about yet.
 */
export type HolderActivity = (sessionId: SessionId) => number | undefined

/**
 * Epoch ms of one session log's last activity. The `session/end-seed` marker
 * is store bookkeeping stamped at attach time, not session activity — a
 * restored session must not look freshly active just because it was mounted.
 * @param events - the session log in order.
 * @returns the last non-marker event's epoch ms, or undefined for a log with no activity.
 */
export function lastSessionActivity(events: readonly { readonly type: string; readonly time: number }[]): number | undefined {
  let last: number | undefined
  for (const event of events) {
    if (event.type === 'session/end-seed') continue
    last = event.time
  }
  return last
}

/**
 * Whole days one task has sat since it was last *worked* (`workedAt` — patrol
 * and wake bookkeeping do not refresh it), floored: sub-day idleness and clock
 * skew both read 0.
 * @param at - the record's last-worked instant.
 * @param now - the render time.
 * @returns whole idle days.
 */
export function idleDays(at: string, now: Date): number {
  return idleDaysAtMs(Date.parse(at), now)
}

/** {@link idleDays} over an epoch-ms instant. */
function idleDaysAtMs(atMs: number, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - atMs) / 86_400_000))
}

/**
 * Effective idle of one view: its own last touch, or fresher when any
 * descendant moved — a parent under live delegation is not shelved. All
 * descendants count, whatever their status: a finishing child is activity.
 * With a holder-activity reader, every record's own touch also takes the live
 * holder session's last event — a holder working right now keeps the line
 * alive on display, with zero ledger writes (design 06 §7 第一层). A session
 * not live in this process reads undefined and falls back to `workedAt`.
 * @param reader - record reader (the task service itself satisfies this).
 * @param view - the task whose idle is asked for.
 * @param now - the render time.
 * @param holderActivity - live holder-session activity reader, optional.
 * @returns whole effective idle days.
 */
export function effectiveIdle(reader: TaskReader, view: TaskView, now: Date, holderActivity?: HolderActivity): number {
  const touch = (record: TaskRecord): number => {
    let ms = Date.parse(record.workedAt)
    const live = record.holder === undefined || holderActivity === undefined ? undefined : holderActivity(record.holder)
    return live !== undefined && live > ms ? live : ms
  }
  let best = idleDaysAtMs(touch(view.record), now)
  const queue = [...view.record.subtasks]
  const seen = new Set<TaskId>([view.record.id])
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const child = reader.get(id)
    if (child === undefined) continue
    best = Math.min(best, idleDaysAtMs(touch(child.record), now))
    queue.push(...child.record.subtasks)
  }
  return best
}
