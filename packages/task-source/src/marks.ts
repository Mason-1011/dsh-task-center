/**
 * Durable extraction watermarks: per session, the seq through which extraction
 * has already spoken. Kept in this plugin's own storage domain so a restart —
 * or a fresh install sweeping the whole stored history — never re-reads or
 * re-pays for covered ground. The task ledger is untouched: a mark is
 * extractor bookkeeping, not domain state, the same way dsh's projection
 * cache keeps its checkpoint outside the session stream.
 * @module @task-center/task-source/src/marks
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * The extraction domain: one `covered` table mapping session id to the seq
 * extraction has covered (absence means never extracted), and one `flags`
 * table for one-time extractor migrations — a flag's presence means the
 * migration already ran and must never re-read its ground. The domain name
 * spells the plugin name with an underscore (domain names are `[a-z][a-z0-9_]*`).
 */
export const extractionDomainSpec = defineDomain({
  name: 'task_source',
  version: 1,
  tables: {
    covered: domainTable<string, number>(z.number().int().nonnegative()),
    flags: domainTable<string, string>(z.string()),
  },
})

/**
 * Read-and-advance access to the per-session covered seqs. `advance` never
 * moves backwards and never persists a negative seq; it resolves after the
 * durable write, so callers may fire-and-forget it without losing the
 * in-memory watermark.
 */
export interface Marks {
  /** The seq extraction has covered for one session; -1 when never. */
  covered(sessionId: SessionId): number
  /**
   * Record extraction coverage durably.
   * @param sessionId - the session whose log extraction read.
   * @param seq - the last seq the extraction covered.
   * @returns resolution after the durable write (a no-op for non-advancing values).
   */
  advance(sessionId: SessionId, seq: number): Promise<void>
  /** One migration flag's stored value, or undefined while it never ran. */
  flag(key: string): string | undefined
  /**
   * Record one migration flag durably.
   * @param key - the migration's stable key.
   * @param value - the value to stamp (the run instant, for the log).
   * @returns resolution after the durable write.
   */
  setFlag(key: string, value: string): Promise<void>
}

/** Marks with no medium: correct within one process, blank at the next boot. */
export function memoryMarks(): Marks {
  const coveredMap = new Map<SessionId, number>()
  const flagMap = new Map<string, string>()
  return {
    covered: sessionId => coveredMap.get(sessionId) ?? -1,
    async advance(sessionId, seq) {
      if (seq < 0 || seq <= (coveredMap.get(sessionId) ?? -1)) return
      coveredMap.set(sessionId, seq)
    },
    flag: key => flagMap.get(key),
    async setFlag(key, value) {
      flagMap.set(key, value)
    },
  }
}

/**
 * Open the durable marks over the storage-domain facility.
 * @param facility - the mounted domain facility (`ctx.storageDomain`).
 * @returns the marks plus the domain handle whose `close()` the caller owes.
 */
export async function openMarks(
  facility: NonNullable<Context['storageDomain']>,
): Promise<{ marks: Marks; close: () => Promise<void> }> {
  const domain: Domain<typeof extractionDomainSpec> = await facility.open(extractionDomainSpec)
  const table = domain.table('covered')
  const coveredMap = new Map<SessionId, number>()
  for (const [sessionId, seq] of table.entries()) coveredMap.set(SessionId(sessionId), seq)
  const flags = domain.table('flags')
  const flagMap = new Map<string, string>()
  for (const [key, value] of flags.entries()) flagMap.set(key, value)
  return {
    marks: {
      covered: sessionId => coveredMap.get(sessionId) ?? -1,
      async advance(sessionId, seq) {
        if (seq < 0 || seq <= (coveredMap.get(sessionId) ?? -1)) return
        await table.put(sessionId, seq)
        coveredMap.set(sessionId, seq)
      },
      flag: key => flagMap.get(key),
      async setFlag(key, value) {
        await flags.put(key, value)
        flagMap.set(key, value)
      },
    },
    // Durability first, memory second — a rejected write leaves the in-memory
    // mark untouched, so the next boot re-extracts rather than silently
    // skipping uncovered ground.
    close: () => domain.close(),
  }
}
