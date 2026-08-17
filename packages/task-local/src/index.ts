/**
 * `task-local` provider: opens the task domain on the configured storage
 * backend and swaps the task seam's ledger from the in-memory default to the
 * durable {@link DomainTaskStore}. Backend routing is the storage-domain
 * plugin's config, not this plugin's.
 * @module @task-center/task-local
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { DomainTaskStore } from './store.ts'
import { taskDomainSpec } from './spec.ts'

export { taskDomainSpec, storedLedgerEvent } from './spec.ts'
export { DomainTaskStore } from './store.ts'

/** Cordis plugin name. */
export const name = 'task-local'

/** The task seam and the domain facility must both be present. */
export const inject = ['tasks', 'storageDomain']

/**
 * Mount the durable ledger. Runs as a Cordis function plugin: open the domain,
 * hand its store to `ctx.tasks.use`, and restore the previous store on dispose.
 * @param ctx - Plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(taskDomainSpec)
  const restore = ctx.tasks.use(new DomainTaskStore(domain))
  ctx.effect(() => () => {
    restore()
    return domain.close()
  })
}
