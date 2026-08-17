/**
 * Keyless liveness tests over the real agent spine: a session disposed while
 * holding loses its hold immediately, and the boot sweep releases only holds
 * absent from the live store (crash recovery) — live holders and review-held
 * submissions are untouched.
 * @module @task-center/task-reaper/tests/reaper
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import type { TaskHandle } from '@task-center/task'
import * as TaskReaper from '../src/index.ts'

/** Boot the spine plus the task seam, without the reaper. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
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

describe('task-reaper', () => {
  it('releases the hold when its session is disposed, so a fresh session may claim', async () => {
    const ctx = await boot()
    const handle = await newTask(ctx)
    const worker = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('s-hold'),
      agentOptions: { provider: 'no-route', model: 'm' },
    })
    const claimed = await ctx.tasks.claim(handle.task.record.id, worker.agent.session, { kind: 'model', sessionId: worker.agent.session.id })
    if ('code' in claimed) throw new Error(claimed.code)
    expect(claimed.record.holder).toBe(worker.agent.session.id as never)

    await ctx.plugin(TaskReaper)
    await worker.dispose()

    await until(() => ctx.tasks.get(handle.task.record.id)?.record.holder === undefined)
    const released = ctx.tasks.get(handle.task.record.id)!
    expect(released.record.status).toBe('todo')

    // The freed task is claimable again — the crash-recovery continuation path.
    const next = Session.create(SessionId('s-next'))
    const reclaimed = await ctx.tasks.claim(handle.task.record.id, next, { kind: 'model', sessionId: next.id })
    if ('code' in reclaimed) throw new Error(reclaimed.code)
    expect(reclaimed.record.status).toBe('active')
  })

  it('sweeps pre-existing dead holds at mount and spares live holders', async () => {
    const ctx = await boot()
    const ghost = await newTask(ctx)
    const ghostSession = Session.create(SessionId('s-ghost'))
    const ghostClaimed = await ctx.tasks.claim(ghost.task.record.id, ghostSession, { kind: 'model', sessionId: ghostSession.id })
    if ('code' in ghostClaimed) throw new Error(ghostClaimed.code)

    const live = await newTask(ctx)
    const worker = await ctx.agentLoop.createAgent(ctx, {
      sessionId: SessionId('s-live'),
      agentOptions: { provider: 'no-route', model: 'm' },
    })
    const liveClaimed = await ctx.tasks.claim(live.task.record.id, worker.agent.session, { kind: 'model', sessionId: worker.agent.session.id })
    if ('code' in liveClaimed) throw new Error(liveClaimed.code)

    // Mounting the reaper releases the ghost hold (absent from the store) and keeps the live one.
    await ctx.plugin(TaskReaper)
    await until(() => ctx.tasks.get(ghost.task.record.id)?.record.status === 'todo')
    expect(ctx.tasks.get(ghost.task.record.id)?.record.holder).toBeUndefined()
    expect(ctx.tasks.get(live.task.record.id)?.record.status).toBe('active')
    expect(ctx.tasks.get(live.task.record.id)?.record.holder).toBe(worker.agent.session.id as never)
  })
})
