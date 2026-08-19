/**
 * Workspace adoption: after materialization, every stored `cc-` session is
 * placed under the dsh workspace registry — one workspace per distinct stored
 * header cwd (`registry.create` + `attachSession`, exactly what the web UI's
 * attach action does). The registry's one-time cwd bootstrap already ran long
 * before importing, so sessions written outside the UI would otherwise hang
 * outside every workspace forever. A cwd that does not resolve on this machine
 * (transcripts synced from another OS) cannot attach to anything — those
 * sessions are rewritten in place to the fallback directory first, keeping
 * their id, events, and createdAt. Run while dsh is stopped: the registry
 * file is owned by whichever process holds it.
 * @module @task-center/cc-import/adopt
 */

import { mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence, { type JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceRegistry, realpathNormalize } from '@deepseek-ai/dsh-workspace'

/** Where adoption reads sessions, writes storage, and parks unresolvable cwds. */
export interface AdoptOptions {
  readonly sessionsRoot: string
  readonly storageRoot: string
  /** Directory that adopts sessions whose stored cwd cannot resolve here. */
  readonly fallbackDir: string
  readonly compression?: JsonlCompression
}

/** One workspace ensured by the run, with the sessions newly attached to it. */
export interface WorkspaceAdoption {
  readonly path: string
  readonly title: string
  readonly created: boolean
  readonly attached: readonly string[]
}

/** What one adoption run did. */
export interface AdoptReport {
  readonly workspaces: readonly WorkspaceAdoption[]
  /** Sessions rewritten to the fallback directory: stored id, dead cwd, new cwd. */
  readonly remapped: readonly { id: string; from: string; to: string }[]
  /** Sessions left outside every workspace, with the reason. */
  readonly skipped: readonly { id: string; reason: string }[]
}

/** Resolve one stored cwd to its canonical directory, or `undefined` when it
 * does not name a readable directory on this machine. */
async function canonicalDir(cwd: string): Promise<string | undefined> {
  try {
    const real = await realpathNormalize(cwd)
    return (await stat(real)).isDirectory() ? real : undefined
  } catch {
    return undefined
  }
}

/** Locate a stored session's directory under the root, any project folder. */
async function sessionDir(root: string, id: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, id)
    try {
      if ((await stat(candidate)).isDirectory()) return candidate
    } catch { /* not under this project folder */ }
  }
  return undefined
}

/**
 * Place every stored `cc-` session under a workspace matching its cwd.
 * Idempotent: existing workspaces are reused, already-attached ids are left
 * alone, and a rerun over rewritten sessions sees the fallback as just
 * another resolvable cwd.
 * @param options - roots, fallback directory, and physical encoding.
 * @returns the ensured workspaces, the header rewrites, and the leftovers.
 */
export async function adoptWorkspaces(options: AdoptOptions): Promise<AdoptReport> {
  await mkdir(options.sessionsRoot, { recursive: true })
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SessionStore),
    await ctx.plugin(JsonlSessionPersistence, {
      root: options.sessionsRoot,
      ...options.compression === undefined ? {} : { compression: options.compression },
      writeBatchMaxDelayMs: 1,
    }),
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root: options.storageRoot }),
    await ctx.plugin(StorageDomain, { backend: 'json', routes: {} }),
    await ctx.plugin(WorkspaceRegistry),
  ]
  try {
    const registry = ctx.workspaceRegistry
    const headers = (await ctx.sessionPersistence.list())
      .filter(header => String(header.id).startsWith('cc-'))

    // Classify by stored cwd: resolvable ones group under their canonical dir,
    // dead ones queue for a fallback rewrite, missing ones cannot attach.
    const groups = new Map<string, string[]>()
    const remapped: { id: string; from: string; to: string }[] = []
    const skipped: { id: string; reason: string }[] = []
    const pendingRewrite: { id: string; cwd: string }[] = []
    for (const header of headers) {
      if (header.cwd === undefined) {
        skipped.push({ id: String(header.id), reason: '存储 header 无 cwd' })
        continue
      }
      const canonical = await canonicalDir(header.cwd)
      if (canonical !== undefined) {
        const group = groups.get(canonical) ?? []
        group.push(String(header.id))
        groups.set(canonical, group)
      } else {
        pendingRewrite.push({ id: String(header.id), cwd: header.cwd })
      }
    }

    // Rewrite dead-cwd sessions to the fallback: same id, same events, same
    // createdAt — only the header cwd (and thus the on-disk project folder)
    // moves. `loadStored` is a backend method; the service property types as
    // the base persistence interface.
    if (pendingRewrite.length > 0) {
      const backend = ctx.sessionPersistence as unknown as JsonlSessionPersistence
      await mkdir(options.fallbackDir, { recursive: true })
      const fallback = await realpathNormalize(options.fallbackDir)
      const rewritten: string[] = []
      for (const { id, cwd } of pendingRewrite) {
        const stored = await backend.loadStored(SessionId(id))
        if (stored === undefined) {
          skipped.push({ id, reason: `存储日志缺失,无法重映射 (cwd ${cwd})` })
          continue
        }
        const dir = await sessionDir(options.sessionsRoot, id)
        if (dir !== undefined) {
          await rm(dir, { recursive: true, force: true })
          // Drop the project folder too when this was its last session; it
          // fails harmlessly when siblings remain and the folder stays.
          await rmdir(dirname(dir)).catch(() => {})
        }
        ctx.sessions.create(SessionId(id), {
          seed: stored.events,
          meta: { cwd: fallback, createdAt: stored.meta.createdAt },
        })
        rewritten.push(id)
        remapped.push({ id, from: cwd, to: fallback })
      }
      // The write path batches; let the rewrites land before attaching.
      await new Promise(resolve => setTimeout(resolve, 100))
      const group = groups.get(fallback) ?? []
      group.push(...rewritten)
      groups.set(fallback, group)
    }

    const workspaces: WorkspaceAdoption[] = []
    for (const [path, ids] of groups) {
      const existing = await registry.resolveByPath(path)
      const workspace = existing ?? await registry.create(path)
      const attached: string[] = []
      for (const id of ids) {
        // `sessionIds` is the already-filtered account; an id in it is done.
        if (workspace.sessionIds.some(seat => String(seat) === id)) continue
        try {
          await workspace.attachSession(SessionId(id))
          attached.push(id)
        } catch (error) {
          skipped.push({ id, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      workspaces.push({ path, title: workspace.title, created: existing === undefined, attached })
    }
    workspaces.sort((a, b) => b.attached.length - a.attached.length || a.path.localeCompare(b.path))
    return { workspaces, remapped, skipped }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}
