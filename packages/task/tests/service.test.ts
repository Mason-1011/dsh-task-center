/**
 * Service tests over a real Cordis Context and a detached Session: the full
 * lifecycle, the dual-ledger receipts, compare-and-set, and wake rules.
 * @module @task-center/task/tests/service
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TaskService, TaskId } from '../src/index.ts'
import type { TaskHandle } from '../src/index.ts'
import type { TaskActor, TaskError, TaskView } from '../src/types.ts'

function setup(): { ctx: Context; service: TaskService } {
  const ctx = new Context()
  const service = new TaskService(ctx, { contextPackByteLimit: 1000, listDefaultLimit: 20 })
  return { ctx, service }
}

/** Narrow a service result to its handle, failing on the error variant. */
function handle(result: TaskHandle | TaskError): TaskHandle {
  if ('code' in result) throw new Error(result.code)
  return result
}

/** Narrow a service result to its view, failing on the error variant. */
function view(result: TaskView | TaskError): TaskView {
  if ('code' in result) throw new Error(result.code)
  return result
}

const human: TaskActor = { kind: 'human' }
const sessionId = SessionId('s-1')
const model: TaskActor = { kind: 'model', sessionId }

/** Create one task and return its id. */
async function newTask(service: TaskService): Promise<TaskId> {
  return handle(await service.create({ objective: 'o', acceptance: 'a' }, human)).task.record.id
}

describe('TaskService lifecycle', () => {
  it('walks create → claim → progress → submit → approve', async () => {
    const { ctx, service } = setup()
    const seen: string[] = []
    ctx.on('task/changed', ({ operation }) => seen.push(operation))

    const taskId = await newTask(service)
    const session = Session.create(sessionId)
    expect(view(await service.claim(taskId, session, model)).record.holder).toBe(sessionId)

    const progressed = view(await service.mutate(taskId, 2, { operation: 'progress', note: 'first step' }, model, session))
    expect(progressed.record.contextPack).toContain('first step')

    expect(view(await service.mutate(taskId, progressed.record.revision, { operation: 'submit', completionNote: 'done' }, model, session)).record.status).toBe('review')
    expect(view(await service.mutate(taskId, 4, { operation: 'approve' }, human)).record.status).toBe('done')

    expect(seen).toEqual(['create', 'claim', 'progress', 'submit', 'approve'])
  })

  it('writes both ledger receipts for model mutations', async () => {
    const { service } = setup()
    const taskId = await newTask(service)
    const session = Session.create(sessionId)
    await service.claim(taskId, session, model)
    await service.mutate(taskId, 2, { operation: 'progress', note: 'x' }, model, session)

    const types = session.events.map(event => event.type)
    expect(types).toContain('task/context-injected')
    expect(types).toContain('task/change')
    const claimReceipt = session.events.find(event => event.type === 'task/context-injected')
    expect(claimReceipt?.data).toMatchObject({ taskId, version: 1 })
  })

  it('rejects stale revisions and human-only operations by model actors', async () => {
    const { service } = setup()
    const taskId = await newTask(service)
    const session = Session.create(sessionId)
    await service.claim(taskId, session, model)

    expect(await service.mutate(taskId, 1, { operation: 'progress', note: 'x' }, model, session)).toMatchObject({ code: 'TASK_STALE_REVISION' })

    await service.mutate(taskId, 2, { operation: 'submit', completionNote: 'y' }, model, session)
    expect(await service.mutate(taskId, 3, { operation: 'approve' }, model, session)).toMatchObject({ code: 'TASK_FORBIDDEN' })
  })

  it('filters lists and hides archived tasks by default', async () => {
    const { service } = setup()
    await service.create({ objective: 'a', acceptance: 'x', workspaceIds: ['w1'] }, human)
    await service.create({ objective: 'b', acceptance: 'x', workspaceIds: ['w2'] }, human)
    expect(service.list({ workspaceId: 'w1' })).toHaveLength(1)

    const first = service.list({})[0]!
    expect(view(await service.mutate(first.record.id, first.record.revision, { operation: 'abandon' }, human)).archived).toBe(true)
    expect(service.list({})).toHaveLength(1)
    expect(service.list({ includeArchived: true })).toHaveLength(2)
  })

  it('reports due wake rules by target time and skips done tasks', async () => {
    const { service } = setup()
    const taskId = await newTask(service)
    // 'after 1' targets one second past creation: not yet due.
    await service.mutate(taskId, 1, { operation: 'wake-set', rule: { kind: 'after', afterSeconds: 1 } }, human)
    expect(service.wakeRules()).toHaveLength(0)

    // An 'every' anchored in the past is due exactly until its anchor advances.
    let current = service.get(taskId)!
    await service.mutate(taskId, current.record.revision, { operation: 'wake-set', rule: { kind: 'every', everySeconds: 300, anchorAt: new Date(Date.now() - 600_000).toISOString() } }, human)
    const due = service.wakeRules()
    expect(due).toHaveLength(1)
    expect(due[0]!.rule.kind).toBe('every')
    // Advancing the anchor one interval past now clears the due state.
    current = service.get(taskId)!
    const advanced = { kind: 'every' as const, everySeconds: 300, anchorAt: new Date(Date.now() + 300_000).toISOString() }
    await service.mutate(taskId, current.record.revision, { operation: 'wake-set', rule: advanced }, { kind: 'wake' })
    expect(service.wakeRules()).toHaveLength(0)

    const session = Session.create(sessionId)
    await service.claim(taskId, session, model)
    const claimedRevision = service.get(taskId)!.record.revision
    const submitted = view(await service.mutate(taskId, claimedRevision, { operation: 'submit', completionNote: 'z' }, model, session))
    await service.mutate(taskId, submitted.record.revision, { operation: 'approve' }, human)
    expect(service.wakeRules()).toHaveLength(0)
  })

  it('handle disposal abandons the task', async () => {
    const { service } = setup()
    const created = handle(await service.create({ objective: 'o', acceptance: 'a' }, human))
    await created.dispose()
    expect(created.task.record.id && service.list({ includeArchived: true })[0]!.archived).toBe(true)
    expect(service.list({})).toHaveLength(0)
  })

  it('links subtasks with cross-record guards and aggregates children', async () => {
    const { service } = setup()
    const parent = await newTask(service)
    const child = await newTask(service)
    const grandchild = await newTask(service)

    expect(view(await service.mutate(parent, 1, { operation: 'subtask-add', childId: child }, human)).record.subtasks).toEqual([child])
    await service.mutate(child, 1, { operation: 'subtask-add', childId: grandchild }, human)

    // The parent is reachable from the child: linking backwards is a cycle.
    expect(await service.mutate(child, 2, { operation: 'subtask-add', childId: parent }, human)).toMatchObject({ code: 'TASK_SUBTASK_CYCLE' })
    expect(await service.mutate(parent, 2, { operation: 'subtask-add', childId: parent }, human)).toMatchObject({ code: 'TASK_SUBTASK_SELF' })
    expect(await service.mutate(parent, 2, { operation: 'subtask-add', childId: TaskId('missing') }, human)).toMatchObject({ code: 'TASK_NOT_FOUND' })

    // Parent-side aggregation sees linked children with live status.
    const session = Session.create(SessionId('s-child'))
    await service.claim(child, session, { kind: 'model', sessionId: SessionId('s-child') })
    const children = service.children(parent)
    expect(children.map(c => c.record.id)).toEqual([child])
    expect(children[0]!.record.status).toBe('active')

    // Unlinking keeps the parent's own state untouched.
    expect(view(await service.mutate(parent, 2, { operation: 'subtask-remove', childId: child }, human)).record.subtasks).toEqual([])
    expect(service.children(parent)).toEqual([])
  })
})
