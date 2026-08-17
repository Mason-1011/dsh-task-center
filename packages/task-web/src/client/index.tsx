/**
 * Browser half of the web kanban (the bundle entry the dsh web client loads).
 * Two slot registrations over the client runtime — the sidebar footer entry
 * button and the full-screen board overlay — plus a quiet priming fetch so the
 * button's ⚠ dot reflects real staleness before the board is ever opened.
 * @module @task-center/task-web/client
 */

import { BoardButton, BoardOverlay } from './Board.tsx'
import type { ClientContext } from './context.ts'
import { boardStore } from './store.ts'
import { ensureStyles } from './styles.ts'

/** The client-side services this bundle consumes. */
export const inject = ['slots', 'connection']

/** Register both board surfaces and prime the footer button's staleness dot. */
export function apply(ctx: ClientContext): void {
  // The entry button needs its styles from the first paint, not first click.
  ensureStyles()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'task-web-board',
    order: 100,
    label: '任务看板',
    inject: () => ({ connection: ctx.connection }),
  }, BoardButton))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'task-web-board',
    order: 100,
    inject: () => ({ connection: ctx.connection }),
  }, BoardOverlay))
  void boardStore.prime(ctx.connection)
  // A reconnect invalidates everything cached; the next open refetches.
  ctx.on('connection/reset', () => boardStore.reset())
}
