/**
 * Materialization units: the same mapped fixtures write as real zstd-compressed
 * dsh sessions under a temp root, a second run over that root skips every id
 * (idempotency is the `list()` pre-check, because `sessions.create` silently
 * adopts an existing id), and the stored log round-trips with backdated header
 * facts and the constructor's seed marker appended.
 * @module @task-center/cc-import/tests/materialize
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { parseCcSession } from '../src/parse.ts'
import { mapCcSession } from '../src/map.ts'
import { ccSessionId, materializeSessions } from '../src/materialize.ts'
import type { MaterializeInput } from '../src/materialize.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** The plan + chat fixtures as materialize inputs, plus one empty log. */
async function fixtureInputs(): Promise<MaterializeInput[]> {
  const sessions = await Promise.all(['plan-session.jsonl', 'chat-session.jsonl'].map(async name => {
    const session = await parseCcSession(resolve(import.meta.dirname, 'fixtures', name))
    return {
      id: ccSessionId(session.sessionUuid),
      cwd: session.cwd,
      createdAt: session.createdAt,
      events: mapCcSession(session).events,
    }
  }))
  return [...sessions, { id: 'cc-empty', cwd: undefined, createdAt: undefined, events: [] }]
}

/** Read one stored session from a root under a fresh persistence mount. */
async function readStored(root: string, id: string) {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SessionStore),
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' }),
  ]
  try {
    // `loadStored` is a backend method; the service property types as the base.
    const backend = ctx.sessionPersistence as unknown as JsonlSessionPersistence
    return await backend.loadStored(SessionId(id))
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}

describe('materializeSessions', () => {
  it('creates cc- sessions once, then skips every id on the second run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-import-materialize-'))
    roots.push(root)
    const inputs = await fixtureInputs()
    const first = await materializeSessions(inputs, { root, compression: 'zstd' })
    expect(first.created).toEqual([
      { id: 'cc-11111111-aaaa-4bbb-8ccc-000000000001', events: 14 },
      { id: 'cc-22222222-aaaa-4bbb-8ccc-000000000002', events: 4 },
    ])
    expect(first.skipped).toEqual(['cc-empty'])
    const second = await materializeSessions(inputs, { root, compression: 'zstd' })
    expect(second.created).toEqual([])
    expect(second.skipped).toEqual(inputs.map(input => input.id))
  })

  it('round-trips the plan fixture through zstd with backdated facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cc-import-roundtrip-'))
    roots.push(root)
    const [plan] = await fixtureInputs()
    await materializeSessions([plan!], { root, compression: 'zstd' })
    const stored = await readStored(root, plan!.id)
    expect(stored).toBeDefined()
    expect(stored!.meta.id).toBe(SessionId(plan!.id))
    expect(stored!.meta.cwd).toBe('D:\\Projects\\demo')
    expect(stored!.meta.createdAt).toBe(Date.parse('2026-08-15T10:00:00.000Z'))
    // The mapped log plus the constructor's seed-end marker.
    expect(stored!.events.map(event => event.type)).toEqual([
      ...plan!.events.map(event => event.type),
      'session/end-seed',
    ])
    expect(stored!.events[1]!.time).toBe(Date.parse('2026-08-15T10:00:00.000Z'))
  })
})
