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
import { TaskId } from '@task-center/task'
import * as ToolTask from '../src/index.ts'
import type { TaskToolError, TaskToolListValue, TaskToolProjectListValue, TaskToolTask, TaskToolValue } from '../src/index.ts'

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
  it('registers the six work tools plus patrol, and no approval tool', async () => {
    const { ctx } = await boot()
    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const name of ['task_create', 'task_claim', 'task_update', 'task_report', 'task_patrol', 'task_query', 'task_projects']) {
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

  it('patrols: a stranger observes a held task without claiming or unshelving it', async () => {
    const { ctx } = await boot()
    const created = await ok(ctx, 'task_create', { objective: 'port the ledger', acceptance: 'restart restores' })
    const claimed = await ok(ctx, 'task_claim', { task_id: created.id })
    expect((await fail(ctx, 'task_patrol', { task_id: created.id, revision: claimed.revision, note: '   ' })).code).toBe('invalid_note')

    // Observation only: the shelving clock stays at the claim's instant
    // (claim itself is work and refreshes workedAt — pin that, not create).
    const workedAt = ctx.tasks.get(TaskId(created.id))!.record.workedAt
    // The stranger session holds nothing; the patrol still lands.
    const patrolled = await ok(ctx, 'task_patrol', {
      task_id: created.id, revision: claimed.revision, note: 'parked since the port', next: 'resume from the store split', blocker: 'quota window',
    }, execOf(strangerSession))
    expect(patrolled.status).toBe('active')
    expect(patrolled.holder).toBe(sessionId as never)
    expect(patrolled.contextPack).toContain('PATROL: parked since the port (next: resume from the store split) (blocked: quota window)')
    expect(ctx.tasks.get(TaskId(created.id))!.record.workedAt).toBe(workedAt)
    // Stale revisions refuse, like every write tool.
    expect((await fail(ctx, 'task_patrol', { task_id: created.id, revision: claimed.revision, note: 'again' }, execOf(strangerSession))).code).toBe('stale_revision')
  })

  it('delegates: create under a held parent, list children, withdraw on refused links', async () => {
    const { ctx } = await boot()
    const parent = await ok(ctx, 'task_create', { objective: 'parent outcome', acceptance: 'children done' })
    await ok(ctx, 'task_claim', { task_id: parent.id })
    const parentRevision = ctx.tasks.get(parent.id as never)!.record.revision

    const child = await ok(ctx, 'task_create', {
      objective: 'child outcome', acceptance: 'own criteria', parent_task_id: parent.id,
    })
    expect(child.status).toBe('todo')
    expect(ctx.tasks.get(parent.id as never)!.record.subtasks).toEqual([child.id as never])

    // The children listing projects the link from the parent side.
    const children = await tool(ctx, 'task_query').execute({ parent_task_id: parent.id }, execOf()) as TaskToolListValue
    if ('code' in children) throw new Error(children.code)
    expect(children).toHaveLength(1)
    expect(children[0]!.id).toBe(child.id)
    expect(children[0]!.subtasks).toEqual([])

    // A stranger session holds nothing: its link under the parent is refused
    // and the just-created child is withdrawn, not orphaned.
    const refused = await fail(ctx, 'task_create', {
      objective: 'stray', acceptance: 'x', parent_task_id: parent.id,
    }, execOf(strangerSession))
    // The parent is held by `session`, so a stranger may not decompose it.
    expect(refused.code).toBe('not_claimed')
    const afterRefusal = ctx.tasks.list({ includeArchived: true, limit: 100 })
    expect(afterRefusal.filter(view => view.record.objective === 'stray' && !view.archived)).toHaveLength(0)

    // A missing parent is not_found, and nothing is left behind either.
    expect((await fail(ctx, 'task_create', { objective: 'o2', acceptance: 'a2', parent_task_id: 'nope' })).code).toBe('not_found')
    expect(ctx.tasks.list({}).some(view => view.record.objective === 'o2')).toBe(false)

    // The parent's revision stayed at the claim while linking succeeded once.
    expect(ctx.tasks.get(parent.id as never)!.record.revision).toBe(parentRevision + 1)
    // A second session claims the child and works it independently of the parent.
    const childClaimed = await ok(ctx, 'task_claim', { task_id: child.id }, execOf(strangerSession))
    expect(childClaimed.holder).toBe(strangerId as never)
    await ok(ctx, 'task_update', { task_id: child.id, revision: childClaimed.revision, note: 'delegate worked' }, execOf(strangerSession))
  })

  it('assigns tasks to human-managed projects and filters by them', async () => {
    const { ctx } = await boot()
    // Projects are human-managed: seed one through the seam, not a tool.
    const created = await ctx.tasks.projectCreate('发布', { kind: 'human' })
    if ('code' in created) throw new Error(created.code)
    const projectId = created.project.record.id

    const projects = await tool(ctx, 'task_projects').execute({}, execOf()) as TaskToolProjectListValue
    if ('code' in projects) throw new Error(projects.code)
    expect(projects).toEqual([{ id: projectId, revision: 1, name: '发布', archived: false }])

    const task = await ok(ctx, 'task_create', { objective: 'o', acceptance: 'a', project_id: projectId })
    expect(task.projectId).toBe(projectId)

    const scoped = await tool(ctx, 'task_query').execute({ project_id: projectId }, execOf()) as TaskToolListValue
    if ('code' in scoped) throw new Error(scoped.code)
    expect(scoped).toHaveLength(1)
    expect(scoped[0]!.projectId).toBe(projectId)

    // Assignment failures map into the closed union and never create a task.
    expect((await fail(ctx, 'task_create', { objective: 'x', acceptance: 'y', project_id: 'nope' })).code).toBe('not_found')
    expect(ctx.tasks.list({}).some(view => view.record.objective === 'x')).toBe(false)
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
