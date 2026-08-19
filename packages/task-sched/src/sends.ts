/**
 * Durable scheduled sends: this plugin's own storage domain, one `sends`
 * table keyed by send id. A send is scheduling bookkeeping, not task domain
 * state, so it lives beside (never inside) the task ledger — the same split
 * the extraction marks use. With no storage-domain facility mounted the
 * memory fallback keeps one process's sends working and everything durable
 * blank, so minimal assemblies still run.
 * @module @task-center/task-sched/src/sends
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SchedSend } from './wire.ts'

/**
 * The scheduling domain: one `sends` table mapping send id to its row. The
 * domain name spells the plugin name with an underscore (domain names are
 * `[a-z][a-z0-9_]*`).
 */
export const schedDomainSpec = defineDomain({
  name: 'task_sched',
  version: 1,
  tables: {
    sends: domainTable<string, SchedSend>(z.object({
      id: z.string(),
      sessionId: z.string(),
      content: z.string(),
      scheduledAt: z.string(),
      status: z.enum(['pending', 'firing', 'fired', 'failed']),
      createdAt: z.string(),
      settledAt: z.string().optional(),
      note: z.string().optional(),
    })),
  },
})

/** Soonest-first ordering: by due instant, then id for a stable tie-break. */
function byDue(left: SchedSend, right: SchedSend): number {
  return left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id)
}

/** Read-and-write access to the scheduled sends. */
export interface Sends {
  /** Every row, soonest `scheduledAt` first. */
  list(): readonly SchedSend[]
  /** One row by id, or undefined when absent. */
  get(id: string): SchedSend | undefined
  /** Insert or overwrite one row; the durable write resolves first. */
  put(row: SchedSend): Promise<void>
  /** Delete one row; true when it existed. */
  delete(id: string): Promise<boolean>
}

/** Sends with no medium: correct within one process, blank at the next boot. */
export function memorySends(): Sends {
  const rows = new Map<string, SchedSend>()
  return {
    list: () => [...rows.values()].sort(byDue),
    get: id => rows.get(id),
    async put(row) {
      rows.set(row.id, row)
    },
    delete: async id => rows.delete(id),
  }
}

/**
 * Open the durable sends over the storage-domain facility.
 * @param facility - the mounted domain facility (`ctx.storageDomain`).
 * @returns the sends plus the domain handle whose `close()` the caller owes.
 */
export async function openSends(
  facility: NonNullable<Context['storageDomain']>,
): Promise<{ sends: Sends; close: () => Promise<void> }> {
  const domain: Domain<typeof schedDomainSpec> = await facility.open(schedDomainSpec)
  const table = domain.table('sends')
  return {
    sends: {
      list: () => [...table.entries()].map(([, row]) => row).sort(byDue),
      get: id => table.get(id),
      put: row => table.put(row.id, row),
      delete: id => table.delete(id),
    },
    close: () => domain.close(),
  }
}
