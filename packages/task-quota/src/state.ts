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
import type { ResumeTarget } from './signal.ts'

/** Storage key of the resume override inside the `flags` table. */
const RESUME_KEY = 'resume-on-reset'
/** Storage key of the resume-target override inside the `flags` table. */
const TARGET_KEY = 'resume-target'

/** One resume target as its stored string form. */
function encodeTarget(target: ResumeTarget): string {
  return target.kind === 'session' ? `session:${target.sessionId}` : target.kind
}

/** Parse a stored target string; undefined for anything malformed (treated as the fresh default). */
function decodeTarget(raw: string | undefined): ResumeTarget | undefined {
  if (raw === 'fresh' || raw === 'origin') return { kind: raw }
  if (raw !== undefined && raw.startsWith('session:') && raw.length > 'session:'.length) {
    return { kind: 'session', sessionId: raw.slice('session:'.length) }
  }
  return undefined
}

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

/** Read-and-write access to the resume override and the resume target. */
export interface ResumeStore {
  /** The stored override; undefined while the toggle has never been flipped. */
  override(): boolean | undefined
  /**
   * Record the override durably.
   * @param value - the toggle's chosen state.
   * @returns resolution after the durable write.
   */
  set(value: boolean): Promise<void>
  /** The stored target; undefined while it was never chosen (fresh default). */
  target(): ResumeTarget | undefined
  /**
   * Record the target durably.
   * @param target - the chosen continuation target.
   * @returns resolution after the durable write.
   */
  setTarget(target: ResumeTarget): Promise<void>
}

/** Overrides with no medium: correct within one process, blank at the next boot. */
export function memoryResume(): ResumeStore {
  let stored: boolean | undefined
  let storedTarget: ResumeTarget | undefined
  return {
    override: () => stored,
    async set(value) {
      stored = value
    },
    target: () => storedTarget,
    async setTarget(target) {
      storedTarget = target
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
      target: () => decodeTarget(table.get(TARGET_KEY)),
      setTarget: target => table.put(TARGET_KEY, encodeTarget(target)),
    },
    close: () => domain.close(),
  }
}
