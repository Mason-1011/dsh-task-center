/**
 * The merged browser half: one client registration carrying both web surfaces
 * — the kanban (board button + overlay) and the scheduler (⏰ modal + dock
 * chips). A single package exposes one `./client` bundle, so the two halves
 * ship as one module; each still owns its slots and stores.
 * @module dsh-task-center/client
 */

import * as board from '../../task-web/src/client/index.tsx'
import * as sched from '../../task-sched/src/client/index.tsx'

/** The client-side services both halves consume (union, deduplicated). */
export const inject = [...new Set([...board.inject, ...sched.inject])]

/** Register every web surface: board first, then the session-page scheduler. */
export function apply(ctx: Parameters<typeof board.apply>[0]): void {
  board.apply(ctx)
  sched.apply(ctx as Parameters<typeof sched.apply>[0])
}
