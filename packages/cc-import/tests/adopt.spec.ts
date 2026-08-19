/**
 * Workspace adoption units over a real registry: the one-time cwd bootstrap is
 * pre-initialized over an empty root (production's state), then materialized
 * sessions — one resolvable cwd, one dead cwd, one without a cwd — are adopted
 * into per-cwd workspaces, the dead-cwd session is rewritten into the fallback
 * directory keeping its id and log, the no-cwd one is skipped with a reason,
 * and a second run attaches nothing.
 * @module @task-center/cc-import/tests/adopt
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceRegistry, realpathNormalize } from '@deepseek-ai/dsh-workspace'
import { parseCcSession } from '../src/parse.ts'
import { mapCcSession } from '../src/map.ts'
import { materializeSessions } from '../src/materialize.ts'
import { adoptWorkspaces } from '../src/adopt.ts'
import type { MaterializeInput } from '../src/materialize.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** Boot the workspace stack over one pair of roots, mirroring the dsh web
 * profile: sessions + their persistence, then the storage trio and registry. */
async function bootRegistry(sessionsRoot: string, storageRoot: string) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SessionStore),
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'zstd' }),
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root: storageRoot }),
    await ctx.plugin(StorageDomain, { backend: 'json', routes: {} }),
    await ctx.plugin(WorkspaceRegistry),
  ]
  return { ctx, fibers }
}

/** The chat fixture's log under a chosen id — the smallest real materialize input. */
async function chatEvents(): Promise<MaterializeInput['events']> {
  const session = await parseCcSession(resolve(import.meta.dirname, 'fixtures', 'chat-session.jsonl'))
  return mapCcSession(session).events
}

describe('adoptWorkspaces', () => {
  it('groups cc- sessions into per-cwd workspaces, remaps dead cwds, skips no-cwd — once', async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'cc-adopt-sessions-'))
    const storageRoot = await mkdtemp(join(tmpdir(), 'cc-adopt-storage-'))
    const fallbackDir = await mkdtemp(join(tmpdir(), 'cc-adopt-fallback-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'cc-adopt-project-'))
    const deadCwd = join(tmpdir(), `cc-adopt-dead-${process.pid}`)
    roots.push(sessionsRoot, storageRoot, fallbackDir, projectDir)

    // Production premise: the registry's one-time bootstrap already ran, so no
    // workspace will ever appear unless adoption (or the UI) creates it.
    {
      const { fibers } = await bootRegistry(sessionsRoot, storageRoot)
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
    const state = JSON.parse(await readFile(join(storageRoot, 'workspace.json'), 'utf8'))
    expect(state.global.initialized).toBe(true)
    expect(state.global.workspaceIds).toEqual([])

    const plan = await parseCcSession(resolve(import.meta.dirname, 'fixtures', 'plan-session.jsonl'))
    const inputs: MaterializeInput[] = [
      { id: 'cc-11111111-aaaa-4bbb-8ccc-000000000001', cwd: projectDir, createdAt: plan.createdAt, events: mapCcSession(plan).events },
      { id: 'cc-22222222-aaaa-4bbb-8ccc-000000000002', cwd: deadCwd, createdAt: plan.createdAt, events: await chatEvents() },
      { id: 'cc-33333333-aaaa-4bbb-8ccc-000000000003', cwd: undefined, createdAt: plan.createdAt, events: await chatEvents() },
    ]
    await materializeSessions(inputs, { root: sessionsRoot, compression: 'zstd' })

    const first = await adoptWorkspaces({ sessionsRoot, storageRoot, fallbackDir, compression: 'zstd' })
    const canonicalProject = await realpathNormalize(projectDir)
    const canonicalFallback = await realpathNormalize(fallbackDir)
    expect(first.remapped).toEqual([
      { id: 'cc-22222222-aaaa-4bbb-8ccc-000000000002', from: deadCwd, to: canonicalFallback },
    ])
    expect(first.skipped).toEqual([
      { id: 'cc-33333333-aaaa-4bbb-8ccc-000000000003', reason: '存储 header 无 cwd' },
    ])
    const byPath = new Map(first.workspaces.map(item => [item.path, item]))
    expect([...byPath.keys()].sort()).toEqual([canonicalFallback, canonicalProject].sort())
    expect(byPath.get(canonicalProject)).toMatchObject({ created: true, title: expect.stringContaining('cc-adopt-project-') })
    expect(byPath.get(canonicalProject)!.attached).toEqual(['cc-11111111-aaaa-4bbb-8ccc-000000000001'])
    expect(byPath.get(canonicalFallback)!.attached).toEqual(['cc-22222222-aaaa-4bbb-8ccc-000000000002'])

    // The registry durably holds the memberships, and the remapped session's
    // stored header now names the fallback — attachable by any later boot.
    const { ctx, fibers } = await bootRegistry(sessionsRoot, storageRoot)
    try {
      const workspaces = ctx.workspaceRegistry.list()
      expect(workspaces.map(view => view.path).sort()).toEqual([canonicalFallback, canonicalProject].sort())
      const project = workspaces.find(view => view.path === canonicalProject)!
      expect(project.sessionIds).toEqual([SessionId('cc-11111111-aaaa-4bbb-8ccc-000000000001')])
      const fallback = workspaces.find(view => view.path === canonicalFallback)!
      expect(fallback.sessionIds).toEqual([SessionId('cc-22222222-aaaa-4bbb-8ccc-000000000002')])
      const backend = ctx.sessionPersistence as unknown as JsonlSessionPersistence
      const stored = await backend.loadStored(SessionId('cc-22222222-aaaa-4bbb-8ccc-000000000002'))
      expect(stored!.meta.cwd).toBe(canonicalFallback)
      expect(stored!.events.length).toBeGreaterThanOrEqual(4)
      // The rewrite dropped its dead project folder when it became empty.
      const empty: string[] = []
      for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && (await readdir(join(sessionsRoot, entry.name))).length === 0) {
          empty.push(entry.name)
        }
      }
      expect(empty).toEqual([])
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }

    const second = await adoptWorkspaces({ sessionsRoot, storageRoot, fallbackDir, compression: 'zstd' })
    expect(second.workspaces.map(item => [item.created, item.attached.length])).toEqual([[false, 0], [false, 0]])
    expect(second.remapped).toEqual([])
    expect(second.skipped.map(item => item.id)).toEqual(['cc-33333333-aaaa-4bbb-8ccc-000000000003'])
  })
})
