/**
 * Keyless quota tests: the pure park decision over provider-neutral failures,
 * and the full closed loop over the real agent spine with a fake provider —
 * a session claims a task, its request dies in `QUOTA` with a provider delay,
 * the guard parks (block → release → wake) before the loop sees the failure,
 * and task-wake fires a fresh session at the reset instant.
 * @module @task-center/task-quota/tests/quota
 */

import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmFailure, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import { TaskQuotaService } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { decide, parkLine } from '../src/index.ts'
import * as TaskWake from '@task-center/task-wake'
import * as ToolTask from '@task-center/tool-task'

const now = new Date('2026-08-17T12:00:00Z')

/** One provider-neutral terminal failure. */
function failure(overrides: Partial<LlmFailure> = {}): LlmFailure {
  return { message: 'usage limit reached', code: 'QUOTA', ...overrides }
}

describe('quota decision', () => {
  it('parks at the provider delay when present', () => {
    const decision = decide(failure({ providerRetryAfterMs: 3_600_000 }), undefined, now)
    expect(decision).toEqual({ kind: 'park', resetAt: '2026-08-17T13:00:00.000Z', from: 'provider' })
  })

  it('falls back to the declared window when the provider is silent', () => {
    const decision = decide(failure(), 18_000, now)
    expect(decision).toEqual({ kind: 'park', resetAt: '2026-08-17T17:00:00.000Z', from: 'fallback' })
  })

  it('parks without a wake rule when nothing knows the reset time', () => {
    expect(decide(failure(), undefined, now)).toEqual({ kind: 'park-without-wake' })
    expect(decide(failure({ providerRetryAfterMs: 0 }), undefined, now)).toEqual({ kind: 'park-without-wake' })
  })

  it('ignores every non-quota failure', () => {
    for (const code of ['RATE_LIMIT', 'AUTH', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED']) {
      expect(decide(failure({ code, providerRetryAfterMs: 5_000 }), 18_000, now)).toEqual({ kind: 'ignore' })
    }
  })

  it('names the mover in the pack line per the resume knob', () => {
    const park = { kind: 'park', resetAt: '2026-08-17T13:00:00.000Z', from: 'provider' } as const
    expect(parkLine(park)).toContain('到点自动唤醒续做')
    expect(parkLine(park, false)).toContain('自动续做已关闭')
    expect(parkLine(park, false)).not.toContain('到点自动唤醒续做')
  })
})

/** Provider whose first request per session dies in QUOTA; later requests succeed. */
class FakeQuotaAdapter extends LlmAdapter {
  private readonly quotaSeen = new Set<string>()

  /** Delay the fake exhaustion error carries; undefined when the platform is silent. */
  constructor(private readonly retryAfterMs?: number) {
    super()
  }

  providerInfo(provider: string) {
    return { id: provider, name: `fake ${provider}` }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const session = options.sessionId === undefined ? 'anonymous' : options.sessionId
    if (!this.quotaSeen.has(session)) {
      this.quotaSeen.add(session)
      const delay = this.retryAfterMs === undefined ? {} : { providerRetryAfterMs: this.retryAfterMs }
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'usage limit reached', code: 'QUOTA', ...delay } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Boot the spine, the fake provider, the seam, the quota guard, and task-wake. */
async function boot(quotaConfig: Config = { fallbackWindowSeconds: 18_000 }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fake-quota'], new FakeQuotaAdapter(1_000))
  await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
  await ctx.plugin(ToolTask)
  await ctx.plugin(TaskQuotaService, quotaConfig)
  await ctx.plugin(TaskWake, { pollSeconds: 0.2, agent: { provider: 'fake-quota', model: 'm' } })
  return ctx
}

/** Poll an assertion until it holds or the deadline passes. */
async function until(holds: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (holds()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!holds()) throw new Error('condition not reached before the deadline')
}

describe('task-quota guard', () => {
  it('parks the held task at the wall and wakes a fresh session at reset', { timeout: 10_000 }, async () => {
    const ctx = await boot()

    const created = await ctx.tasks.create({ objective: 'o', acceptance: 'a' }, { kind: 'human' })
    if ('code' in created) throw new Error(created.code)

    // The session claims (as the model would through the tools) and then hits the wall.
    const worker = ctx.agentLoop.create(SessionId('worker-1'), { provider: 'fake-quota', model: 'm' })
    const claimed = await ctx.tasks.claim(created.task.record.id, worker.session, { kind: 'model', sessionId: worker.session.id })
    if ('code' in claimed) throw new Error(claimed.code)
    expect(claimed.record.holder).toBe(worker.session.id as never)

    const idle = worker.whenIdle()
    worker.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle.catch(() => undefined)

    // Parked: blocked pack line first, then released to todo with a wake rule at reset.
    const parked = ctx.tasks.get(created.task.record.id)!
    expect(parked.record.status).toBe('todo')
    expect(parked.record.holder).toBeUndefined()
    expect(parked.record.contextPack).toContain('额度用尽')
    expect(parked.record.blockedReason).toBeUndefined()
    const rule = parked.record.wakeRule
    expect(rule?.kind).toBe('at')

    // At reset, task-wake consumes the rule and fires a fresh session that succeeds.
    await until(() => ctx.tasks.get(created.task.record.id)?.record.wakeRule === undefined)
    await until(() => ctx.agents.list().some(agent => agent.session.id.startsWith('wake-')))
  })

  it('parks without a wake rule when nothing knows the reset time', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['fake-blank'], new FakeQuotaAdapter())
    await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
    await ctx.plugin(TaskQuotaService, {})

    const created = await ctx.tasks.create({ objective: 'o', acceptance: 'a' }, { kind: 'human' })
    if ('code' in created) throw new Error(created.code)
    const worker = ctx.agentLoop.create(SessionId('worker-2'), { provider: 'fake-blank', model: 'm' })
    const claimed = await ctx.tasks.claim(created.task.record.id, worker.session, { kind: 'model', sessionId: worker.session.id })
    if ('code' in claimed) throw new Error(claimed.code)

    const idle = worker.whenIdle()
    worker.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle.catch(() => undefined)

    const parked = ctx.tasks.get(created.task.record.id)!
    expect(parked.record.status).toBe('todo')
    expect(parked.record.holder).toBeUndefined()
    expect(parked.record.wakeRule).toBeUndefined()
    expect(parked.record.contextPack).toContain('未给出恢复时间')
  })

  it('parks without the wake rule when resumeOnReset is off', { timeout: 10_000 }, async () => {
    const ctx = await boot({ fallbackWindowSeconds: 18_000, resumeOnReset: false })

    const created = await ctx.tasks.create({ objective: 'o', acceptance: 'a' }, { kind: 'human' })
    if ('code' in created) throw new Error(created.code)
    const worker = ctx.agentLoop.create(SessionId('worker-3'), { provider: 'fake-quota', model: 'm' })
    const claimed = await ctx.tasks.claim(created.task.record.id, worker.session, { kind: 'model', sessionId: worker.session.id })
    if ('code' in claimed) throw new Error(claimed.code)

    const idle = worker.whenIdle()
    worker.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle.catch(() => undefined)

    // Parked and released with the wall named, but the reset rule never set.
    const parked = ctx.tasks.get(created.task.record.id)!
    expect(parked.record.status).toBe('todo')
    expect(parked.record.holder).toBeUndefined()
    expect(parked.record.wakeRule).toBeUndefined()
    expect(parked.record.contextPack).toContain('自动续做已关闭')
    expect(parked.record.contextPack).toContain('预计')

    // Long enough for a wrongly-set rule to have fired (wake polls every 0.2s).
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(ctx.tasks.get(created.task.record.id)?.record.wakeRule).toBeUndefined()
    expect(ctx.agents.list().some(agent => agent.session.id.startsWith('wake-'))).toBe(false)
  })

  it('rejects a non-boolean resumeOnReset at mount', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
    await expect(ctx.plugin(TaskQuotaService, { resumeOnReset: 'yes' as never })).rejects.toThrow('resumeOnReset')
  })

  it('parks without the wake rule when the knob is flipped off at runtime', { timeout: 10_000 }, async () => {
    // Config default stays on; only the runtime flip (the web toggle's path) turns it off.
    const ctx = await boot()
    expect(ctx['task-quota'].quotaGet()).toEqual({ ok: true, resume: true })
    expect(await ctx['task-quota'].quotaSet(false)).toEqual({ ok: true, resume: false })

    const created = await ctx.tasks.create({ objective: 'o', acceptance: 'a' }, { kind: 'human' })
    if ('code' in created) throw new Error(created.code)
    const worker = ctx.agentLoop.create(SessionId('worker-4'), { provider: 'fake-quota', model: 'm' })
    const claimed = await ctx.tasks.claim(created.task.record.id, worker.session, { kind: 'model', sessionId: worker.session.id })
    if ('code' in claimed) throw new Error(claimed.code)

    const idle = worker.whenIdle()
    worker.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await idle.catch(() => undefined)

    // The runtime flip governed the park: no wake rule, the wall named in the pack.
    const parked = ctx.tasks.get(created.task.record.id)!
    expect(parked.record.wakeRule).toBeUndefined()
    expect(parked.record.contextPack).toContain('自动续做已关闭')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(ctx.agents.list().some(agent => agent.session.id.startsWith('wake-'))).toBe(false)

    // Flipping back on re-arms the closed loop for the next wall.
    expect(await ctx['task-quota'].quotaSet(true)).toEqual({ ok: true, resume: true })
  })

  it('rejects a non-boolean knob value at the wire', async () => {
    const ctx = await boot()
    expect(await ctx['task-quota'].quotaSet('yes' as never)).toEqual({
      ok: false, code: 'QUOTA_INVALID_VALUE', message: 'value 必须是布尔值',
    })
  })
})

describe('task-quota resume knob store', () => {
  it('persists the last flip across a full remount of the durable medium', { timeout: 8_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'task-quota-'))
    const bootDurable = async (): Promise<Context> => {
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
      await ctx.plugin(Storage)
      await ctx.plugin(StorageJson, { root })
      await ctx.plugin(StorageDomain, { backend: 'json', routes: {} })
      await ctx.plugin(TaskQuotaService, {})
      return ctx
    }
    try {
      const first = await bootDurable()
      await until(() => first['task-quota'].quotaGet().resume === true)
      expect(await first['task-quota'].quotaSet(false)).toEqual({ ok: true, resume: false })
      await first.fiber.dispose()

      const second = await bootDurable()
      await until(() => second['task-quota'].quotaGet().resume === false)
      expect(second['task-quota'].quotaGet().resume).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
