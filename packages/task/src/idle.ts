/**
 * Idle-time vocabulary shared by every human surface (panel, board): whole
 * days since a task was last *worked*, and the subtree-aware effective idle
 * under live delegation. Pure functions over a view reader — no context.
 * @module @task-center/task/idle
 */

import type { TaskId, TaskView } from './types.ts'

/** The minimum record-reading face {@link effectiveIdle} needs. */
export interface TaskReader {
  /** Read one task view by id; absent ids are skipped. */
  get(id: TaskId): TaskView | undefined
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
  return Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 86_400_000))
}

/**
 * Effective idle of one view: its own last touch, or fresher when any
 * descendant moved — a parent under live delegation is not shelved. All
 * descendants count, whatever their status: a finishing child is activity.
 * @param reader - record reader (the task service itself satisfies this).
 * @param view - the task whose idle is asked for.
 * @param now - the render time.
 * @returns whole effective idle days.
 */
export function effectiveIdle(reader: TaskReader, view: TaskView, now: Date): number {
  let best = idleDays(view.record.workedAt, now)
  const queue = [...view.record.subtasks]
  const seen = new Set<TaskId>([view.record.id])
  while (queue.length > 0) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const child = reader.get(id)
    if (child === undefined) continue
    best = Math.min(best, idleDays(child.record.workedAt, now))
    queue.push(...child.record.subtasks)
  }
  return best
}
