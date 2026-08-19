/**
 * Service tests over a real Cordis Context and a detached Session: the full
 * lifecycle, the dual-ledger receipts, compare-and-set, and wake rules.
 * @module @task-center/task/tests/service
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import { TaskService, TaskId, ProjectId } from '../src/index.ts'
import type { ProjectHandle, TaskHandle } from '../src/index.ts'
import type { TaskActor, TaskError, TaskMutation, TaskView } from '../src/types.ts'

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

/** Narrow a project result to its handle, failing on the error variant. */
function projectHandle(result: ProjectHandle | TaskError): ProjectHandle {
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
  it('registers its receipt event types with the persistence read path at construction', () => {
    const { service } = setup()
    expect(KNOWN_SESSION_EVENT_TYPES.has('task/change')).toBe(true)
    expect(KNOWN_SESSION_EVENT_TYPES.has('task/context-injected')).toBe(true)
    expect(service.list({})).toHaveLength(0)
  })

  it('walks create → claim → progress → submit → approve', async () => {
    const { ctx, service } = setup()
    const seen: string[] = []
    const mutations: TaskMutation[] = []
    ctx.on('task/changed', ({ operation, mutation }) => {
      seen.push(operation)
      mutations.push(mutation)
    })

    const taskId = await newTask(service)
    const session = Session.create(sessionId)
    expect(view(await service.claim(taskId, session, model)).record.holder).toBe(sessionId)

    const progressed = view(await service.mutate(taskId, 2, { operation: 'progress', note: 'first step' }, model, session))
    expect(progressed.record.contextPack).toContain('first step')

    expect(view(await service.mutate(taskId, progressed.record.revision, { operation: 'submit', completionNote: 'done' }, model, session)).record.status).toBe('review')
    expect(view(await service.mutate(taskId, 4, { operation: 'approve' }, human)).record.status).toBe('done')

    expect(seen).toEqual(['create', 'claim', 'progress', 'submit', 'approve'])
    // The payload carries the committing mutation verbatim — the rejection
    // push reads the reason from it, a field no view projection holds.
    expect(mutations[3]).toEqual({ operation: 'submit', completionNote: 'done' })
  })

  it('reads one task\'s committed history — mutations no view carries survive there', async () => {
    const { service } = setup()
    const taskId = await newTask(service)
    const session = Session.create(sessionId)
    await service.claim(taskId, session, model)
    await service.mutate(taskId, 2, { operation: 'submit', completionNote: 'done' }, model, session)
    await service.mutate(taskId, 3, { operation: 'reject', reason: '速度太快' }, human)

    const history = service.changes(taskId)
    expect(history.map(event => event.change.kind)).toEqual(['task/change', 'task/change', 'task/change', 'task/change'])
    // The boot reconciliation replays the latest verdict's reason verbatim.
    const last = history.at(-1)!
    expect(last.change.mutation).toEqual({ operation: 'reject', reason: '速度太快' })
    expect(service.changes(TaskId('no-such'))).toEqual([])
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

  it('groups tasks under human-managed projects with live reference checks', async () => {
    const { ctx, service } = setup()
    const seenOps: string[] = []
    ctx.on('project/changed', ({ operation }) => seenOps.push(operation))

    // Projects are human-managed: a model actor never creates one.
    expect(await service.projectCreate('发布', model)).toMatchObject({ code: 'PROJECT_FORBIDDEN' })
    const release = projectHandle(await service.projectCreate('发布', human))
    const research = projectHandle(await service.projectCreate('调研', human))
    expect(service.projects().map(p => p.record.name)).toEqual(['发布', '调研'])

    // Assignment at create, reassignment by edit, and the list filter.
    const inRelease = handle(await service.create({ objective: 'o1', acceptance: 'a', projectId: release.project.record.id }, human))
    expect(inRelease.task.record.projectId).toBe(release.project.record.id)
    const moved = view(await service.mutate(inRelease.task.record.id, inRelease.task.record.revision, { operation: 'edit', projectId: research.project.record.id }, human))
    expect(moved.record.projectId).toBe(research.project.record.id)
    expect(service.list({ projectId: research.project.record.id })).toHaveLength(1)
    expect(service.list({ projectId: release.project.record.id })).toHaveLength(0)

    // A null edit clears the assignment; a missing project is refused loudly.
    const cleared = view(await service.mutate(moved.record.id, moved.record.revision, { operation: 'edit', projectId: null }, human))
    expect(cleared.record.projectId).toBeUndefined()
    expect(await service.create({ objective: 'o2', acceptance: 'a', projectId: ProjectId('missing') }, human)).toMatchObject({ code: 'PROJECT_NOT_FOUND' })

    // Archiving closes a project to new assignment but keeps its tasks readable.
    const archived = await service.projectMutate(research.project.record.id, research.project.record.revision, { operation: 'project-archive' }, human)
    if ('code' in archived) throw new Error(archived.code)
    expect(archived.record.archived).toBe(true)
    expect(await service.create({ objective: 'o3', acceptance: 'a', projectId: research.project.record.id }, human)).toMatchObject({ code: 'PROJECT_ARCHIVED' })
    expect(service.project(research.project.record.id)?.record.archived).toBe(true)
    expect(seenOps).toEqual(['project-create', 'project-create', 'project-archive'])
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

describe('acceptance births', () => {
  const source: TaskActor = { kind: 'source' }
  const originSession = SessionId('s-done')

  /** Birth one acceptance task and return its view, failing on the error variant. */
  async function birth(service: TaskService, goalId = 'g-1', objective = '贪吃蛇做好了'): Promise<TaskView> {
    return view(await service.acceptanceCreate({
      objective,
      completionNote: '目标已在来源会话标记完成,其后无人回应;由抽取层提交,请人工验收',
      sessionId: originSession,
      goalId,
    }, source))
  }

  it('births straight into review, holderless, with the submission in the pack', async () => {
    const { service } = setup()
    const born = await birth(service)
    expect(born.record).toMatchObject({
      status: 'review',
      acceptance: '',
      origin: { sessionId: originSession, goalId: 'g-1' },
    })
    expect(born.record.holder).toBeUndefined()
    expect(born.record.contextPack).toContain('SUBMITTED: 目标已在来源会话标记完成')

    // Same origin never births twice; a different goal under the same session still may.
    expect(await service.acceptanceCreate({
      objective: '贪吃蛇做好了', completionNote: 'n', sessionId: originSession, goalId: 'g-1',
    }, source)).toMatchObject({ code: 'TASK_DUPLICATE_ORIGIN' })
    expect((await birth(service, 'g-2', '另一件')).record.origin).toMatchObject({ goalId: 'g-2' })
  })

  it('approve closes the ledger; reject returns a holderless birth to the claimable backlog', async () => {
    const { service } = setup()
    const born = await birth(service)
    expect(view(await service.mutate(born.record.id, born.record.revision, { operation: 'approve' }, human)).record.status).toBe('done')

    const second = await birth(service, 'g-2', '再做一件但被打回')
    const rejected = view(await service.mutate(second.record.id, second.record.revision, { operation: 'reject', reason: '样式不对' }, human))
    expect(rejected.record.status).toBe('todo')
    expect(rejected.record.holder).toBeUndefined()
    expect(rejected.record.contextPack).toContain('REJECTED: 样式不对')
    // Claim is legal only from todo, so the returned work is redoable at once.
    const session = Session.create(sessionId)
    expect(view(await service.claim(second.record.id, session, model)).record.status).toBe('active')
  })

  it('refuses every non-source path and the blank note', async () => {
    const { service } = setup()
    for (const actor of [human, model, { kind: 'wake' } as TaskActor]) {
      expect(await service.acceptanceCreate({
        objective: 'o', completionNote: 'n', sessionId: originSession, goalId: 'g-1',
      }, actor)).toMatchObject({ code: 'TASK_FORBIDDEN' })
    }
    expect(await service.acceptanceCreate({
      objective: 'o', completionNote: '   ', sessionId: originSession, goalId: 'g-1',
    }, source)).toMatchObject({ code: 'TASK_INVALID_NOTE' })
    expect(service.list({})).toHaveLength(0)
  })
})
