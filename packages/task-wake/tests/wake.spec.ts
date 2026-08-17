/**
 * Keyless wake tests over the real agent spine: the timer consumes each due
 * occurrence in the ledger first (one-shots clear, `every` advances its anchor
 * past now), fires a fresh session only for unheld tasks, and rejects invalid
 * config loudly. The fired session's LLM call fails here (no provider route)
 * — contained by design, which these tests also prove. The daily patrol gets
 * the full keyless closed loop: a scripted adapter answers the patrol session
 * with a real `task_patrol` tool call, proving observation never unshelves.
 * @module @task-center/task-wake/tests/wake
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskId, TaskService } from '@task-center/task'
import type { TaskHandle } from '@task-center/task'
import * as ToolTask from '@task-center/tool-task'
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

  it('decides the patrol slot: pre-slot sighting arms it, a missed slot is skipped, one fire per day', () => {
    const day = (hour: number, minute: number) => new Date(2026, 7, 17, hour, minute, 0, 0)
    const slot = '10:00'
    // Pre-slot ticks arm the day; crossing the slot fires exactly once.
    expect(TaskWake.patrolDecision(slot, day(9, 59), '', '')).toBe('before-slot')
    expect(TaskWake.patrolDecision(slot, day(10, 1), '2026-08-17', '')).toBe('due')
    expect(TaskWake.patrolDecision(slot, day(10, 5), '2026-08-17', '2026-08-17')).toBe('passed')
    // A process that first looks after the slot never saw the pre-slot moment:
    // the day is skipped, not caught up.
    expect(TaskWake.patrolDecision(slot, day(10, 1), '', '')).toBe('passed')
    expect(TaskWake.patrolDecision(slot, day(10, 1), '2026-08-16', '')).toBe('passed')
    // Yesterday's sighting does not carry over; the next day re-arms.
    expect(TaskWake.patrolDecision(slot, day(9, 59), '2026-08-17', '2026-08-17')).toBe('before-slot')
    expect(TaskWake.patrolDecision(slot, new Date(2026, 7, 18, 9, 59, 0, 0), '2026-08-18', '2026-08-17')).toBe('before-slot')
    expect(TaskWake.patrolDecision(slot, new Date(2026, 7, 18, 10, 1, 0, 0), '2026-08-18', '2026-08-17')).toBe('due')
    // Midnight slots still see their pre-slot window.
    expect(TaskWake.patrolDecision('00:05', new Date(2026, 7, 18, 0, 1, 0, 0), '2026-08-18', '2026-08-17')).toBe('before-slot')
    expect(TaskWake.patrolDecision('00:05', new Date(2026, 7, 18, 0, 6, 0, 0), '2026-08-18', '2026-08-17')).toBe('due')
  })

  it('rejects an off-clock patrol slot loudly at mount', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
    await ctx.plugin(ToolTask)
    await expect(ctx.plugin(TaskWake, {
      pollSeconds: 1, agent: { provider: 'p', model: 'm' }, patrol: { at: '9:30' },
    })).rejects.toThrow('patrol.at')
    await expect(ctx.plugin(TaskWake, {
      pollSeconds: 1, agent: { provider: 'p', model: 'm' }, patrol: { at: '24:00' },
    })).rejects.toThrow('patrol.at')
  })

  it('runs the daily patrol through the timer: one session observes without claiming or unshelving', { timeout: 15_000 }, async () => {
    /** The task the patrol session will observe, assigned once created. */
    let taskId = ''
    /**
     * Route scripted per request: the patrol tool call first, then the summary.
     */
    class PatrolAdapter extends LlmAdapter {
      calls = 0
      firstInput = ''

      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.calls++
        if (this.calls === 1) {
          const text = options.messages.find(message => message.role === 'user')?.content
            .find(block => block.type === 'text')
          if (text !== undefined && text.type === 'text') this.firstInput = text.text
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield {
            type: 'block-end', index: 0,
            block: {
              type: 'tool-call', id: CallId('patrol-1'), name: 'task_patrol',
              arguments: JSON.stringify({
                task_id: taskId, revision: 1,
                note: 'parked since Monday', next: 'resume the store split',
              }),
            },
          }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '巡检完成:1 个任务无进展。' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '巡检完成:1 个任务无进展。' } }
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
    await ctx.plugin(ToolTask)
    const adapter = new PatrolAdapter()
    ctx.llm.registerAdapter(['patrol-route'], adapter)
    await ctx.plugin(TaskWake, {
      pollSeconds: 0.05,
      agent: { provider: 'patrol-route', model: 'm' },
      patrol: { at: '10:00' },
    })
    try {
      const handle = await newTask(ctx)
      taskId = handle.task.record.id

      // Only the clock is faked (real timers keep the 50ms ticks alive): the
      // ticks first sight today before the slot, then cross it.
      const morning = new Date()
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(morning.getFullYear(), morning.getMonth(), morning.getDate(), 9, 59, 30))
      await new Promise(resolve => setTimeout(resolve, 150))
      vi.setSystemTime(new Date(morning.getFullYear(), morning.getMonth(), morning.getDate(), 10, 0, 30))

      await until(() => ctx.tasks.get(TaskId(taskId))!.record.contextPack.includes('PATROL: parked since Monday'))
      await until(() => adapter.calls >= 2)

      // The inventory reached the model: header, exact id, and instruction.
      expect(adapter.firstInput).toContain('[task-wake] 每日巡检')
      expect(adapter.firstInput).toContain(taskId)
      expect(adapter.firstInput).toContain('不要 task_claim')

      // Observation only: no claim, no status move, no unshelving.
      const record = ctx.tasks.get(TaskId(taskId))!.record
      expect(record.status).toBe('todo')
      expect(record.holder).toBeUndefined()
      expect(record.workedAt).toBe(record.createdAt)
      expect(record.contextPack).toContain('PATROL: parked since Monday (next: resume the store split)')

      // The patrol session logged its own receipt — model-visible means logged.
      const patrolAgent = ctx.agents.list().find(agent => agent.session.id.startsWith('patrol-'))
      expect(patrolAgent).toBeDefined()
      expect(patrolAgent!.session.events.some(event => event.type === 'task/change')).toBe(true)

      // The rest of the day stays quiet: one patrol per local day.
      const sessions = () => ctx.agents.list().filter(agent => agent.session.id.startsWith('patrol-'))
      vi.setSystemTime(new Date(morning.getFullYear(), morning.getMonth(), morning.getDate(), 10, 30, 0))
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(sessions()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
      await ctx.fiber.dispose()
    }
  })
})
