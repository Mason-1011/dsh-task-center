/**
 * Keyless sched tests over the real agent spine: the SRC surface (namespace,
 * plain-identifier signatures), the closed loop — a due send delivers one
 * user message into a live session's turn and settles `fired` — validation
 * codes at create, cancel semantics, loud config rejection, the dead-target
 * failure path settling `failed` with a note, and over the durable medium:
 * rows survive a remount and a boot hands crash-stuck `firing` rows back to
 * pending.
 * @module dsh-task-center-task-sched/tests/sched
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { deliverSend, SchedBoardService } from '../src/index.ts'
import type { Config, SchedListResult } from '../src/index.ts'
import { openSends } from '../src/sends.ts'

/** Poll an assertion until it holds or the deadline passes. */
async function until(holds: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (holds()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (!holds()) throw new Error('condition not reached before the deadline')
}

/** Fail loud on any `undefined` anywhere in a wire payload. */
function assertNoUndefined(node: unknown, path = '$'): void {
  if (node === undefined) throw new Error(`undefined at ${path}`)
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`))
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) assertNoUndefined(value, `${path}.${key}`)
  }
}

/** Route that records every user text it sees and answers ok. */
class ReplyAdapter extends LlmAdapter {
  readonly inputs: string[] = []

  providerInfo(provider: string) {
    return { id: provider, name: `reply ${provider}` }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages.find(message => message.role === 'user')?.content
      .find(block => block.type === 'text')
    if (text !== undefined && text.type === 'text') this.inputs.push(text.text)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Boot the agent spine plus sched polling every 50ms over the reply route. */
async function boot(adapter: ReplyAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['sched-route'], adapter)
  await ctx.plugin(SchedBoardService, { pollSeconds: 0.05, agent: { provider: 'sched-route', model: 'm' } })
  return ctx
}

/** One sched config over the named route. */
function schedConfig(): Config {
  return { pollSeconds: 1, agent: { provider: 'sched-route', model: 'm' } }
}

describe('task-sched', () => {
  it('exposes the task-sched SRC surface: namespace, methods, plain-identifier signatures', async () => {
    const ctx = await boot(new ReplyAdapter())
    try {
      const service = ctx['task-sched']
      expect(service).toBeDefined()
      expect(service.typertRemote.namespace).toBe('task-sched')
      const markers = remoteMethods(service)
      expect(markers.map(marker => marker.method).sort()).toEqual(['schedCancel', 'schedCreate', 'schedList'])
      for (const marker of markers) {
        expect(marker.invocation).toEqual({ kind: 'direct' })
        expect(marker.exportName).toBeUndefined()
      }
      // The api-gateway derives wire fields from the method source: parameters
      // must be unique plain identifiers (no destructuring, defaults, rest).
      for (const marker of markers) {
        const implementation = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), marker.method)?.value
        if (typeof implementation !== 'function') throw new Error(`no prototype method ${marker.method}`)
        const source = Function.prototype.toString.call(implementation as () => void)
        const open = source.indexOf('(')
        const close = source.indexOf(')', open + 1)
        const body = source.slice(open + 1, close).trim()
        const names = new Set<string>()
        for (const part of body.length === 0 ? [] : body.split(',').map(part => part.trim())) {
          expect(part, `${marker.method} parameter of ${source}`).toMatch(/^[$A-Z_a-z][$\w]*$/u)
          expect(names.has(part), `${marker.method} repeats parameter ${part}`).toBe(false)
          names.add(part)
        }
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('delivers a due send into a live session as one user message and settles fired', { timeout: 8_000 }, async () => {
    const adapter = new ReplyAdapter()
    const ctx = await boot(adapter)
    try {
      const live = ctx.agentLoop.create(SessionId('s-live'), { provider: 'sched-route', model: 'm' }, { cwd: process.cwd() })
      const created = await ctx['task-sched'].schedCreate(live.session.id, 'cont', new Date(Date.now() + 150).toISOString())
      expect(created).toMatchObject({ ok: true })
      assertNoUndefined(created)

      const before: SchedListResult = ctx['task-sched'].schedList()
      expect(before.sends).toHaveLength(1)
      expect(before.sends[0]).toMatchObject({ sessionId: 's-live', content: 'cont', status: 'pending' })
      expect(Object.keys(before.sends[0]!).includes('settledAt')).toBe(false)

      // The due send rides one user turn through the live session's route.
      await until(() => adapter.inputs.includes('cont'))
      await until(() => ctx['task-sched'].schedList().sends[0]?.status === 'fired')
      const settled = ctx['task-sched'].schedList().sends[0]!
      expect(settled.settledAt).toBeDefined()
      assertNoUndefined(settled)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('holds a not-yet-due send, and cancel removes it before it ever fires', { timeout: 8_000 }, async () => {
    const adapter = new ReplyAdapter()
    const ctx = await boot(adapter)
    try {
      const live = ctx.agentLoop.create(SessionId('s-hold'), { provider: 'sched-route', model: 'm' }, { cwd: process.cwd() })
      const created = await ctx['task-sched'].schedCreate(live.session.id, 'later', new Date(Date.now() + 60_000).toISOString())
      if (!created.ok) throw new Error(created.code)
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(ctx['task-sched'].schedList().sends[0]?.status).toBe('pending')
      expect(adapter.inputs).toHaveLength(0)

      const canceled = await ctx['task-sched'].schedCancel(created.id)
      expect(canceled).toEqual({ ok: true })
      expect(ctx['task-sched'].schedList().sends).toHaveLength(0)
      const missing = await ctx['task-sched'].schedCancel(created.id)
      expect(missing).toMatchObject({ ok: false, code: 'SCHED_NOT_FOUND' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('guards create inputs with stable codes', { timeout: 8_000 }, async () => {
    const ctx = await boot(new ReplyAdapter())
    try {
      const service = ctx['task-sched']
      const emptySession = await service.schedCreate('  ', 'cont', new Date(Date.now() + 60_000).toISOString())
      expect(emptySession).toMatchObject({ ok: false, code: 'SCHED_INVALID_SESSION' })
      const live = ctx.agentLoop.create(SessionId('s-guard'), { provider: 'sched-route', model: 'm' }, { cwd: process.cwd() })
      const emptyContent = await service.schedCreate(live.session.id, '  ', new Date(Date.now() + 60_000).toISOString())
      expect(emptyContent).toMatchObject({ ok: false, code: 'SCHED_INVALID_CONTENT' })
      const pastTime = await service.schedCreate(live.session.id, 'cont', new Date(Date.now() - 60_000).toISOString())
      expect(pastTime).toMatchObject({ ok: false, code: 'SCHED_INVALID_TIME' })
      const brokenTime = await service.schedCreate(live.session.id, 'cont', 'not-a-time')
      expect(brokenTime).toMatchObject({ ok: false, code: 'SCHED_INVALID_TIME' })
      const ghost = await service.schedCreate('s-ghost', 'cont', new Date(Date.now() + 60_000).toISOString())
      expect(ghost).toMatchObject({ ok: false, code: 'SCHED_UNKNOWN_SESSION' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('settles a send to the dead target as failed with a note', { timeout: 8_000 }, async () => {
    const ctx = await boot(new ReplyAdapter())
    try {
      // A shelved session without a live agent and without a persistence
      // backend: create passes (the session store knows it), the resume at
      // fire time cannot.
      ctx.sessions.create(SessionId('s-shelved'))
      const created = await ctx['task-sched'].schedCreate(SessionId('s-shelved'), 'cont', new Date(Date.now() + 100).toISOString())
      if (!created.ok) throw new Error(created.code)
      await until(() => ctx['task-sched'].schedList().sends[0]?.status === 'failed')
      const failed = ctx['task-sched'].schedList().sends[0]!
      expect(failed.note).toBeDefined()
      assertNoUndefined(failed)
      // A settled row can still be cleared from the list.
      const cleared = await ctx['task-sched'].schedCancel(failed.id)
      expect(cleared).toEqual({ ok: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid config loudly at mount', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await expect(ctx.plugin(SchedBoardService, { pollSeconds: 0, agent: { provider: 'p', model: 'm' } })).rejects.toThrow('pollSeconds')
    await expect(ctx.plugin(SchedBoardService, { pollSeconds: 1, agent: { provider: ' ', model: 'm' } })).rejects.toThrow('provider')
    await ctx.fiber.dispose()
  })

  it('delivers nothing to an unknown session when called directly, failing loud', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    try {
      await expect(deliverSend(ctx, schedConfig(), SessionId('s-nowhere'), 'cont')).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recovers a crash-stuck firing row to pending and keeps rows across a remount', { timeout: 8_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-sched-'))
    const bootDurable = async (): Promise<Context> => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, {})
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json', routes: {} })
      return ctx
    }
    try {
      // Seed the medium with a firing row — the state a crash mid-delivery leaves.
      const seeder = await bootDurable()
      const seeded = await openSends(seeder.storageDomain!)
      await seeded.sends.put({
        id: 'stuck', sessionId: 's-x', content: 'cont', scheduledAt: new Date(Date.now() - 1_000).toISOString(),
        status: 'firing', createdAt: new Date(0).toISOString(),
      })
      await seeded.close()
      await seeder.fiber.dispose()

      const ctx = await bootDurable()
      await ctx.plugin(SchedBoardService, { pollSeconds: 0.05, agent: { provider: 'sched-route', model: 'm' } })
      // Boot recovery handed the stuck row back to pending (it fires and fails
      // on the dead route, which itself proves it re-entered the pipeline).
      await until(() => ctx['task-sched'].schedList().sends.some(send => send.id === 'stuck' && send.status === 'failed'))
      const stuck = ctx['task-sched'].schedList().sends.find(send => send.id === 'stuck')!
      expect(stuck.status).toBe('failed')

      // A pending row created through the RPC survives a full remount.
      ctx.sessions.create(SessionId('s-keep'))
      const created = await ctx['task-sched'].schedCreate(SessionId('s-keep'), 'cont', new Date(Date.now() + 60_000).toISOString())
      if (!created.ok) throw new Error(created.code)
      await ctx.fiber.dispose()

      const remounted = await bootDurable()
      await remounted.plugin(SchedBoardService, { pollSeconds: 0.05, agent: { provider: 'sched-route', model: 'm' } })
      expect(remounted['task-sched'].schedList().sends.some(send => send.id === created.id && send.status === 'pending')).toBe(true)
      await remounted.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
