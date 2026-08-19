/**
 * Ledger wipe: clear the old import's residue before the new one births
 * candidates — every non-done task is abandoned (archived, not deleted; the
 * event ledger keeps its history), every pending candidate is ignored, and
 * projects left with no tasks at all are archived. All under `{kind:'human'}`
 * so the fold records a person decided this; the extractor's durable marks
 * (task_source.json) are left untouched.
 * @module @task-center/cc-import/wipe
 */

import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { TaskService } from '@task-center/task'
import * as TaskLocal from '@task-center/task-local'

/** What the wipe did, for the report. */
export interface WipeReport {
  readonly tasksAbandoned: number
  readonly tasksKeptDone: number
  readonly tasksAlreadyArchived: number
  readonly candidatesIgnored: number
  readonly candidatesTerminal: number
  readonly projectsArchived: number
  readonly rejected: readonly string[]
}

/**
 * Wipe the ledger under one storage root: abandon non-done tasks, ignore
 * pending candidates, archive empty projects.
 * @param ledgerRoot - the storage root the dsh profiles share (e.g. ~/.dsh/storages).
 * @returns per-verb counts plus every rejected mutation as `id: code`.
 */
export async function wipeLedger(ledgerRoot: string): Promise<WipeReport> {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root: ledgerRoot }),
    await ctx.plugin(StorageDomain, { backend: 'json', routes: {} }),
    await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 }),
    await ctx.plugin(TaskLocal),
  ]
  try {
    const actor = { kind: 'human' } as const
    const rejected: string[] = []
    const tasks = ctx.tasks.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })
    let tasksAbandoned = 0
    let tasksKeptDone = 0
    let tasksAlreadyArchived = 0
    for (const view of tasks) {
      if (view.record.status === 'done') {
        tasksKeptDone++
        continue
      }
      if (view.archived) {
        tasksAlreadyArchived++
        continue
      }
      const settled = await ctx.tasks.mutate(view.record.id, view.record.revision, { operation: 'abandon' }, actor)
      if ('code' in settled) rejected.push(`${view.record.id}: ${settled.code}`)
      else tasksAbandoned++
    }

    let candidatesIgnored = 0
    let candidatesTerminal = 0
    for (const view of ctx.tasks.candidates()) {
      if (view.record.status !== 'pending') {
        candidatesTerminal++
        continue
      }
      const settled = await ctx.tasks.candidateIgnore(view.record.id, view.record.revision, actor)
      if ('code' in settled) rejected.push(`${view.record.id}: ${settled.code}`)
      else candidatesIgnored++
    }

    const usedProjects = new Set(tasks
      .map(view => view.record.projectId)
      .filter((id): id is NonNullable<typeof id> => id !== undefined))
    let projectsArchived = 0
    for (const view of ctx.tasks.projects()) {
      if (view.record.archived || usedProjects.has(view.record.id)) continue
      const settled = await ctx.tasks.projectMutate(view.record.id, view.record.revision, { operation: 'project-archive' }, actor)
      if ('code' in settled) rejected.push(`${view.record.name}: ${settled.code}`)
      else projectsArchived++
    }

    return {
      tasksAbandoned, tasksKeptDone, tasksAlreadyArchived,
      candidatesIgnored, candidatesTerminal,
      projectsArchived, rejected,
    }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}
