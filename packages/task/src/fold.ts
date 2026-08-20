/**
 * Pure task state machine: the transition table, the mutation application,
 * and the domain-event replay fold. No Cordis, no I/O — the live service and
 * the replay fold share this module as the single source of transition truth.
 * Spec: docs/design/05-seam-spec.md §1 and §3.
 * @module dsh-task-center-task/fold
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  CandidateDomainEvent,
  CandidateId,
  CandidateMutation,
  CandidateRecord,
  ProjectDomainEvent,
  ProjectId,
  ProjectMutation,
  ProjectRecord,
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
  // A held task goes back to its holder (active); a holderless acceptance birth falls to the claimable backlog (todo).
  reject: { from: ['review'], to: 'active' },
  release: { from: ['active', 'blocked'], to: 'todo' },
  'subtask-add': { from: ['todo', 'active', 'blocked'], to: 'same' },
  'subtask-remove': { from: ['todo', 'active', 'blocked'], to: 'same' },
  abandon: { from: ['todo', 'active', 'blocked', 'review'], to: 'archive' },
  edit: { from: ['todo', 'active', 'blocked', 'done'], to: 'same' },
  'wake-set': { from: ['todo', 'active', 'blocked', 'done'], to: 'same' },
  'wake-clear': { from: ['todo', 'active', 'blocked', 'done'], to: 'same' },
  patrol: { from: ['todo', 'active', 'blocked', 'review'], to: 'same' },
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

/**
 * The epoch-ms instant one rule next fires at. `after` anchors at the task's
 * own creation — the same anchor `TaskService.wakeRules()` reads due by.
 * @param rule - the armed rule.
 * @param createdAt - the owning task's ISO-8601 creation instant.
 * @returns the target epoch ms, or undefined when a timestamp fails to parse.
 */
export function wakeTarget(rule: WakeRule, createdAt: string): number | undefined {
  const target = rule.kind === 'after'
    ? Date.parse(createdAt) + rule.afterSeconds * 1000
    : rule.kind === 'at' ? Date.parse(rule.scheduledAt)
      : Date.parse(rule.anchorAt) + rule.everySeconds * 1000
  return Number.isNaN(target) ? undefined : target
}

/**
 * Human-readable wake rule for the human faces (command detail, board cards).
 * @param rule - the armed rule.
 * @returns one-line Chinese description of the rule's shape.
 */
export function describeWake(rule: WakeRule): string {
  if (rule.kind === 'after') return `${rule.afterSeconds} 秒后`
  if (rule.kind === 'at') return `定点 ${rule.scheduledAt}`
  return `每 ${rule.everySeconds} 秒(锚点 ${rule.anchorAt})`
}

/**
 * The rule's next fire instant as ISO-8601, for human faces to localize.
 * @param rule - the armed rule.
 * @param createdAt - the owning task's ISO-8601 creation instant.
 * @returns the next target instant, or undefined when unparseable.
 */
export function nextWakeAt(rule: WakeRule, createdAt: string): string | undefined {
  const target = wakeTarget(rule, createdAt)
  return target === undefined ? undefined : new Date(target).toISOString()
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

/**
 * Every session that has ever carried this task, oldest first: the birth
 * origin's session (promoted and acceptance-born alike) followed by each
 * claiming session in first-claim order. One session claiming again after a
 * release (a rejection push-back re-claim, a re-staged task) still lists
 * once — `sessionIds` is an execution log, this projection is the distinct
 * set. Pure derivation over the record — the board links each entry to that
 * conversation, and claim-time injection reports the sessions before the
 * claimer.
 * @param record - folded task state.
 * @returns distinct session ids; the origin session leads unless a claim already listed it.
 */
export function historySessionIds(record: TaskRecord): readonly SessionId[] {
  const seen = new Set<string>()
  const history: SessionId[] = []
  for (const id of [record.origin?.sessionId, ...record.sessionIds]) {
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    history.push(id)
  }
  return history
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
  // The source actor is the extractor: it births candidates, mirrors goal
  // phases (attributed to the holding session, which the matrix covers), and
  // surfaces a session's completed-but-unaccepted work as a review-born task —
  // the one create form allowed to carry a completion note. Every other verb
  // is beyond it: the extractor never works a task itself.
  const acceptanceBirth = record === undefined && mutation.operation === 'create' && mutation.completionNote !== undefined
  if (actor.kind === 'source' && !acceptanceBirth) {
    return error('TASK_FORBIDDEN', 'the source actor only births completed work for acceptance')
  }
  if (record === undefined) {
    if (mutation.operation !== 'create') return error('TASK_NOT_FOUND', 'task does not exist')
    if (mutation.objective.trim() === '') return error('TASK_INVALID_OBJECTIVE', 'objective must not be empty')
    if (mutation.completionNote !== undefined) {
      if (actor.kind !== 'source') {
        return error('TASK_FORBIDDEN', 'a create carrying a completion note is the source extractor\'s acceptance birth')
      }
      if (mutation.completionNote.trim() === '') return error('TASK_INVALID_NOTE', 'an acceptance birth requires a completion note')
    } else if (mutation.acceptance.trim() === '') {
      return error('TASK_INVALID_ACCEPTANCE', 'acceptance must not be empty')
    }
    // The project reference is validated against the same fold at the service
    // commit layer; here it is carried, and `fold` rejects a dangling final state.
    return { ok: {
      id: mutation.taskId,
      revision: 1,
      objective: mutation.objective,
      acceptance: mutation.acceptance,
      // An acceptance birth starts submitted: the completion is the extractor's
      // claim, the human verdict is the only transition left.
      status: mutation.completionNote !== undefined ? 'review' : 'todo',
      ...mutation.workspacePath === undefined ? {} : { workspacePath: mutation.workspacePath },
      ...mutation.projectId === undefined ? {} : { projectId: mutation.projectId },
      sessionIds: [],
      contextPack: mutation.completionNote === undefined ? ''
        : appendPackLine('', `- ${context.at} SUBMITTED: ${mutation.completionNote}`, context.packByteLimit),
      ...mutation.origin === undefined ? {} : { origin: mutation.origin },
      subtasks: [],
      createdAt: context.at,
      updatedAt: context.at,
      workedAt: context.at,
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
  // Patrol and wake bookkeeping observe or schedule; they do not work the task,
  // so they leave `workedAt` put — the shelving clock must not be reset by them.
  const observationOps: readonly TaskOperation[] = ['patrol', 'wake-set', 'wake-clear']
  const next: Draft<TaskRecord> = {
    ...record,
    revision: record.revision + 1,
    updatedAt: context.at,
    ...observationOps.includes(mutation.operation) ? {} : { workedAt: context.at },
  }
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
      // Rejection returns the task to wherever work can start: the holder
      // redoes (active), a holderless acceptance birth goes back to the
      // claimable backlog — an unheld active task could never be claimed.
      next.status = record.holder === undefined ? 'todo' : 'active'
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
      // A present key reassigns (the service validates the target); null clears.
      if ('projectId' in mutation) {
        if (mutation.projectId === null) delete next.projectId
        else next.projectId = mutation.projectId
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
    case 'patrol': {
      if (mutation.note.trim() === '') return error('TASK_INVALID_NOTE', 'patrol requires a note')
      const planned = mutation.next !== undefined && mutation.next.trim() !== '' ? ` (next: ${mutation.next})` : ''
      const stuck = mutation.blocker !== undefined && mutation.blocker.trim() !== '' ? ` (blocked: ${mutation.blocker})` : ''
      next.contextPack = appendPackLine(record.contextPack, `- ${context.at} PATROL: ${mutation.note}${planned}${stuck}`, context.packByteLimit)
      break
    }
  }
  return { ok: next }
}

/** Replay fold outcome: every entity family of the ledger. */
export interface FoldedLedger {
  readonly tasks: ReadonlyMap<TaskId, TaskRecord>
  readonly projects: ReadonlyMap<ProjectId, ProjectRecord>
  readonly candidates: ReadonlyMap<CandidateId, CandidateRecord>
  readonly archivedTasks: ReadonlySet<TaskId>
}

/** Guard verdict for project mutations, mirroring {@link TransitionResult}. */
export type ProjectResult = { readonly ok: ProjectRecord } | { readonly error: TaskError }

/**
 * Apply one project mutation (undefined for `project-create`). Projects are
 * human-managed grouping metadata: every verb refuses mechanical and model
 * actors, and there is no status machine — only the archived flag.
 */
export function applyProjectMutation(record: ProjectRecord | undefined, mutation: ProjectMutation, context: ApplyContext): ProjectResult {
  if (context.actor.kind !== 'human') {
    return error('PROJECT_FORBIDDEN', 'projects are created, renamed, and archived by humans only')
  }
  if (record === undefined) {
    if (mutation.operation !== 'project-create') return error('PROJECT_NOT_FOUND', 'project does not exist')
    if (mutation.name.trim() === '') return error('PROJECT_INVALID_NAME', 'project name must not be empty')
    return { ok: {
      id: mutation.projectId,
      revision: 1,
      name: mutation.name,
      archived: false,
      createdAt: context.at,
      updatedAt: context.at,
    } }
  }
  if (record.archived) return error('PROJECT_ARCHIVED', 'project is archived')
  if (mutation.operation === 'project-rename') {
    if (mutation.name.trim() === '') return error('PROJECT_INVALID_NAME', 'project name must not be empty')
    return { ok: { ...record, revision: record.revision + 1, name: mutation.name, updatedAt: context.at } }
  }
  if (mutation.operation === 'project-archive') {
    return { ok: { ...record, revision: record.revision + 1, archived: true, updatedAt: context.at } }
  }
  return error('PROJECT_ALREADY_EXISTS', 'a project with this id already exists')
}

/** Guard verdict for candidate mutations, mirroring {@link TransitionResult}. */
export type CandidateResult = { readonly ok: CandidateRecord } | { readonly error: TaskError }

/**
 * Apply one candidate mutation (undefined for `candidate-create`). Candidates
 * have no status machine beyond `pending` → one terminal status: the extractor
 * (source actor) births and supersedes, humans promote and ignore, and every
 * verb is legal only while pending.
 */
export function applyCandidateMutation(record: CandidateRecord | undefined, mutation: CandidateMutation, context: ApplyContext): CandidateResult {
  if (record === undefined) {
    if (mutation.operation !== 'candidate-create') return error('CANDIDATE_NOT_FOUND', 'candidate does not exist')
    if (context.actor.kind !== 'source') return error('CANDIDATE_FORBIDDEN', 'candidates are born by the source extractor only')
    if (mutation.objective.trim() === '') return error('CANDIDATE_INVALID_OBJECTIVE', 'objective must not be empty')
    if (mutation.origin.key.trim() === '') return error('CANDIDATE_INVALID_OBJECTIVE', 'origin key must not be empty')
    return { ok: {
      id: mutation.candidateId,
      revision: 1,
      status: 'pending',
      objective: mutation.objective,
      acceptance: mutation.acceptance !== undefined && mutation.acceptance.trim() !== '' ? mutation.acceptance : '',
      note: mutation.note ?? '',
      origin: mutation.origin,
      createdAt: context.at,
      updatedAt: context.at,
    } }
  }
  if (mutation.operation === 'candidate-create') {
    return error('CANDIDATE_ALREADY_EXISTS', 'a candidate with this id already exists')
  }
  if (record.status !== 'pending') {
    return error('CANDIDATE_INVALID_TRANSITION', `candidate is already ${record.status}`)
  }
  if (mutation.operation === 'candidate-promote') {
    if (context.actor.kind !== 'human') return error('CANDIDATE_FORBIDDEN', 'promoting a candidate is human-only')
    if (mutation.acceptance.trim() === '') {
      return error('CANDIDATE_INVALID_ACCEPTANCE', 'promotion requires a non-empty acceptance criteria')
    }
    const objective = mutation.objective !== undefined && mutation.objective.trim() !== '' ? mutation.objective : record.objective
    if (objective.trim() === '') return error('CANDIDATE_INVALID_OBJECTIVE', 'objective must not be empty')
    return { ok: { ...record, revision: record.revision + 1, status: 'promoted', objective, acceptance: mutation.acceptance, promotedTaskId: mutation.taskId, updatedAt: context.at } }
  }
  if (mutation.operation === 'candidate-ignore') {
    if (context.actor.kind !== 'human') return error('CANDIDATE_FORBIDDEN', 'ignoring a candidate is human-only')
    return { ok: { ...record, revision: record.revision + 1, status: 'ignored', updatedAt: context.at } }
  }
  if (mutation.reason.trim() === '') return error('CANDIDATE_INVALID_REASON', 'superseding requires a reason')
  if (context.actor.kind !== 'source') return error('CANDIDATE_FORBIDDEN', 'superseding is the source extractor\'s verdict')
  return { ok: { ...record, revision: record.revision + 1, status: 'superseded', updatedAt: context.at } }
}

/**
 * Fold the authoritative domain event stream — tasks and projects share one
 * ledger. Fails loud on a corrupt stream: a revision gap, an unknown-entity
 * mutation, a transition the table rejects, or a task referencing a project
 * the stream never created. This is the invariant basis — both record families
 * equal this fold over the stream.
 */
export function fold(events: readonly (TaskDomainEvent | ProjectDomainEvent | CandidateDomainEvent)[], packByteLimit: number): FoldedLedger {
  const tasks = new Map<TaskId, TaskRecord>()
  const projects = new Map<ProjectId, ProjectRecord>()
  const candidates = new Map<CandidateId, CandidateRecord>()
  const archivedTasks = new Set<TaskId>()
  const lastRevision = new Map<TaskId | ProjectId | CandidateId, number>()
  for (const event of events) {
    const change = event.change
    const id = change.kind === 'task/change' ? change.taskId : change.kind === 'candidate/change' ? change.candidateId : change.projectId
    const expected = (lastRevision.get(id) ?? 0) + 1
    if (event.revision !== expected) {
      throw new Error(`corrupt ledger: ${id} revision ${event.revision}, expected ${expected}`)
    }
    if (change.kind === 'task/change') {
      const result = applyMutation(tasks.get(change.taskId), change.mutation, {
        actor: event.actor, at: event.at, packByteLimit,
      })
      if ('error' in result) {
        throw new Error(`corrupt ledger: ${change.taskId} revision ${event.revision}: ${result.error.code}`)
      }
      if (result.ok.revision !== event.revision || result.ok.status !== change.task.record.status) {
        throw new Error(`corrupt ledger: ${change.taskId} revision ${event.revision} disagrees with its view`)
      }
      tasks.set(change.taskId, result.ok)
      if (change.operation === 'abandon') archivedTasks.add(change.taskId)
    } else if (change.kind === 'candidate/change') {
      const result = applyCandidateMutation(candidates.get(change.candidateId), change.mutation, {
        actor: event.actor, at: event.at, packByteLimit,
      })
      if ('error' in result) {
        throw new Error(`corrupt ledger: ${change.candidateId} revision ${event.revision}: ${result.error.code}`)
      }
      if (result.ok.revision !== event.revision || result.ok.status !== change.candidate.record.status) {
        throw new Error(`corrupt ledger: ${change.candidateId} revision ${event.revision} disagrees with its view`)
      }
      candidates.set(change.candidateId, result.ok)
    } else {
      const result = applyProjectMutation(projects.get(change.projectId), change.mutation, {
        actor: event.actor, at: event.at, packByteLimit,
      })
      if ('error' in result) {
        throw new Error(`corrupt ledger: ${change.projectId} revision ${event.revision}: ${result.error.code}`)
      }
      const ok = result.ok
      if (ok.revision !== event.revision || ok.name !== change.project.record.name || ok.archived !== change.project.record.archived) {
        throw new Error(`corrupt ledger: ${change.projectId} revision ${event.revision} disagrees with its view`)
      }
      projects.set(change.projectId, ok)
    }
    lastRevision.set(id, event.revision)
  }
  // Referential integrity: the commit layer refuses dangling project refs, so
  // a stream that still ends with one is corrupt.
  for (const task of tasks.values()) {
    if (task.projectId !== undefined && !projects.has(task.projectId)) {
      throw new Error(`corrupt ledger: ${task.id} references missing project ${task.projectId}`)
    }
  }
  return { tasks, projects, candidates, archivedTasks }
}
