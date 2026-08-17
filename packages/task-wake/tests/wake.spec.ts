/**
 * Keyless wake tests over the real agent spine: the timer consumes each due
 * occurrence in the ledger first (one-shots clear, `every` advances its anchor
 * past now), fires a fresh session only for unheld tasks, and rejects invalid
 * config loudly. The fired session's LLM call fails here (no provider route)
 * — contained by design, which these tests also prove.
 * @module @task-center/task-wake/tests/wake
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import type { TaskHandle } from '@task-center/task'
import * as TaskWake from '../src/index.ts'

/** Boot the spine plus task-wake polling every 50ms with a dead provider route. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
  await ctx.plugin(TaskWake, { pollSeconds: 0.05, agent: { provider: 'no-route', model: 'no-model' } })
  return ctx
}

/** Poll an assertion until it holds or the deadline passes. */
async function until(holds: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (holds()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (!holds()) throw new Error('condition not reached before the deadline')
}

/** Create one task as the human actor, failing loud. */
async function newTask(ctx: Context): Promise<TaskHandle> {
  const created = await ctx.tasks.create({ objective: 'o', acceptance: 'a' }, { kind: 'human' })
  if ('code' in created) throw new Error(created.code)
  return created
}

describe('task-wake', () => {
  it('clears a fired one-shot in the ledger as the wake actor and fires a session', async () => {
    const ctx = await boot()
    const handle = await newTask(ctx)
    const set = await ctx.tasks.mutate(handle.task.record.id, handle.task.record.revision,
      { operation: 'wake-set', rule: { kind: 'at', scheduledAt: new Date(Date.now() - 1000).toISOString() } }, { kind: 'human' })
    if ('code' in set) throw new Error(set.code)

    await until(() => ctx.tasks.get(handle.task.record.id)?.record.wakeRule === undefined)
    const task = ctx.tasks.get(handle.task.record.id)!
    // The wake actor consumed the occurrence; the task itself is untouched.
    expect(task.record.status).toBe('todo')

    // A wake session was started for the unheld task; its LLM failure is contained.
    const prefix = `wake-${handle.task.record.id.slice(0, 8)}`
    await until(() => ctx.agents.list().some(agent => agent.session.id.startsWith(prefix)))
    expect(ctx.agents.list().some(agent => agent.session.id.startsWith(prefix))).toBe(true)
  })

  it('advances an every anchor past now instead of clearing the rule', async () => {
    const ctx = await boot()
    const handle = await newTask(ctx)
    const before = Date.now()
    const set = await ctx.tasks.mutate(handle.task.record.id, handle.task.record.revision,
      { operation: 'wake-set', rule: { kind: 'every', everySeconds: 300, anchorAt: new Date(before - 600_000).toISOString() } }, { kind: 'human' })
    if ('code' in set) throw new Error(set.code)

    await until(() => {
      const rule = ctx.tasks.get(handle.task.record.id)?.record.wakeRule
      return rule?.kind === 'every' && Date.parse(rule.anchorAt) > before
    })
    const rule = ctx.tasks.get(handle.task.record.id)!.record.wakeRule!
    expect(rule.kind).toBe('every')
    if (rule.kind !== 'every') throw new Error('narrowed')
    // The new anchor targets exactly one interval after the fire decision.
    expect(Date.parse(rule.anchorAt) - before).toBeGreaterThanOrEqual(300_000)
    expect(Date.parse(rule.anchorAt) - before).toBeLessThan(320_000)
  })

  it('consumes the occurrence for a held task without firing a session', async () => {
    const ctx = await boot()
    const handle = await newTask(ctx)
    const modelSession = Session.create(SessionId('s-holder'))
    const claimed = await ctx.tasks.claim(handle.task.record.id, modelSession, { kind: 'model', sessionId: modelSession.id })
    if ('code' in claimed) throw new Error(claimed.code)
    const set = await ctx.tasks.mutate(handle.task.record.id, claimed.record.revision,
      { operation: 'wake-set', rule: { kind: 'at', scheduledAt: new Date(Date.now() - 1000).toISOString() } }, { kind: 'human' })
    if ('code' in set) throw new Error(set.code)

    await until(() => ctx.tasks.get(handle.task.record.id)?.record.wakeRule === undefined)
    const prefix = `wake-${handle.task.record.id.slice(0, 8)}`
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(ctx.agents.list().some(agent => agent.session.id.startsWith(prefix))).toBe(false)
  })

  it('rejects invalid config loudly at mount', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
    await expect(ctx.plugin(TaskWake, { pollSeconds: 0, agent: { provider: 'p', model: 'm' } })).rejects.toThrow('pollSeconds')
    await expect(ctx.plugin(TaskWake, { pollSeconds: 1, agent: { provider: ' ', model: 'm' } })).rejects.toThrow('provider')
  })

  it('defers firing while the route is quota-walled, then fires when it reopens', { timeout: 10_000 }, async () => {
    /** Route that dies in QUOTA with a short delay until reopened. */
    class WallAdapter extends LlmAdapter {
      walled = true

      providerInfo(provider: string) {
        return { id: provider, name: `wall ${provider}` }
      }

      async *stream(): AsyncIterable<StreamChunk> {
        if (this.walled) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'usage limit reached', code: QUOTA_EXCEEDED_CODE, providerRetryAfterMs: 150 } } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'ok' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
    const adapter = new WallAdapter()
    ctx.llm.registerAdapter(['wall'], adapter)
    await ctx.plugin(TaskWake, { pollSeconds: 0.05, agent: { provider: 'wall', model: 'm' } })

    const handle = await newTask(ctx)
    const set = await ctx.tasks.mutate(handle.task.record.id, handle.task.record.revision,
      { operation: 'wake-set', rule: { kind: 'at', scheduledAt: new Date(Date.now() - 1000).toISOString() } }, { kind: 'human' })
    if ('code' in set) throw new Error(set.code)

    // Walled: the probe defers each tick — occurrence unconsumed, no session fired.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(ctx.tasks.get(handle.task.record.id)?.record.wakeRule).toBeDefined()
    expect(ctx.agents.list().some(agent => agent.session.id.startsWith(`wake-${handle.task.record.id.slice(0, 8)}`))).toBe(false)

    adapter.walled = false
    await until(() => ctx.tasks.get(handle.task.record.id)?.record.wakeRule === undefined)
    await until(() => ctx.agents.list().some(agent => agent.session.id.startsWith(`wake-${handle.task.record.id.slice(0, 8)}`)))
  })
})
