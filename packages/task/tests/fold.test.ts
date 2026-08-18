/**
 * Pure state-machine tests: transition-table guards, authority rules, the
 * bounded context pack, and the replay fold's corruption checks.
 * @module @task-center/task/tests/fold
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { appendPackLine, applyCandidateMutation, applyMutation, applyProjectMutation, fold } from '../src/fold.ts'
import { CandidateId, ProjectId, TaskId } from '../src/index.ts'
import type { CandidateDomainEvent, CandidateMutation, CandidateRecord, ProjectMutation, ProjectRecord, TaskActor, TaskDomainEvent, TaskMutation, TaskRecord } from '../src/types.ts'

const packLimit = 1000
const actorHuman: TaskActor = { kind: 'human' }
const sessionId = SessionId('s1')
const actorModel: TaskActor = { kind: 'model', sessionId }

function create(): TaskMutation {
  return { operation: 'create', taskId: TaskId('t1'), objective: 'ship it', acceptance: 'tests pass' }
}

function apply(mutation: TaskMutation, record: TaskRecord | undefined, actor: TaskActor = actorModel): TaskRecord {
  const result = applyMutation(record, mutation, { actor, at: '2026-08-14T00:00:00Z', packByteLimit: packLimit })
  if ('error' in result) throw new Error(result.error.code)
  return result.ok
}

function applyProject(mutation: ProjectMutation, record: ProjectRecord | undefined, actor: TaskActor = actorHuman): ProjectRecord {
  const result = applyProjectMutation(record, mutation, { actor, at: '2026-08-14T00:00:00Z', packByteLimit: packLimit })
  if ('error' in result) throw new Error(result.error.code)
  return result.ok
}

/** Apply one project mutation expecting rejection, returning its code. */
function projectError(mutation: ProjectMutation, record: ProjectRecord | undefined, actor: TaskActor = actorHuman): string {
  const result = applyProjectMutation(record, mutation, { actor, at: '', packByteLimit: packLimit })
  return 'error' in result ? result.error.code : `unexpected success: ${result.ok.revision}`
}

function created() {
  return apply(create(), undefined, actorHuman)
}

/** A model actor for a session that holds nothing. */
function stranger() {
  return { kind: 'model', sessionId: 's2' as never } satisfies TaskActor
}

describe('transition guards', () => {
  it('create rejects empty objective and acceptance', () => {
    expect(applyMutation(undefined, { operation: 'create', taskId: TaskId('t'), objective: '  ', acceptance: 'x' }, { actor: actorHuman, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_INVALID_OBJECTIVE', message: expect.any(String) } })
    expect(applyMutation(undefined, { operation: 'create', taskId: TaskId('t'), objective: 'x', acceptance: '' }, { actor: actorHuman, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_INVALID_ACCEPTANCE', message: expect.any(String) } })
  })

  it('walks the happy path todo → active → review → done', () => {
    let record = created()
    record = apply({ operation: 'claim' }, record)
    expect(record.status).toBe('active')
    expect(record.holder).toBe(sessionId as never)
    record = apply({ operation: 'progress', note: 'did a thing', next: 'run the suite' }, record)
    expect(record.contextPack).toContain('did a thing')
    expect(record.contextPack).toContain('(next: run the suite)')
    record = apply({ operation: 'submit', completionNote: 'all green' }, record)
    expect(record.status).toBe('review')
    record = apply({ operation: 'approve' }, record, actorHuman)
    expect(record.status).toBe('done')
    expect(record.holder).toBeUndefined()
  })

  it('reject rejects empty reasons and writes the pack line', () => {
    let record = created()
    record = apply({ operation: 'claim' }, record)
    record = apply({ operation: 'submit', completionNote: 'done' }, record)
    const rejected = applyMutation(record, { operation: 'reject', reason: ' ' }, { actor: actorHuman, at: '2026-08-14T00:00:00Z', packByteLimit: packLimit })
    expect(rejected).toEqual({ error: { code: 'TASK_INVALID_REASON', message: expect.any(String) } })
    record = apply({ operation: 'reject', reason: 'tests still fail' }, record, actorHuman)
    expect(record.status).toBe('active')
    expect(record.contextPack).toContain('REJECTED: tests still fail')
  })

  it('enforces the authority matrix', () => {
    let record = created()
    record = apply({ operation: 'claim' }, record)
    record = apply({ operation: 'submit', completionNote: 'x' }, record)
    expect(applyMutation(record, { operation: 'approve' }, { actor: actorModel, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_FORBIDDEN', message: expect.any(String) } })
    // Human-only means human-only: mechanical actors never approve or reject.
    expect(applyMutation(record, { operation: 'approve' }, { actor: { kind: 'wake' }, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_FORBIDDEN', message: expect.any(String) } })
    expect(applyMutation(record, { operation: 'reject', reason: 'x' }, { actor: { kind: 'system' }, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_FORBIDDEN', message: expect.any(String) } })
  })

  it('pins mechanical actors to their own bookkeeping verbs', () => {
    let record = created()
    record = apply({ operation: 'claim' }, record)
    // The system actor releases dead holds and nothing else.
    const system = apply({ operation: 'release' }, record, { kind: 'system' })
    expect(system.status).toBe('todo')
    record = apply({ operation: 'claim' }, system)
    expect(applyMutation(record, { operation: 'progress', note: 'x' }, { actor: { kind: 'system' }, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_FORBIDDEN', message: expect.any(String) } })
    // The wake actor consumes occurrences and never works a task.
    expect(applyMutation(record, { operation: 'progress', note: 'x' }, { actor: { kind: 'wake' }, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_FORBIDDEN', message: expect.any(String) } })
    const woken = applyMutation(record, { operation: 'wake-set', rule: { kind: 'after', afterSeconds: 300 } }, { actor: { kind: 'wake' }, at: '', packByteLimit: packLimit })
    expect('error' in woken).toBe(false)
  })

  it('wake-set validates the rule and wake-clear removes it', () => {
    let record = created()
    expect(applyMutation(record, { operation: 'wake-set', rule: { kind: 'after', afterSeconds: 0 } }, { actor: actorHuman, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_WAKE_INVALID_RULE', message: expect.any(String) } })
    expect(applyMutation(record, { operation: 'wake-set', rule: { kind: 'at', scheduledAt: 'not-a-time' } }, { actor: actorHuman, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_WAKE_INVALID_RULE', message: expect.any(String) } })
    expect(applyMutation(record, { operation: 'wake-set', rule: { kind: 'every', everySeconds: 60, anchorAt: new Date().toISOString() } }, { actor: actorHuman, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_WAKE_INVALID_RULE', message: expect.any(String) } })
    record = apply({ operation: 'wake-set', rule: { kind: 'after', afterSeconds: 300 } }, record, actorHuman)
    expect(record.wakeRule).toEqual({ kind: 'after', afterSeconds: 300 })
    record = apply({ operation: 'wake-clear' }, record, actorHuman)
    expect(record.wakeRule).toBeUndefined()
  })

  it('non-holder model sessions cannot progress', () => {
    let record = created()
    record = apply({ operation: 'claim' }, record)
    const stranger: TaskActor = { kind: 'model', sessionId: 's2' as never }
    expect(applyMutation(record, { operation: 'progress', note: 'hi' }, { actor: stranger, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_NOT_CLAIMED', message: expect.any(String) } })
  })

  it('release frees the hold back to todo, holder-only for model actors', () => {
    let record = created()
    record = apply({ operation: 'claim' }, record)
    record = apply({ operation: 'release' }, record)
    expect(record.status).toBe('todo')
    expect(record.holder).toBeUndefined()
    expect(record.revision).toBe(3)

    // A stranger model session may not release someone else's hold.
    record = apply({ operation: 'claim' }, record)
    const stranger: TaskActor = { kind: 'model', sessionId: 's2' as never }
    expect(applyMutation(record, { operation: 'release' }, { actor: stranger, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_NOT_CLAIMED', message: expect.any(String) } })

    // Release also unblocks a blocked task, keeping the pack but clearing the blocked flag.
    record = apply({ operation: 'block', reason: { code: 'quota', message: 'window reset pending' } }, record)
    record = apply({ operation: 'release' }, record)
    expect(record.status).toBe('todo')
    expect(record.blockedReason).toBeUndefined()
    expect(record.contextPack).toContain('BLOCKED quota')
    // Human may release any held task.
    const humanReleased = apply({ operation: 'release' }, apply({ operation: 'claim' }, record), actorHuman)
    expect(humanReleased.holder).toBeUndefined()
  })

  it('subtask-add and subtask-remove maintain the child list with per-record guards', () => {
    const child = TaskId('c1')
    let record = created()
    record = apply({ operation: 'subtask-add', childId: child }, record, actorHuman)
    expect(record.subtasks).toEqual([child])
    // Duplicate link and unlink of a stranger both refuse, keeping the list exact.
    expect(applyMutation(record, { operation: 'subtask-add', childId: child }, { actor: actorHuman, at: '', packByteLimit: packLimit }))
      .toEqual({ error: { code: 'TASK_SUBTASK_DUPLICATE', message: expect.any(String) } })
    expect(applyMutation(record, { operation: 'subtask-remove', childId: TaskId('c2') }, { actor: actorHuman, at: '', packByteLimit: packLimit }))
      .toEqual({ error: { code: 'TASK_SUBTASK_NOT_CHILD', message: expect.any(String) } })
    // Decomposition closes during review, like edit.
    let reviewable = apply({ operation: 'claim' }, record)
    reviewable = apply({ operation: 'submit', completionNote: 'x' }, reviewable)
    expect(applyMutation(reviewable, { operation: 'subtask-add', childId: TaskId('c3') }, { actor: actorHuman, at: '', packByteLimit: packLimit }))
      .toEqual({ error: { code: 'TASK_INVALID_TRANSITION', message: expect.any(String) } })
    // A stranger model session may not decompose someone else's held task.
    const held = apply({ operation: 'claim' }, record)
    expect(applyMutation(held, { operation: 'subtask-add', childId: TaskId('c3') }, { actor: stranger(), at: '', packByteLimit: packLimit }))
      .toEqual({ error: { code: 'TASK_NOT_CLAIMED', message: expect.any(String) } })
    const removed = apply({ operation: 'subtask-remove', childId: child }, held, actorHuman)
    expect(removed.subtasks).toEqual([])
  })

  it('blocked resolves on the next progress', () => {
    let record = created()
    record = apply({ operation: 'claim' }, record)
    record = apply({ operation: 'block', reason: { code: 'WAIT_API', message: 'no key' } }, record)
    expect(record.status).toBe('blocked')
    expect(record.blockedReason?.code).toBe('WAIT_API')
    record = apply({ operation: 'progress', note: 'key arrived' }, record)
    expect(record.status).toBe('active')
    expect(record.blockedReason).toBeUndefined()
  })

  it('edit during review is illegal', () => {
    let record = created()
    record = apply({ operation: 'claim' }, record)
    record = apply({ operation: 'submit', completionNote: 'x' }, record)
    expect(applyMutation(record, { operation: 'edit', objective: 'new' }, { actor: actorHuman, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_INVALID_TRANSITION', message: expect.any(String) } })
  })

  it('progress auto-resolves blocked but block from todo is illegal', () => {
    const record = created()
    expect(applyMutation(record, { operation: 'block', reason: { code: 'X', message: 'y' } }, { actor: actorHuman, at: '', packByteLimit: packLimit })).toEqual({ error: { code: 'TASK_INVALID_TRANSITION', message: expect.any(String) } })
  })
})

describe('patrol', () => {
  /** Apply one mutation at an explicit instant (the shared helper pins `at`). */
  function at(mutation: TaskMutation, record: TaskRecord | undefined, actor: TaskActor, instant: string): TaskRecord {
    const result = applyMutation(record, mutation, { actor, at: instant, packByteLimit: packLimit })
    if ('error' in result) throw new Error(result.error.code)
    return result.ok
  }

  it('writes the observation line without touching status, holder, or workedAt', () => {
    let record = created()
    record = at({ operation: 'claim' }, record, actorModel, '2026-08-14T01:00:00Z')
    const patrolled = applyMutation(record, { operation: 'patrol', note: 'still shelved', next: 'resume the port', blocker: 'waits on vendor' }, { actor: stranger(), at: '2026-08-20T00:00:00Z', packByteLimit: packLimit })
    expect(patrolled).toEqual({
      ok: expect.objectContaining({
        status: 'active',
        holder: record.holder,
        workedAt: '2026-08-14T01:00:00Z',
        updatedAt: '2026-08-20T00:00:00Z',
      }),
    })
    if (!('ok' in patrolled)) throw new Error('narrowed')
    expect(patrolled.ok.contextPack).toContain('PATROL: still shelved (next: resume the port) (blocked: waits on vendor)')
  })

  it('is legal from every unfinished status, by any session, but not from done', () => {
    // todo → active → blocked → active → review each admit the observation; a
    // stranger session patrols a held task — patrol holds nothing.
    let record = created()
    for (const mutation of [
      { operation: 'patrol', note: 'fresh' },
      { operation: 'claim' },
      { operation: 'patrol', note: 'held and moving' },
      { operation: 'block', reason: { code: 'X', message: 'y' } },
      { operation: 'patrol', note: 'parked' },
      { operation: 'progress', note: 'unblocked' },
      { operation: 'submit', completionNote: 'done' },
      { operation: 'patrol', note: 'awaiting review' },
    ] as const) {
      record = at(mutation, record, actorModel, '2026-08-14T01:00:00Z')
    }
    expect(record.status).toBe('review')
    const approved = at({ operation: 'approve' }, record, actorHuman, '2026-08-14T02:00:00Z')
    expect(applyMutation(approved, { operation: 'patrol', note: 'finished' }, { actor: stranger(), at: '2026-08-14T03:00:00Z', packByteLimit: packLimit }))
      .toEqual({ error: { code: 'TASK_INVALID_TRANSITION', message: expect.any(String) } })
  })

  it('rejects empty notes and mechanical actors', () => {
    const record = created()
    expect(applyMutation(record, { operation: 'patrol', note: '  ' }, { actor: stranger(), at: '', packByteLimit: packLimit }))
      .toEqual({ error: { code: 'TASK_INVALID_NOTE', message: expect.any(String) } })
    expect(applyMutation(record, { operation: 'patrol', note: 'x' }, { actor: { kind: 'wake' }, at: '', packByteLimit: packLimit }))
      .toEqual({ error: { code: 'TASK_FORBIDDEN', message: expect.any(String) } })
    expect(applyMutation(record, { operation: 'patrol', note: 'x' }, { actor: { kind: 'system' }, at: '', packByteLimit: packLimit }))
      .toEqual({ error: { code: 'TASK_FORBIDDEN', message: expect.any(String) } })
  })

  it('keeps workedAt put across observations but refreshes it on work', () => {
    let record = created()
    expect(record.workedAt).toBe(record.createdAt)
    record = at({ operation: 'wake-set', rule: { kind: 'after', afterSeconds: 60 } }, record, actorModel, '2026-08-15T00:00:00Z')
    expect(record.workedAt).toBe(record.createdAt)
    record = at({ operation: 'patrol', note: 'no movement' }, record, stranger(), '2026-08-16T00:00:00Z')
    expect(record.workedAt).toBe(record.createdAt)
    record = at({ operation: 'claim' }, record, actorModel, '2026-08-16T12:00:00Z')
    expect(record.workedAt).toBe('2026-08-16T12:00:00Z')
    record = at({ operation: 'progress', note: 'actually moved' }, record, actorModel, '2026-08-17T00:00:00Z')
    expect(record.workedAt).toBe('2026-08-17T00:00:00Z')
  })
})

describe('bounded context pack', () => {
  it('drops over-budget heads with a marker', () => {
    let pack = ''
    for (let i = 0; i < 50; i++) pack = appendPackLine(pack, `entry number ${i} with some padding text`, 200)
    expect(Buffer.byteLength(pack)).toBeLessThanOrEqual(200)
    expect(pack.startsWith('…earlier entries omitted')).toBe(true)
    expect(pack).toContain('entry number 49')
  })

  it('keeps everything under the limit untouched', () => {
    expect(appendPackLine('a', 'b', 1000)).toBe('a\nb')
  })
})

describe('replay fold', () => {
  it('folds a committed stream back to the same records', () => {
    const events: TaskDomainEvent[] = []
    let revision = 0
    const emit = (mutation: TaskMutation, actor: TaskActor) => {
      const record = apply(mutation, events.length === 0 ? undefined : fold(events, packLimit).tasks.get(TaskId('t1'))!, actor)
      revision = record.revision
      events.push({
        eventId: `e${events.length}` as never,
        taskId: TaskId('t1'), revision, actor, at: '2026-08-14T00:00:00Z',
        change: { kind: 'task/change', version: 1, operation: mutation.operation, taskId: TaskId('t1'), revision, mutation, task: { record, blockedOverdue: false, archived: false } },
      })
    }
    emit(create(), actorHuman)
    emit({ operation: 'claim' }, actorModel)
    emit({ operation: 'progress', note: 'step' }, actorModel)
    const { tasks, archivedTasks } = fold(events, packLimit)
    expect(tasks.get(TaskId('t1'))?.status).toBe('active')
    expect(tasks.get(TaskId('t1'))?.contextPack).toContain('step')
    expect(archivedTasks.has(TaskId('t1'))).toBe(false)
    emit({ operation: 'abandon' }, actorHuman)
    expect(fold(events, packLimit).archivedTasks.has(TaskId('t1'))).toBe(true)
  })

  it('fails loud on a revision gap', () => {
    const record = created()
    const event: TaskDomainEvent = {
      eventId: 'e1' as never, taskId: TaskId('t1'), revision: 3, actor: actorHuman, at: '',
      change: { kind: 'task/change', version: 1, operation: 'create', taskId: TaskId('t1'), revision: 3, mutation: create(), task: { record, blockedOverdue: false, archived: false } },
    }
    expect(() => fold([event], packLimit)).toThrow(/revision 3, expected 1/)
  })

  it('fails loud on a dangling project reference', () => {
    const mutation = { operation: 'create' as const, taskId: TaskId('t1'), objective: 'o', acceptance: 'a', projectId: ProjectId('p-missing') }
    const record = apply(mutation, undefined, actorHuman)
    const event: TaskDomainEvent = {
      eventId: 'e1' as never, taskId: TaskId('t1'), revision: 1, actor: actorHuman, at: '',
      change: { kind: 'task/change', version: 1, operation: 'create', taskId: TaskId('t1'), revision: 1, mutation, task: { record, blockedOverdue: false, archived: false } },
    }
    expect(() => fold([event], packLimit)).toThrow(/missing project/)
  })
})

describe('project mutations', () => {
  const createProject = (): ProjectMutation => ({ operation: 'project-create', projectId: ProjectId('p1'), name: '发布' })

  it('creates, renames, and archives with the archived flag', () => {
    const created = applyProject(createProject(), undefined)
    expect(created).toMatchObject({ revision: 1, name: '发布', archived: false })
    const renamed = applyProject({ operation: 'project-rename', name: '季度发布' }, created)
    expect(renamed).toMatchObject({ revision: 2, name: '季度发布', archived: false })
    const archived = applyProject({ operation: 'project-archive' }, renamed)
    expect(archived).toMatchObject({ revision: 3, archived: true })
    // An archived project is closed: rename and archive both refuse.
    expect(projectError({ operation: 'project-rename', name: 'x' }, archived)).toBe('PROJECT_ARCHIVED')
    expect(projectError({ operation: 'project-archive' }, archived)).toBe('PROJECT_ARCHIVED')
  })

  it('keeps projects human-only and validates names', () => {
    expect(projectError(createProject(), undefined, actorModel)).toBe('PROJECT_FORBIDDEN')
    expect(projectError(createProject(), undefined, { kind: 'system' })).toBe('PROJECT_FORBIDDEN')
    expect(projectError({ operation: 'project-create', projectId: ProjectId('p2'), name: '  ' }, undefined)).toBe('PROJECT_INVALID_NAME')
    expect(projectError({ operation: 'project-rename', name: 'x' }, undefined)).toBe('PROJECT_NOT_FOUND')
    expect(projectError(createProject(), applyProject(createProject(), undefined))).toBe('PROJECT_ALREADY_EXISTS')
  })

  it('carries a task project reference through create and edit', () => {
    const project = applyProject(createProject(), undefined)
    let record = apply({ operation: 'create', taskId: TaskId('t1'), objective: 'o', acceptance: 'a', projectId: project.id }, undefined, actorHuman)
    expect(record.projectId).toBe(project.id)
    // The fold carries edit reassignment without judging existence (the service commit does).
    const moved = apply({ operation: 'edit', projectId: ProjectId('p-other') }, record, actorHuman)
    expect(moved.projectId).toBe(ProjectId('p-other'))
    expect(apply({ operation: 'edit', projectId: null }, moved, actorHuman).projectId).toBeUndefined()
  })
})

describe('candidate mutations', () => {
  const actorSource: TaskActor = { kind: 'source' }
  const birth = (): Extract<CandidateMutation, { operation: 'candidate-create' }> => ({
    operation: 'candidate-create', candidateId: CandidateId('c1'), objective: '支持暗色模式',
    note: 'goal 未完结,blocker: 颜色令牌未定',
    origin: { sessionId, tier: 'goal', key: 'g-1' },
  })

  function applyCandidate(mutation: CandidateMutation, record: CandidateRecord | undefined, actor: TaskActor = actorSource): CandidateRecord {
    const result = applyCandidateMutation(record, mutation, { actor, at: '2026-08-14T00:00:00Z', packByteLimit: packLimit })
    if ('error' in result) throw new Error(result.error.code)
    return result.ok
  }

  /** Apply one candidate mutation expecting rejection, returning its code. */
  function candidateError(mutation: CandidateMutation, record: CandidateRecord | undefined, actor: TaskActor = actorSource): string {
    const result = applyCandidateMutation(record, mutation, { actor, at: '', packByteLimit: packLimit })
    return 'error' in result ? result.error.code : `unexpected success: ${result.ok.revision}`
  }

  it('walks create → promote with the task link, and ignores', () => {
    const created = applyCandidate(birth(), undefined)
    expect(created).toMatchObject({ revision: 1, status: 'pending', objective: '支持暗色模式', acceptance: '' })
    const promoted = applyCandidate({ operation: 'candidate-promote', acceptance: '切换后全部界面生效', taskId: TaskId('t9') }, created, actorHuman)
    expect(promoted).toMatchObject({ revision: 2, status: 'promoted', promotedTaskId: TaskId('t9') })
    // Terminal: no verb lands after promote.
    expect(candidateError({ operation: 'candidate-ignore' }, promoted, actorHuman)).toBe('CANDIDATE_INVALID_TRANSITION')
    const fresh = applyCandidate({ ...birth(), candidateId: CandidateId('c2'), origin: { sessionId, tier: 'goal', key: 'g-2' } }, undefined)
    expect(applyCandidate({ operation: 'candidate-ignore' }, fresh, actorHuman).status).toBe('ignored')
  })

  it('pins authority: source births and supersedes, humans promote and ignore', () => {
    expect(candidateError(birth(), undefined, actorHuman)).toBe('CANDIDATE_FORBIDDEN')
    expect(candidateError(birth(), undefined, actorModel)).toBe('CANDIDATE_FORBIDDEN')
    const created = applyCandidate(birth(), undefined)
    expect(candidateError({ operation: 'candidate-promote', acceptance: 'x', taskId: TaskId('t') }, created, actorSource)).toBe('CANDIDATE_FORBIDDEN')
    expect(candidateError({ operation: 'candidate-ignore' }, created, actorSource)).toBe('CANDIDATE_FORBIDDEN')
    expect(candidateError({ operation: 'candidate-ignore' }, created, actorModel)).toBe('CANDIDATE_FORBIDDEN')
    expect(candidateError({ operation: 'candidate-supersede', reason: 'goal completed' }, created, actorHuman)).toBe('CANDIDATE_FORBIDDEN')
    expect(applyCandidate({ operation: 'candidate-supersede', reason: 'goal completed' }, created).status).toBe('superseded')
  })

  it('validates fields and refuses re-create', () => {
    expect(candidateError({ ...birth(), objective: '  ' }, undefined)).toBe('CANDIDATE_INVALID_OBJECTIVE')
    expect(candidateError({ ...birth(), origin: { sessionId, tier: 'goal', key: ' ' } }, undefined)).toBe('CANDIDATE_INVALID_OBJECTIVE')
    const created = applyCandidate(birth(), undefined)
    expect(candidateError({ operation: 'candidate-promote', acceptance: '  ', taskId: TaskId('t') }, created, actorHuman)).toBe('CANDIDATE_INVALID_ACCEPTANCE')
    expect(candidateError({ operation: 'candidate-supersede', reason: '' }, created)).toBe('CANDIDATE_INVALID_REASON')
    expect(candidateError(birth(), created)).toBe('CANDIDATE_ALREADY_EXISTS')
    expect(candidateError({ operation: 'candidate-ignore' }, undefined)).toBe('CANDIDATE_NOT_FOUND')
  })

  it('keeps the source actor off tasks and carries task origin', () => {
    expect(applyMutation(undefined, create(), { actor: actorSource, at: '', packByteLimit: packLimit }))
      .toEqual({ error: { code: 'TASK_FORBIDDEN', message: expect.any(String) } })
    const origin = { candidateId: CandidateId('c1'), sessionId }
    const record = apply({ operation: 'create', taskId: TaskId('t1'), objective: 'o', acceptance: 'a', origin }, undefined, actorHuman)
    expect(record.origin).toEqual(origin)
  })

  it('folds a candidate stream beside tasks with independent revisions', () => {
    const events: (TaskDomainEvent | CandidateDomainEvent)[] = []
    const emitCandidate = (mutation: CandidateMutation, actor: TaskActor) => {
      const record = applyCandidate(mutation, events.length === 0 ? undefined : fold(events, packLimit).candidates.get(CandidateId('c1'))!, actor)
      events.push({
        eventId: `c${events.length}` as never,
        candidateId: CandidateId('c1'), revision: record.revision, actor, at: '2026-08-14T00:00:00Z',
        change: { kind: 'candidate/change', version: 1, operation: mutation.operation, candidateId: CandidateId('c1'), revision: record.revision, mutation, candidate: { record } },
      })
    }
    emitCandidate(birth(), actorSource)
    const taskRecord = apply(create(), undefined, actorHuman)
    events.push({
      eventId: 't0' as never, taskId: TaskId('t1'), revision: 1, actor: actorHuman, at: '',
      change: { kind: 'task/change', version: 1, operation: 'create', taskId: TaskId('t1'), revision: 1, mutation: create(), task: { record: taskRecord, blockedOverdue: false, archived: false } },
    })
    emitCandidate({ operation: 'candidate-promote', acceptance: '验收', taskId: TaskId('t1') }, actorHuman)
    const folded = fold(events, packLimit)
    expect(folded.candidates.get(CandidateId('c1'))?.status).toBe('promoted')
    expect(folded.tasks.get(TaskId('t1'))?.revision).toBe(1)
  })
})
