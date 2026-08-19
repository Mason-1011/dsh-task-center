/**
 * Storage-shape tests for the sends table: soonest-first ordering in both
 * the memory fallback and the durable domain, and durability across a full
 * close/reopen over the same json medium.
 * @module @task-center/task-sched/tests/sends
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { memorySends, openSends } from '../src/sends.ts'
import type { SchedSend } from '../src/wire.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** One pending row at the given due offset, named by id. */
function row(id: string, atMs: number): SchedSend {
  return {
    id, sessionId: 's-1', content: 'cont',
    scheduledAt: new Date(atMs).toISOString(),
    status: 'pending', createdAt: new Date(0).toISOString(),
  }
}

describe('sends table', () => {
  it('orders soonest first with a stable id tie-break, in memory and on disk', async () => {
    const memory = memorySends()
    await memory.put(row('b', 3_000))
    await memory.put(row('a', 1_000))
    await memory.put(row('c', 1_000))
    expect(memory.list().map(entry => entry.id)).toEqual(['a', 'c', 'b'])
    expect(memory.get('a')?.content).toBe('cont')
    expect(await memory.delete('a')).toBe(true)
    expect(await memory.delete('a')).toBe(false)
    expect(memory.list().map(entry => entry.id)).toEqual(['c', 'b'])

    const ctx = new Context()
    const root = await mkdtemp(join(tmpdir(), 'task-sched-'))
    roots.push(root)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json', routes: {} })
    const opened = await openSends(ctx.storageDomain!)
    await opened.sends.put(row('b', 3_000))
    await opened.sends.put(row('a', 1_000))
    await opened.sends.put(row('c', 1_000))
    expect(opened.sends.list().map(entry => entry.id)).toEqual(['a', 'c', 'b'])
    await opened.close()

    // Durability: a reopen over the same medium restores the rows and the order.
    const reopened = await openSends(ctx.storageDomain!)
    expect(reopened.sends.list().map(entry => entry.id)).toEqual(['a', 'c', 'b'])
    await reopened.close()
    await ctx.fiber.dispose()
  })
})
