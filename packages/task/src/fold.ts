/**
 * Pure task state machine: the transition table, the mutation application,
 * and the domain-event replay fold. No Cordis, no I/O — the live service and
 * the replay fold share this module as the single source of transition truth.
 * Spec: docs/design/05-seam-spec.md §1 and §3.
 * @module @task-center/task/fold
 */

import type {
  TaskDomainEvent,
  TaskError,
  TaskId,
  TaskMutation,
  TaskOperation,
  TaskRecord,
  TaskStatus,
  WakeRule,
} from './types.ts'

/** One transition-table row. */
interface TransitionRule {
  /** Statuses the operation is legal from. */
  readonly from: readonly TaskStatus[]
  /** Resulting status; 'same' keeps it, 'archive' keeps it and archives the task. */
  readonly to: TaskStatus | 'same' | 'archive'
}

/** The closed transition table (05 §1). */
export const TRANSITIONS: Readonly<Record<TaskOperation, TransitionRule>> = {
  create: { from: ['todo'], to: 'same' },
  claim: { from: ['todo'], to: 'active' },
  progress: { from: ['active', 'blocked'], to: 'active' },
  block: { from: ['active'], to: 'blocked' },
  submit: { from: ['active'], to: 'review' },
  approve: { from: ['review'], to: 'done' },
  reject: { from: ['review'], to: 'active' },
  release: { from: ['active', 'blocked'], to: 'todo' },
  'subtask-add': { from: ['todo', 'active', 'blocked'], to: 'same' },
  'subtask-remove': { from: ['todo', 'active', 'blocked'], to: 'same' },
  abandon: { from: ['todo', 'active', 'blocked', 'review'], to: 'archive' },
  edit: { from: ['todo', 'active', 'blocked', 'done'], to: 'same' },
  'wake-set': { from: ['todo', 'active', 'blocked', 'done'], to: 'same' },
  'wake-clear': { from: ['todo', 'active', 'blocked', 'done'], to: 'same' },
}

/** Guard verdict: either the next record or a stable error code. */
export type TransitionResult = { readonly ok: TaskRecord } | { readonly error: TaskError }

const encoder = new TextEncoder()

/** UTF-8 byte length of one string. */
function byteLength(value: string): number {
  return encoder.encode(value).length
}

/** Lower bound for a fixed-rate interval, mirroring dsh-schedule's v1 floor. */
export const MIN_EVERY_INTERVAL_SECONDS = 300

/**
 * Validate one wake rule at the seam boundary.
 * @param rule - candidate rule from any actor.
 * @returns the rejection message, or `undefined` when the rule is durable.
 */
export function checkWakeRule(rule: WakeRule): string | undefined {
  if (rule.kind === 'after') {
    if (!Number.isSafeInteger(rule.afterSeconds) || rule.afterSeconds <= 0) {
      return 'after requires a positive safe-integer delay in seconds'
    }
    return undefined
  }
  if (rule.kind === 'at') {
    if (Number.isNaN(Date.parse(rule.scheduledAt))) return 'at requires a parseable ISO-8601 instant'
    return undefined
  }
  if (!Number.isSafeInteger(rule.everySeconds) || rule.everySeconds < MIN_EVERY_INTERVAL_SECONDS) {
    return `every requires a safe-integer interval of at least ${MIN_EVERY_INTERVAL_SECONDS} seconds`
  }
  if (Number.isNaN(Date.parse(rule.anchorAt))) return 'every requires a parseable ISO-8601 anchor'
  return undefined
}

/** Bounded context-pack append. Over-budget heads are dropped with a marker line. */
export function appendPackLine(pack: string, line: string, byteLimit: number): string {
  const candidate = pack.length === 0 ? line : `${pack}\n${line}`
  if (byteLength(candidate) <= byteLimit) return candidate
  const marker = '…earlier entries omitted'
  let cut = candidate.length
  while (cut > 0 && byteLength(candidate.slice(cut)) + marker.length + 1 > byteLimit) cut--
  return `${marker}\n${candidate.slice(cut)}`
}

/** Mutable draft of an immutable record, for building the next state. */
type Draft<T> = { -readonly [K in keyof T]: T[K] }

function error(code: TaskError['code'], message: string): { error: TaskError } {
  return { error: { code, message } }
}

/** Inputs the pure application needs beyond the mutation itself. */
export interface ApplyContext {
  /** Actor performing the mutation; approve/reject reject model actors. */
  readonly actor: TaskDomainEvent['actor']
  /** ISO-8601 commit timestamp. */
  readonly at: string
  /** Context-pack byte limit, enforced on the complete value. */
  readonly packByteLimit: number
}

/**
 * Apply one mutation to one task record (undefined for `create`). Pure: same
 * inputs give the same next record or the same stable error. The live service
 * calls this after compare-and-set; the fold calls it and throws on error.
 */
export function applyMutation(record: TaskRecord | undefined, mutation: TaskMutation, context: ApplyContext): TransitionResult {
  const { actor } = context
  if (record === undefined) {
    if (mutation.operation !== 'create') return error('TASK_NOT_FOUND', 'task does not exist')
    if (mutation.objective.trim() === '') return error('TASK_INVALID_OBJECTIVE', 'objective must not be empty')
    if (mutation.acceptance.trim() === '') return error('TASK_INVALID_ACCEPTANCE', 'acceptance must not be empty')
    return { ok: {
      id: mutation.taskId,
      revision: 1,
      objective: mutation.objective,
      acceptance: mutation.acceptance,
      status: 'todo',
      workspaceIds: [...mutation.workspaceIds ?? []],
      sessionIds: [],
      contextPack: '',
      subtasks: [],
      createdAt: context.at,
      updatedAt: context.at,
    } }
  }
  const humanOnly: readonly TaskOperation[] = ['approve', 'reject']
  if (humanOnly.includes(mutation.operation) && actor.kind !== 'human') {
    return error('TASK_FORBIDDEN', 'approve and reject are human-only operations')
  }
  // Mechanical actors are structurally pinned to their own bookkeeping: the
  // system actor releases dead holds (liveness is judged by the caller, outside
  // the ledger), the wake actor consumes occurrences. Neither ever works a task.
  if (actor.kind === 'system' && mutation.operation !== 'release') {
    return error('TASK_FORBIDDEN', 'the system actor may only release dead holds')
  }
  const wakeOps: readonly TaskOperation[] = ['wake-set', 'wake-clear']
  if (actor.kind === 'wake' && !wakeOps.includes(mutation.operation)) {
    return error('TASK_FORBIDDEN', 'the wake actor may only perform wake bookkeeping')
  }
  // 'already claimed' subsumes 'not legal from todo': a held task is never in todo.
  if (mutation.operation === 'claim' && record.holder !== undefined) {
    return error('TASK_ALREADY_CLAIMED', 'task already has a live holder')
  }
  const rule = TRANSITIONS[mutation.operation]
  if (!rule.from.includes(record.status)) {
    return error('TASK_INVALID_TRANSITION', `${mutation.operation} is not legal from status ${record.status}`)
  }
  if (mutation.operation === 'edit' && record.status === 'review') {
    return error('TASK_INVALID_TRANSITION', 'edit requires leaving review first (approve or reject)')
  }
  if (record.holder !== undefined && actor.kind === 'model' && actor.sessionId !== record.holder
      && (mutation.operation === 'progress' || mutation.operation === 'block' || mutation.operation === 'submit' || mutation.operation === 'release'
        || mutation.operation === 'subtask-add' || mutation.operation === 'subtask-remove')) {
    return error('TASK_NOT_CLAIMED', 'only the holding session may progress, block, submit, release, or decompose')
  }
  const next: Draft<TaskRecord> = { ...record, revision: record.revision + 1, updatedAt: context.at }
  switch (mutation.operation) {
    case 'claim': {
      next.status = 'active'
      if (actor.kind === 'model') {
        next.holder = actor.sessionId
        next.sessionIds = [...record.sessionIds, actor.sessionId]
      }
      break
    }
    case 'progress': {
      if (mutation.note.trim() === '') return error('TASK_INVALID_NOTE', 'note must not be empty')
      next.status = 'active'
      delete next.blockedReason
      const planned = mutation.next !== undefined && mutation.next.trim() !== '' ? ` (next: ${mutation.next})` : ''
      next.contextPack = appendPackLine(record.contextPack, `- ${context.at} ${mutation.note}${planned}`, context.packByteLimit)
      break
    }
    case 'block': {
      if (mutation.reason.code.trim() === '' || mutation.reason.message.trim() === '') {
        return error('TASK_INVALID_REASON', 'block requires a structured reason')
      }
      next.status = 'blocked'
      next.blockedReason = mutation.reason
      next.contextPack = appendPackLine(record.contextPack, `- ${context.at} BLOCKED ${mutation.reason.code}: ${mutation.reason.message}`, context.packByteLimit)
      break
    }
    case 'submit': {
      if (mutation.completionNote.trim() === '') return error('TASK_INVALID_NOTE', 'submit requires a completion note')
      next.status = 'review'
      next.contextPack = appendPackLine(record.contextPack, `- ${context.at} SUBMITTED: ${mutation.completionNote}`, context.packByteLimit)
      break
    }
    case 'approve': {
      next.status = 'done'
      delete next.holder
      break
    }
    case 'reject': {
      if (mutation.reason.trim() === '') return error('TASK_INVALID_REASON', 'reject requires a reason')
      next.status = 'active'
      next.contextPack = appendPackLine(record.contextPack, `- ${context.at} REJECTED: ${mutation.reason}`, context.packByteLimit)
      break
    }
    case 'edit': {
      if (mutation.objective !== undefined) {
        if (mutation.objective.trim() === '') return error('TASK_INVALID_OBJECTIVE', 'objective must not be empty')
        next.objective = mutation.objective
      }
      if (mutation.acceptance !== undefined) {
        if (mutation.acceptance.trim() === '') return error('TASK_INVALID_ACCEPTANCE', 'acceptance must not be empty')
        next.acceptance = mutation.acceptance
      }
      break
    }
    case 'wake-set': {
      const rejected = checkWakeRule(mutation.rule)
      if (rejected !== undefined) return error('TASK_WAKE_INVALID_RULE', rejected)
      next.wakeRule = mutation.rule
      break
    }
    case 'wake-clear': {
      delete next.wakeRule
      break
    }
    case 'release': {
      next.status = 'todo'
      delete next.holder
      delete next.blockedReason
      break
    }
    case 'subtask-add': {
      if (record.subtasks.includes(mutation.childId)) {
        return error('TASK_SUBTASK_DUPLICATE', 'child is already linked to this task')
      }
      next.subtasks = [...record.subtasks, mutation.childId]
      break
    }
    case 'subtask-remove': {
      if (!record.subtasks.includes(mutation.childId)) {
        return error('TASK_SUBTASK_NOT_CHILD', 'child is not linked to this task')
      }
      next.subtasks = record.subtasks.filter(id => id !== mutation.childId)
      break
    }
    case 'abandon': {
      delete next.holder
      break
    }
  }
  return { ok: next }
}

/** Replay fold outcome. */
export interface FoldedTasks {
  readonly records: ReadonlyMap<TaskId, TaskRecord>
  readonly archived: ReadonlySet<TaskId>
}

/**
 * Fold the authoritative domain event stream. Fails loud on a corrupt stream:
 * a revision gap, an unknown-task mutation, or a transition the table rejects.
 * This is the invariant basis — `TaskRecord` equals this fold over the stream.
 */
export function foldTasks(events: readonly TaskDomainEvent[], packByteLimit: number): FoldedTasks {
  const records = new Map<TaskId, TaskRecord>()
  const archived = new Set<TaskId>()
  const lastRevision = new Map<TaskId, number>()
  for (const event of events) {
    const record = records.get(event.taskId)
    const expected = (lastRevision.get(event.taskId) ?? 0) + 1
    if (event.revision !== expected) {
      throw new Error(`corrupt task stream: ${event.taskId} revision ${event.revision}, expected ${expected}`)
    }
    const result = applyMutation(record, event.change.mutation, {
      actor: event.actor,
      at: event.at,
      packByteLimit,
    })
    if ('error' in result) {
      throw new Error(`corrupt task stream: ${event.taskId} revision ${event.revision}: ${result.error.code}`)
    }
    if (result.ok.revision !== event.revision || result.ok.status !== event.change.task.record.status) {
      throw new Error(`corrupt task stream: ${event.taskId} revision ${event.revision} disagrees with its view`)
    }
    records.set(event.taskId, result.ok)
    lastRevision.set(event.taskId, event.revision)
    if (event.change.operation === 'abandon') archived.add(event.taskId)
  }
  return { records, archived }
}
