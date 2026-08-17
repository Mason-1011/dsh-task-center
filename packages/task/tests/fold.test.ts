/**
 * Pure state-machine tests: transition-table guards, authority rules, the
 * bounded context pack, and the replay fold's corruption checks.
 * @module @task-center/task/tests/fold
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { appendPackLine, applyMutation, foldTasks } from '../src/fold.ts'
import { TaskId } from '../src/index.ts'
import type { TaskActor, TaskDomainEvent, TaskMutation, TaskRecord } from '../src/types.ts'

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

function created() {
  return apply(create(), undefined, actorHuman)
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
      const record = apply(mutation, events.length === 0 ? undefined : foldTasks(events, packLimit).records.get(TaskId('t1'))!, actor)
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
    const { records, archived } = foldTasks(events, packLimit)
    expect(records.get(TaskId('t1'))?.status).toBe('active')
    expect(records.get(TaskId('t1'))?.contextPack).toContain('step')
    expect(archived.has(TaskId('t1'))).toBe(false)
    emit({ operation: 'abandon' }, actorHuman)
    expect(foldTasks(events, packLimit).archived.has(TaskId('t1'))).toBe(true)
  })

  it('fails loud on a revision gap', () => {
    const record = created()
    const event: TaskDomainEvent = {
      eventId: 'e1' as never, taskId: TaskId('t1'), revision: 3, actor: actorHuman, at: '',
      change: { kind: 'task/change', version: 1, operation: 'create', taskId: TaskId('t1'), revision: 3, mutation: create(), task: { record, blockedOverdue: false, archived: false } },
    }
    expect(() => foldTasks([event], packLimit)).toThrow(/revision 3, expected 1/)
  })
})
