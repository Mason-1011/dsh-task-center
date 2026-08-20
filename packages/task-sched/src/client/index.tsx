/**
 * Browser half of the scheduler (the bundle entry the dsh web client loads).
 * Two slot registrations over the client runtime — the session header action
 * (the ⏰ button that opens the scheduling modal) and the input dock row
 * (pending-send chips above the composer). Both live in the conversation's
 * own declared slots, so they exist exactly while a session page is mounted.
 * @module dsh-task-center-task-sched/client
 */

import type { ClientContext } from './context.ts'
import { SchedHeaderAction } from './SchedAction.tsx'
import { SchedDock } from './SchedDock.tsx'
import { schedStore } from './store.ts'
import { ensureStyles } from './styles.ts'

/** The client-side services this bundle consumes. */
export const inject = ['slots', 'connection']

/** Register both scheduling surfaces on the session page. */
export function apply(ctx: ClientContext): void {
  // The surfaces need their styles from the first paint, not first click.
  ensureStyles()
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'task-sched',
    order: 100,
    label: '定时发送',
    inject: () => ({ connection: ctx.connection }),
  }, SchedHeaderAction))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'task-sched',
    order: 100,
    label: '定时发送',
    inject: () => ({ connection: ctx.connection }),
  }, SchedDock))
  // A reconnect invalidates everything cached; the next mount refetches.
  ctx.on('connection/reset', () => schedStore.reset())
}
