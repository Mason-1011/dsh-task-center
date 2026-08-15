/**
 * Keyless tool tests over the real dsh tool registry and the real task seam:
 * the full model lifecycle through the five tools, the dual-ledger receipts,
 * the closed error union, and registration disposal.
 * @module @task-center/tool-task/tests/tools
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TaskService } from '@task-center/task'
import * as ToolTask from '../src/index.ts'
import type { TaskToolError, TaskToolListValue, TaskToolTask, TaskToolValue } from '../src/index.ts'

/** Boot system-prompt, the tool registry, the seam, and tool-task. */
async function boot(): Promise<{ ctx: Context; toolFiber: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
  const toolFiber = await ctx.plugin(ToolTask)
  return { ctx, toolFiber }
}

const sessionId = SessionId('s-tools')
const strangerId = SessionId('s-stranger')
const session = Session.create(sessionId)
const strangerSession = Session.create(strangerId)

/** Minimal exec carrying one agent-shaped holder of a real Session. */
function execOf(agentSession = session): ToolRunContext {
  return { agent: { session: agentSession }, signal: new AbortController().signal } as unknown as ToolRunContext
}

/** The registered definition of one tool, failing loudly when absent. */
function tool(ctx: Context, name: string) {
  const definition = ctx.tools.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  return definition
}

/** Run one tool call and narrow to its task value. */
async function ok(ctx: Context, name: string, args: unknown, exec = execOf()): Promise<TaskToolTask> {
  const value = await tool(ctx, name).execute(args, exec) as TaskToolValue
  if ('code' in value) throw new Error(`${name} failed: ${value.code} ${value.message}`)
  return value
}

/** Run one tool call and narrow to its error value. */
async function fail(ctx: Context, name: string, args: unknown, exec = execOf()): Promise<TaskToolError> {
  const value = await tool(ctx, name).execute(args, exec) as TaskToolValue | TaskToolListValue
  if (!('code' in value)) throw new Error(`${name} unexpectedly succeeded`)
  return value
}

describe('tool-task', () => {
  it('registers the five tools and no approval tool', async () => {
    const { ctx } = await boot()
    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const name of ['task_create', 'task_claim', 'task_update', 'task_report', 'task_query']) {
      expect(names).toContain(name)
    }
    // approve/reject stay human-only: the tool face never registers them.
    expect(names).not.toContain('task_approve')
    expect(names).not.toContain('task_reject')
  })

  it('walks create → claim → update → block → unblock → submit with receipts', async () => {
    const { ctx } = await boot()
    const created = await ok(ctx, 'task_create', { objective: 'ship the ledger', acceptance: 'restart restores' })
    expect(created.status).toBe('todo')
    expect(created.holder).toBe(null)

    const listed = await tool(ctx, 'task_query').execute({ status: 'todo' }, execOf()) as TaskToolListValue
    if ('code' in listed) throw new Error(listed.code)
    expect(listed).toHaveLength(1)

    const claimed = await ok(ctx, 'task_claim', { task_id: created.id })
    expect(claimed.status).toBe('active')
    expect(claimed.holder).toBe(sessionId as never)
    expect(claimed.contextPack).toBe('')

    const types = session.events.map(event => event.type)
    expect(types).toContain('task/context-injected')
    expect(types).toContain('task/change')

    const updated = await ok(ctx, 'task_update', { task_id: created.id, revision: claimed.revision, note: 'wrote store', next: 'wire tools' })
    expect(updated.contextPack).toContain('wrote store')
    expect(updated.contextPack).toContain('(next: wire tools)')

    const blocked = await ok(ctx, 'task_report', {
      task_id: created.id, revision: updated.revision, outcome: 'blocked', reason: 'missing deploy key',
    })
    expect(blocked.status).toBe('blocked')
    expect(blocked.blockedReason?.message).toBe('missing deploy key')

    const unblocked = await ok(ctx, 'task_update', { task_id: created.id, revision: blocked.revision, note: 'key arrived' })
    expect(unblocked.status).toBe('active')
    expect(unblocked.blockedReason).toBeUndefined()

    const submitted = await ok(ctx, 'task_report', {
      task_id: created.id, revision: unblocked.revision, outcome: 'review', completion_note: 'restart restores the fold; criterion met',
    })
    expect(submitted.status).toBe('review')
  })

  it('maps the seam errors onto the closed tool union', async () => {
    const { ctx } = await boot()
    const created = await ok(ctx, 'task_create', { objective: 'o', acceptance: 'a' })
    expect((await fail(ctx, 'task_claim', { task_id: 'nope' })).code).toBe('not_found')
    expect((await fail(ctx, 'task_create', { objective: '  ', acceptance: 'a' })).code).toBe('invalid_objective')
    expect((await fail(ctx, 'task_query', { limit: 0 })).code).toBe('invalid_filter')

    const claimed = await ok(ctx, 'task_claim', { task_id: created.id })
    expect((await fail(ctx, 'task_claim', { task_id: created.id })).code).toBe('already_claimed')
    expect((await fail(ctx, 'task_update', { task_id: created.id, revision: claimed.revision - 1, note: 'x' })).code).toBe('stale_revision')
    expect((await fail(ctx, 'task_report', { task_id: created.id, revision: claimed.revision, outcome: 'blocked' })).code).toBe('invalid_reason')
    expect((await fail(ctx, 'task_report', { task_id: created.id, revision: claimed.revision, outcome: 'review' })).code).toBe('invalid_note')
    // A stranger session may not work a task this session holds.
    expect((await fail(ctx, 'task_update', { task_id: created.id, revision: claimed.revision, note: 'hi' }, execOf(strangerSession))).code).toBe('not_claimed')
  })

  it('disposes its registrations with the plugin fiber', async () => {
    const { ctx, toolFiber } = await boot()
    const names = () => ctx.tools.schemas().map(schema => schema.name)
    expect(names()).toContain('task_create')
    await toolFiber.dispose()
    expect(names()).not.toContain('task_create')
    expect(names()).not.toContain('task_query')
  })
})
