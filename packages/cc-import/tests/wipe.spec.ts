/**
 * Wipe units over a real ledger: seeded with tasks in every status, pending
 * and terminal candidates, and one empty project — the wipe abandons all
 * non-done tasks under a human actor, ignores only pending candidates,
 * archives only the project with no tasks, and a second wipe is a no-op.
 * @module @task-center/cc-import/tests/wipe
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { TaskService } from '@task-center/task'
import type { CandidateOrigin } from '@task-center/task'
import * as TaskLocal from '@task-center/task-local'
import { wipeLedger } from '../src/wipe.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** Boot the ledger stack over one storage root, mirroring the dsh profiles. */
async function bootLedger(root: string) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root }),
    await ctx.plugin(StorageDomain, { backend: 'json', routes: {} }),
    await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 }),
    await ctx.plugin(TaskLocal),
  ]
  return { ctx, fibers }
}

/** Seed one ledger: a todo task, a review task, a done task, a loose task,
 * two pending candidates plus one already ignored, and an empty project. */
async function seedLedger(root: string): Promise<void> {
  const { ctx, fibers } = await bootLedger(root)
  try {
    const human = { kind: 'human' } as const
    const project = await ctx.tasks.projectCreate('旧导入', human)
    if ('code' in project) throw new Error(`project create failed: ${project.code}`)
    const empty = await ctx.tasks.projectCreate('空项目', human)
    if ('code' in empty) throw new Error(`project create failed: ${empty.code}`)
    const projectId = project.project.record.id

    const todo = await ctx.tasks.create({ objective: '待办任务', acceptance: 'x', projectId }, human)
    if ('code' in todo) throw new Error(`create failed: ${todo.code}`)
    const review = await ctx.tasks.create({ objective: '待审任务', acceptance: 'x', projectId }, human)
    if ('code' in review) throw new Error(`create failed: ${review.code}`)
    const claimed = await ctx.tasks.mutate(review.task.record.id, review.task.record.revision, { operation: 'claim' }, human)
    if ('code' in claimed) throw new Error(`claim failed: ${claimed.code}`)
    const submitted = await ctx.tasks.mutate(claimed.record.id, claimed.record.revision, { operation: 'submit', completionNote: '做完了' }, human)
    if ('code' in submitted) throw new Error(`submit failed: ${submitted.code}`)
    const done = await ctx.tasks.create({ objective: '已完成任务', acceptance: 'x', projectId }, human)
    if ('code' in done) throw new Error(`create failed: ${done.code}`)
    const doneClaimed = await ctx.tasks.mutate(done.task.record.id, done.task.record.revision, { operation: 'claim' }, human)
    if ('code' in doneClaimed) throw new Error(`claim failed: ${doneClaimed.code}`)
    const doneSubmitted = await ctx.tasks.mutate(doneClaimed.record.id, doneClaimed.record.revision, { operation: 'submit', completionNote: '做完了' }, human)
    if ('code' in doneSubmitted) throw new Error(`submit failed: ${doneSubmitted.code}`)
    const doneApproved = await ctx.tasks.mutate(doneSubmitted.record.id, doneSubmitted.record.revision, { operation: 'approve' }, human)
    if ('code' in doneApproved) throw new Error(`approve failed: ${doneApproved.code}`)
    const loose = await ctx.tasks.create({ objective: '无项目任务', acceptance: 'x' }, human)
    if ('code' in loose) throw new Error(`create failed: ${loose.code}`)

    const source = { kind: 'source' } as const
    // Branded straight to the target type: @task-center/task resolves its own
    // dsh-session copy, so constructing the brand here would cross identities.
    const origin = { sessionId: 'seed' as CandidateOrigin['sessionId'], tier: 'summary' as const, key: 'seed-1' }
    const candidate = await ctx.tasks.candidateCreate({ objective: '待定候选', origin }, source)
    if ('code' in candidate) throw new Error(`candidate create failed: ${candidate.code}`)
    const candidate2 = await ctx.tasks.candidateCreate({ objective: '另一个待定候选', origin: { sessionId: 'seed' as CandidateOrigin['sessionId'], tier: 'summary', key: 'seed-2' } }, source)
    if ('code' in candidate2) throw new Error(`candidate create failed: ${candidate2.code}`)
    const settled = await ctx.tasks.candidateIgnore(candidate.record.id, candidate.record.revision, human)
    if ('code' in settled) throw new Error(`candidate ignore failed: ${settled.code}`)
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}

describe('wipeLedger', () => {
  it('abandons non-done work, ignores pending candidates, archives empty projects — once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-import-wipe-'))
    roots.push(root)
    await seedLedger(root)

    const first = await wipeLedger(root)
    expect(first).toEqual({
      tasksAbandoned: 3,
      tasksKeptDone: 1,
      tasksAlreadyArchived: 0,
      candidatesIgnored: 1,
      candidatesTerminal: 1,
      projectsArchived: 1,
      rejected: [],
    })

    const { ctx, fibers } = await bootLedger(root)
    try {
      const live = ctx.tasks.list({})
      expect(live.map(view => view.record.status)).toEqual(['done'])
      expect(live.every(view => view.archived)).toBe(false)
      const pending = ctx.tasks.candidates().filter(view => view.record.status === 'pending')
      expect(pending).toEqual([])
      const archivedProjects = ctx.tasks.projects().filter(view => view.record.archived)
      expect(archivedProjects.map(view => view.record.name)).toEqual(['空项目'])
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }

    const second = await wipeLedger(root)
    expect(second).toEqual({
      tasksAbandoned: 0,
      tasksKeptDone: 1,
      tasksAlreadyArchived: 3,
      candidatesIgnored: 0,
      candidatesTerminal: 2,
      projectsArchived: 0,
      rejected: [],
    })
  })
})
