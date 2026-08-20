/**
 * Durable resume-knob state: this plugin's own storage domain, one `flags`
 * table holding the runtime override of the `resumeOnReset` config default.
 * The override is operator bookkeeping — the board toggle's last choice — so
 * it lives beside (never inside) the task ledger, the same split the
 * extraction marks and the scheduled sends use. With no storage-domain
 * facility mounted the memory fallback keeps one process's knob working and
 * everything durable blank, so minimal assemblies still run.
 * @module @task-center/task-quota/src/state
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

/** Storage key of the resume override inside the `flags` table. */
const RESUME_KEY = 'resume-on-reset'

/**
 * The quota domain: one `flags` table mapping stable key to stored value. The
 * domain name spells the plugin name with an underscore (domain names are
 * `[a-z][a-z0-9_]*`).
 */
export const quotaDomainSpec = defineDomain({
  name: 'task_quota',
  version: 1,
  tables: {
    flags: domainTable<string, string>(z.string()),
  },
})

/** Read-and-write access to the resume override. */
export interface ResumeStore {
  /** The stored override; undefined while the toggle has never been flipped. */
  override(): boolean | undefined
  /**
   * Record the override durably.
   * @param value - the toggle's chosen state.
   * @returns resolution after the durable write.
   */
  set(value: boolean): Promise<void>
}

/** Override with no medium: correct within one process, blank at the next boot. */
export function memoryResume(): ResumeStore {
  let stored: boolean | undefined
  return {
    override: () => stored,
    async set(value) {
      stored = value
    },
  }
}

/**
 * Open the durable resume store over the storage-domain facility.
 * @param facility - the mounted domain facility (`ctx.storageDomain`).
 * @returns the store plus the domain handle whose `close()` the caller owes.
 */
export async function openResume(
  facility: NonNullable<Context['storageDomain']>,
): Promise<{ resume: ResumeStore; close: () => Promise<void> }> {
  const domain: Domain<typeof quotaDomainSpec> = await facility.open(quotaDomainSpec)
  const table = domain.table('flags')
  return {
    resume: {
      override: () => {
        const stored = table.get(RESUME_KEY)
        return stored === undefined ? undefined : stored === 'true'
      },
      set: value => table.put(RESUME_KEY, value ? 'true' : 'false'),
    },
    close: () => domain.close(),
  }
}
