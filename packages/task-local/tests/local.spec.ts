/**
 * REAL-composition tests over published dsh plugins: the storage hub, the json
 * backend, the domain facility, the task seam, and `task-local` mounted as
 * real Cordis plugins. Durability is asserted by restarting over the same
 * medium on disk.
 * @module @task-center/task-local/tests/local
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TaskService } from '@task-center/task'
import type { TaskActor } from '@task-center/task'
import * as TaskLocal from '../src/index.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** Boot the full stack over a json medium at `root`; returns fibers for teardown. */
async function boot(root: string): Promise<{ ctx: Context; fibers: { dispose(): Promise<void> }[] }> {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root }),
    await ctx.plugin(StorageDomain, { backend: 'json', routes: {} }),
    await ctx.plugin(TaskService, { contextPackByteLimit: 1000, listDefaultLimit: 20 }),
    await ctx.plugin(TaskLocal),
  ]
  return { ctx, fibers }
}

/** Tear a booted stack down in reverse mount order (domain and files release). */
async function shutdown(fibers: { dispose(): Promise<void> }[]): Promise<void> {
  for (const fiber of fibers.reverse()) await fiber.dispose()
}

const human: TaskActor = { kind: 'human' }
const sessionId = SessionId('s-1')
const model: TaskActor = { kind: 'model', sessionId }

describe('task-local durability', () => {
  it('persists the ledger across a full restart over the same medium', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-local-'))
    roots.push(root)

    const first = await boot(root)
    const created = await first.ctx.tasks.create({ objective: 'survive restart', acceptance: 'ledger restores' }, human)
    if ('code' in created) throw new Error(created.code)
    const taskId = created.task.record.id
    const session = Session.create(sessionId)
    const claimed = await first.ctx.tasks.claim(taskId, session, model)
    if ('code' in claimed) throw new Error(claimed.code)
    expect(claimed.record.holder).toBe(sessionId as never)
    const progressed = await first.ctx.tasks.mutate(taskId, claimed.record.revision, { operation: 'progress', note: 'wrote through json' }, model, session)
    if ('code' in progressed) throw new Error(progressed.code)
    await shutdown(first.fibers)

    expect((await readdir(root)).some(file => file.endsWith('.json'))).toBe(true)

    const second = await boot(root)
    const restored = second.ctx.tasks.get(taskId)
    if (restored === undefined) throw new Error('task did not survive the restart')
    expect(restored.record.objective).toBe('survive restart')
    expect(restored.record.status).toBe('active')
    expect(restored.record.holder).toBe(sessionId as never)
    expect(restored.record.contextPack).toContain('wrote through json')
    expect(restored.record.revision).toBe(progressed.record.revision)

    // The restarted stream continues: CAS against the restored revision.
    const submitted = await second.ctx.tasks.mutate(taskId, restored.record.revision, { operation: 'submit', completionNote: 'resumed' }, model, session)
    expect('code' in submitted).toBe(false)

    // A system release (the reaper's verb) persists and restores across restart.
    const secondTask = await second.ctx.tasks.create({ objective: 'dead hold', acceptance: 'system release survives' }, human)
    if ('code' in secondTask) throw new Error(secondTask.code)
    const secondClaimed = await second.ctx.tasks.claim(secondTask.task.record.id, session, model)
    if ('code' in secondClaimed) throw new Error(secondClaimed.code)
    const released = await second.ctx.tasks.mutate(secondTask.task.record.id, secondClaimed.record.revision, { operation: 'release' }, { kind: 'system' })
    if ('code' in released) throw new Error(released.code)

    // A subtask link also round-trips the durable zod envelope.
    const thirdTask = await second.ctx.tasks.create({ objective: 'child', acceptance: 'link survives' }, human)
    if ('code' in thirdTask) throw new Error(thirdTask.code)
    const linked = await second.ctx.tasks.mutate(secondTask.task.record.id, released.record.revision, { operation: 'subtask-add', childId: thirdTask.task.record.id }, human)
    if ('code' in linked) throw new Error(linked.code)
    await shutdown(second.fibers)

    const third = await boot(root)
    const restoredRelease = third.ctx.tasks.get(secondTask.task.record.id)
    if (restoredRelease === undefined) throw new Error('the system release did not survive the restart')
    expect(restoredRelease.record.status).toBe('todo')
    expect(restoredRelease.record.holder).toBeUndefined()
    expect(restoredRelease.record.revision).toBe(linked.record.revision)
    expect(restoredRelease.record.subtasks).toEqual([thirdTask.task.record.id])
    expect(third.ctx.tasks.children(secondTask.task.record.id).map(c => c.record.id)).toEqual([thirdTask.task.record.id])
    await shutdown(third.fibers)
  })

  it('rejects a medium stamped with a different domain version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-local-'))
    roots.push(root)
    const first = await boot(root)
    await first.ctx.tasks.create({ objective: 'v1 marker', acceptance: 'x' }, human)
    await shutdown(first.fibers)

    // Corrupt the on-disk version stamp: pre-release formats reject old media.
    const files = await readdir(root)
    const file = files.find(name => name.endsWith('.json'))!
    const { readFile, writeFile } = await import('node:fs/promises')
    const path = join(root, file)
    const medium = JSON.parse(await readFile(path, 'utf8')) as { unit: { version: number } }
    medium.unit.version = 99
    await writeFile(path, `${JSON.stringify(medium)}\n`)

    const second = await boot(root).catch(error => error as Error)
    if (second instanceof Error) return
    await shutdown(second.fibers)
    throw new Error('a foreign domain version opened without failing')
  })
})
