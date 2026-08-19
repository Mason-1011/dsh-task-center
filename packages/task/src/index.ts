/**
 * Task seam definition service (`ctx.tasks`): transition validation,
 * compare-and-set mutation, the dual-ledger write (domain event first,
 * session receipt second), and `task/changed` notifications.
 * Spec: docs/design/05-seam-spec.md. Slice 1 of docs/design/04-plan.md.
 * @module @task-center/task
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { applyCandidateMutation, applyMutation, applyProjectMutation, fold, historySessionIds } from './fold.ts'
import { appendReceipt, registerReceiptTypes } from './receipts.ts'
import { MemoryTaskStore } from './store.ts'
import type { TaskStore } from './store.ts'
import { CandidateId, ProjectId, TaskId } from './types.ts'
import type {
  CandidateDomainEvent,
  CandidateMutation,
  CandidateOperation,
  CandidateOrigin,
  CandidateSnapshotChangeMeta,
  CandidateView,
  ProjectDomainEvent,
  ProjectMutation,
  ProjectOperation,
  ProjectSnapshotChangeMeta,
  ProjectView,
  TaskActor,
  TaskContextInjectedMeta,
  TaskError,
  TaskMutation,
  TaskOperation,
  TaskOrigin,
  TaskRecord,
  TaskSnapshotChangeMeta,
  TaskStatus,
  TaskView,
  WakeRule,
} from './types.ts'
import type { LedgerEvent } from './store.ts'

export * from './types.ts'
export { fold, applyMutation, applyProjectMutation, applyCandidateMutation, TRANSITIONS, appendPackLine, checkWakeRule, historySessionIds, MIN_EVERY_INTERVAL_SECONDS } from './fold.ts'
export { appendReceipt, registerReceiptTypes } from './receipts.ts'
export { idleDays, effectiveIdle, lastSessionActivity } from './idle.ts'
export type { HolderActivity, TaskReader } from './idle.ts'
export { MemoryTaskStore } from './store.ts'
export type { TaskStore, LedgerEventInput, LedgerEvent } from './store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tasks: TaskService
  }
}

/** Deployment knobs for the task seam (05 §7). No hardcoded tunables. */
export interface Config {
  /** Context-pack byte limit, enforced on the complete value. Required. */
  contextPackByteLimit: number
  /** Default return limit for list/query. Required. */
  listDefaultLimit: number
}

/** Live notification after one task-domain event commits (05 §5). */
export interface TaskChanged {
  readonly operation: TaskOperation
  /** The committing mutation verbatim — listeners (the rejection push) read fields the view does not carry. */
  readonly mutation: TaskMutation
  readonly task: TaskView
}

/** Live notification after one project event commits; projects share the ledger. */
export interface ProjectChanged {
  readonly operation: ProjectOperation
  readonly project: ProjectView
}

/** Live notification after one candidate event commits; candidates share the ledger. */
export interface CandidateChanged {
  readonly operation: CandidateOperation
  readonly candidate: CandidateView
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Task mutation committed to the domain ledger. Global scope on purpose:
     * tasks outlive sessions, boards subscribe globally. Listener failures are contained.
     * @param payload.operation - verb that committed.
     * @param payload.task - fresh view of the mutated task.
     * @mode emit
     */
    'task/changed'(payload: TaskChanged): void
    /**
     * Project mutation committed to the shared ledger, right after its task twin.
     * @param payload.operation - project verb that committed.
     * @param payload.project - fresh view of the mutated project.
     * @mode emit
     */
    'project/changed'(payload: ProjectChanged): void
    /**
     * Candidate mutation committed to the shared ledger, right after its task twin.
     * @param payload.operation - candidate verb that committed.
     * @param payload.candidate - fresh view of the mutated candidate.
     * @mode emit
     */
    'candidate/changed'(payload: CandidateChanged): void
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Post-mutation snapshot receipt for a session's model-initiated change (05 §2). */
    'task/change': TaskSnapshotChangeMeta
    /** Receipt for a context-pack injection at claim time (05 §2). */
    'task/context-injected': TaskContextInjectedMeta
  }
}

/** Handle returned by `create`; disposing it before the first claim withdraws the task. */
export interface TaskHandle {
  readonly task: TaskView
  dispose(): Promise<void>
}

/** Filter for `list`. */
export interface TaskListFilter {
  readonly status?: TaskStatus
  /** Exact birth-workspace directory match. */
  readonly workspacePath?: string
  readonly projectId?: ProjectId
  readonly includeArchived?: boolean
  readonly limit?: number
}

/** Handle returned by `projectCreate`; disposing it archives the project. */
export interface ProjectHandle {
  readonly project: ProjectView
  dispose(): Promise<void>
}

/** Wake rule that reached its target — consumed by task-wake (05 §4). */
export interface WakeDue {
  readonly taskId: TaskId
  readonly rule: WakeRule
  readonly revision: number
}

/**
 * The task seam service. Owns transition validation and the dual-ledger write;
 * the ledger store is replaceable by a provider via {@link TaskService.use}.
 */
export class TaskService extends Service {
  /** The seam itself has no hard dependencies; the store provider injects `tasks`. */
  static inject = [] as const

  private store: TaskStore = new MemoryTaskStore()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'tasks')
    registerReceiptTypes()
  }

  /**
   * Replace the ledger store (provider mount point). Re-derives all views from
   * the new store's stream; returns the disposer restoring the previous store.
   * @param store - the durable store from the provider.
   * @returns disposer restoring the previous store.
   */
  use(store: TaskStore): () => void {
    const previous = this.store
    this.store = store
    return () => { this.store = previous }
  }

  /** Read one task view. */
  get(taskId: TaskId): TaskView | undefined {
    const { tasks, archivedTasks } = fold(this.store.events(), this.config.contextPackByteLimit)
    const record = tasks.get(taskId)
    return record === undefined ? undefined : { record, blockedOverdue: false, archived: archivedTasks.has(taskId) }
  }

  /** List task views by filter. */
  list(filter: TaskListFilter = {}): TaskView[] {
    const { tasks, archivedTasks } = fold(this.store.events(), this.config.contextPackByteLimit)
    const limit = filter.limit ?? this.config.listDefaultLimit
    const views: TaskView[] = []
    for (const record of tasks.values()) {
      if (archivedTasks.has(record.id) && filter.includeArchived !== true) continue
      if (filter.status !== undefined && record.status !== filter.status) continue
      if (filter.workspacePath !== undefined && record.workspacePath !== filter.workspacePath) continue
      if (filter.projectId !== undefined && record.projectId !== filter.projectId) continue
      views.push({ record, blockedOverdue: false, archived: archivedTasks.has(record.id) })
      if (views.length >= limit) break
    }
    return views
  }

  /** All projects in creation order, archived included. */
  projects(): readonly ProjectView[] {
    const { projects } = fold(this.store.events(), this.config.contextPackByteLimit)
    return [...projects.values()].map(record => ({ record }))
  }

  /** Read one project view. */
  project(projectId: ProjectId): ProjectView | undefined {
    return this.projects().find(view => view.record.id === projectId)
  }

  /**
   * Birth one task straight into review (source extractor only): a session's
   * goal completed without a human reply, so the declared completion surfaces
   * for the human verdict — approve closes it, reject returns it to the
   * claimable backlog. Same-origin dedup mirrors candidates: a task from this
   * exact session-and-goal origin already exists in any status — the
   * extractor's re-trigger finds it here and does not double-create. No
   * withdrawal handle: the work is real and already done, so nothing here
   * auto-abandons it.
   */
  async acceptanceCreate(input: { objective: string; completionNote: string; sessionId: SessionId; goalId: string; workspacePath?: string }, actor: TaskActor): Promise<TaskView | TaskError> {
    if (actor.kind !== 'source') return { code: 'TASK_FORBIDDEN', message: 'acceptance births are the source extractor\'s alone' }
    const origin: TaskOrigin = { sessionId: input.sessionId, goalId: input.goalId }
    const existing = this.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })
      .find(view => {
        const born = view.record.origin
        return born !== undefined && 'goalId' in born && born.goalId === origin.goalId && born.sessionId === origin.sessionId
      })
    if (existing !== undefined) {
      return { code: 'TASK_DUPLICATE_ORIGIN', message: 'a task from this acceptance origin already exists' }
    }
    const taskId = TaskId(randomUUID())
    return this.commit(taskId, {
      operation: 'create', taskId,
      objective: input.objective, acceptance: '',
      ...input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath },
      origin, completionNote: input.completionNote,
    }, actor)
  }

  /**
   * Create one task. The handle's disposer abandons the task (legal only
   * before the first claim, which withdrawal enforces by error).
   */
  async create(input: { objective: string; acceptance: string; projectId?: ProjectId; workspacePath?: string; origin?: TaskOrigin }, actor: TaskActor): Promise<TaskHandle | TaskError> {
    const taskId = TaskId(randomUUID())
    const view = await this.commit(taskId, {
      operation: 'create', taskId,
      objective: input.objective, acceptance: input.acceptance,
      ...input.projectId === undefined ? {} : { projectId: input.projectId },
      ...input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath },
      ...input.origin === undefined ? {} : { origin: input.origin },
    }, actor)
    if ('code' in view) return view
    const claimed = view.record.revision
    return {
      task: view,
      dispose: async () => {
        const withdrawn = await this.commit(taskId, { operation: 'abandon' }, { kind: 'human' })
        void withdrawn; void claimed
      },
    }
  }

  /**
   * Create one project (human-managed grouping). The handle's disposer archives it.
   */
  async projectCreate(name: string, actor: TaskActor): Promise<ProjectHandle | TaskError> {
    const projectId = ProjectId(randomUUID())
    const view = await this.commitProject(projectId, { operation: 'project-create', projectId, name }, actor)
    if ('code' in view) return view
    return {
      project: view,
      dispose: async () => {
        const withdrawn = await this.commitProject(projectId, { operation: 'project-archive' }, { kind: 'human' })
        void withdrawn
      },
    }
  }

  /** Single entry point for project transitions; compare-and-set on revision. */
  async projectMutate(projectId: ProjectId, expectedRevision: number, mutation: Exclude<ProjectMutation, { operation: 'project-create' }>, actor: TaskActor): Promise<ProjectView | TaskError> {
    const current = this.project(projectId)
    if (current === undefined) return { code: 'PROJECT_NOT_FOUND', message: 'project does not exist' }
    if (current.record.revision !== expectedRevision) {
      return { code: 'TASK_STALE_REVISION', message: `expected revision ${current.record.revision}` }
    }
    return this.commitProject(projectId, mutation, actor)
  }

  /** All candidates in creation order, terminal statuses included. */
  candidates(): readonly CandidateView[] {
    const { candidates } = fold(this.store.events(), this.config.contextPackByteLimit)
    return [...candidates.values()].map(record => ({ record }))
  }

  /** The candidate of one exact origin, for extractor dedup. */
  candidateByOrigin(origin: CandidateOrigin): CandidateView | undefined {
    return this.candidates().find(view =>
      view.record.origin.sessionId === origin.sessionId
      && view.record.origin.tier === origin.tier
      && view.record.origin.key === origin.key)
  }

  /**
   * Birth one candidate (source extractor only). Same-origin dedup: a
   * candidate from this exact origin already exists in any status — the
   * extractor's re-trigger finds it here and does not double-create.
   */
  async candidateCreate(input: { objective: string; acceptance?: string; note?: string; origin: CandidateOrigin }, actor: TaskActor): Promise<CandidateView | TaskError> {
    if (actor.kind !== 'source') return { code: 'CANDIDATE_FORBIDDEN', message: 'candidates are born by the source extractor only' }
    if (this.candidateByOrigin(input.origin) !== undefined) {
      return { code: 'CANDIDATE_DUPLICATE_ORIGIN', message: 'a candidate from this origin already exists' }
    }
    const candidateId = CandidateId(randomUUID())
    return this.commitCandidate(candidateId, {
      operation: 'candidate-create', candidateId,
      objective: input.objective,
      ...input.acceptance === undefined ? {} : { acceptance: input.acceptance },
      ...input.note === undefined ? {} : { note: input.note },
      origin: input.origin,
    }, actor)
  }

  /**
   * Promote one pending candidate into a task (human only): creates the task
   * with the candidate as origin, then marks the candidate promoted with the
   * task id. Task-first ordering keeps the crash window recoverable — a task
   * with this origin blocks re-promotion instead of duplicating.
   */
  async candidatePromote(candidateId: CandidateId, expectedRevision: number, input: { acceptance: string; objective?: string; projectId?: ProjectId; workspacePath?: string }, actor: TaskActor): Promise<{ task: TaskView; candidate: CandidateView } | TaskError> {
    const candidates = this.candidates()
    const current = candidates.find(view => view.record.id === candidateId)
    if (current === undefined) return { code: 'CANDIDATE_NOT_FOUND', message: 'candidate does not exist' }
    if (current.record.revision !== expectedRevision) {
      return { code: 'TASK_STALE_REVISION', message: `expected revision ${current.record.revision}` }
    }
    // Crash recovery: the task commit below landed but the promote commit did not.
    const promoted = this.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })
      .find(view => {
        const born = view.record.origin
        return born !== undefined && 'candidateId' in born && born.candidateId === candidateId
      })
    if (promoted !== undefined) {
      return { code: 'CANDIDATE_ALREADY_EXISTS', message: `candidate was already promoted as task ${promoted.record.id}` }
    }
    const objective = input.objective !== undefined && input.objective.trim() !== '' ? input.objective : current.record.objective
    const origin: TaskOrigin = { candidateId, sessionId: current.record.origin.sessionId }
    const taskId = TaskId(randomUUID())
    const task = await this.commit(taskId, {
      operation: 'create', taskId,
      objective, acceptance: input.acceptance,
      ...input.projectId === undefined ? {} : { projectId: input.projectId },
      ...input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath },
      origin,
    }, actor)
    if ('code' in task) return task
    const candidate = await this.commitCandidate(candidateId, {
      operation: 'candidate-promote', acceptance: input.acceptance, taskId: task.record.id,
      ...input.objective === undefined ? {} : { objective: input.objective },
    }, actor)
    if ('code' in candidate) return candidate
    return { task, candidate }
  }

  /** Ignore one pending candidate (human only); terminal. */
  async candidateIgnore(candidateId: CandidateId, expectedRevision: number, actor: TaskActor): Promise<CandidateView | TaskError> {
    return this.candidateMutate(candidateId, expectedRevision, { operation: 'candidate-ignore' }, actor)
  }

  /** Supersede one pending candidate (source only): the origin finished the work; terminal. */
  async candidateSupersede(candidateId: CandidateId, expectedRevision: number, reason: string, actor: TaskActor): Promise<CandidateView | TaskError> {
    return this.candidateMutate(candidateId, expectedRevision, { operation: 'candidate-supersede', reason }, actor)
  }

  /** CAS fence shared by ignore and supersede. */
  private async candidateMutate(candidateId: CandidateId, expectedRevision: number, mutation: Exclude<CandidateMutation, { operation: 'candidate-create' | 'candidate-promote' }>, actor: TaskActor): Promise<CandidateView | TaskError> {
    const current = this.candidates().find(view => view.record.id === candidateId)
    if (current === undefined) return { code: 'CANDIDATE_NOT_FOUND', message: 'candidate does not exist' }
    if (current.record.revision !== expectedRevision) {
      return { code: 'TASK_STALE_REVISION', message: `expected revision ${current.record.revision}` }
    }
    return this.commitCandidate(candidateId, mutation, actor)
  }

  /** Validate and append one candidate event to the shared ledger, then emit. */
  private async commitCandidate(candidateId: CandidateId, mutation: CandidateMutation, actor: TaskActor): Promise<CandidateView | TaskError> {
    const at = new Date().toISOString()
    const { candidates } = fold(this.store.events(), this.config.contextPackByteLimit)
    const result = applyCandidateMutation(candidates.get(candidateId), mutation, {
      actor, at, packByteLimit: this.config.contextPackByteLimit,
    })
    if ('error' in result) return result.error
    const view: CandidateView = { record: result.ok }
    const change: CandidateSnapshotChangeMeta = {
      kind: 'candidate/change', version: 1,
      operation: mutation.operation, candidateId, revision: result.ok.revision, mutation, candidate: view,
    }
    const event: Omit<CandidateDomainEvent, 'eventId'> = { candidateId, revision: result.ok.revision, actor, at, change }
    await this.store.append(event)
    this.ctx.emit('candidate/changed', { operation: mutation.operation, candidate: view })
    return view
  }

  /**
   * Register `session` as the holder; appends the session to `sessionIds`.
   * The injected pack is prefixed with one `PRIOR SESSIONS` line whenever
   * other sessions carried the task before this claim, so a fresh claimer
   * knows its work continues recorded conversations.
   */
  async claim(taskId: TaskId, session: Session, actor: TaskActor): Promise<TaskView | TaskError> {
    const current = this.get(taskId)
    if (current === undefined) return { code: 'TASK_NOT_FOUND', message: 'task does not exist' }
    const view = await this.commit(taskId, { operation: 'claim' }, actor, session)
    if ('code' in view) return view
    const priorSessions = historySessionIds(view.record).filter(id => id !== session.id)
    appendReceipt(session, 'task/context-injected', {
      kind: 'task/context-injected', version: 1, taskId,
      revision: view.record.revision,
      content: priorSessions.length === 0
        ? view.record.contextPack
        : `PRIOR SESSIONS: ${priorSessions.join(' ')}\n${view.record.contextPack}`,
    })
    return view
  }

  /** Single entry point for every transition; compare-and-set on revision. */
  async mutate(taskId: TaskId, expectedRevision: number, mutation: Exclude<TaskMutation, { operation: 'create' }>, actor: TaskActor, session?: Session): Promise<TaskView | TaskError> {
    const current = this.get(taskId)
    if (current === undefined) return { code: 'TASK_NOT_FOUND', message: 'task does not exist' }
    if (current.record.revision !== expectedRevision) {
      return { code: 'TASK_STALE_REVISION', message: `expected revision ${current.record.revision}` }
    }
    return this.commit(taskId, mutation, actor, session)
  }

  /**
   * Wake rules that reached their target, for task-wake. Every rule targets
   * `anchorAt + everySeconds`; the consumer advances the anchor on each fire,
   * so a due `every` is exactly one occurrence behind the wall clock.
   */
  wakeRules(): readonly WakeDue[] {
    const now = Date.now()
    const due: WakeDue[] = []
    for (const view of this.list({ includeArchived: true })) {
      const rule = view.record.wakeRule
      if (rule === undefined || view.archived || view.record.status === 'done') continue
      const target = rule.kind === 'after'
        ? Date.parse(view.record.createdAt) + rule.afterSeconds * 1000
        : rule.kind === 'at' ? Date.parse(rule.scheduledAt)
          : Date.parse(rule.anchorAt) + rule.everySeconds * 1000
      if (!Number.isNaN(target) && target <= now) {
        due.push({ taskId: view.record.id, rule, revision: view.record.revision })
      }
    }
    return due
  }

  /**
   * Views of one task's linked children, for parent-side progress aggregation.
   * @param taskId - the parent task id.
   * @returns child views in link order; archived children included.
   */
  children(taskId: TaskId): TaskView[] {
    const parent = this.get(taskId)
    if (parent === undefined) return []
    return parent.record.subtasks
      .map(id => this.get(id))
      .filter((view): view is TaskView => view !== undefined)
  }

  /**
   * One task's committed ledger events, oldest first. The change history is
   * the only place fields no view carries survive — a listener replaying a
   * past verdict (the rejection push's boot reconciliation) reads the mutation
   * verbatim from here.
   * @param taskId - the task to read history for.
   * @returns its committed events in append order; empty for an unknown id.
   */
  changes(taskId: TaskId): readonly LedgerEvent[] {
    return this.store.events().filter((event): event is Extract<LedgerEvent, { taskId: TaskId }> =>
      'taskId' in event && event.taskId === taskId)
  }

  /**
   * Cross-record guard for `subtask-add`: the child must exist, differ from the
   * parent, and not reach the parent through its own subtree (the per-record
   * fold cannot see other tasks). The duplicate check stays in the fold.
   * @param records - every folded task record.
   * @param parentId - the task gaining a child.
   * @param childId - the candidate child.
   * @returns the rejection, or undefined when the link is legal.
   */
  private checkLink(records: ReadonlyMap<TaskId, TaskRecord>, parentId: TaskId, childId: TaskId): TaskError | undefined {
    if (childId === parentId) return { code: 'TASK_SUBTASK_SELF', message: 'a task cannot be its own child' }
    const child = records.get(childId)
    if (child === undefined) return { code: 'TASK_NOT_FOUND', message: 'child task does not exist' }
    // Linking is legal unless the parent is already reachable from the child.
    const seen = new Set<TaskId>([childId])
    const queue: TaskId[] = [childId]
    while (queue.length > 0) {
      const current = records.get(queue.shift()!)
      if (current === undefined) continue
      for (const id of current.subtasks) {
        if (id === parentId) return { code: 'TASK_SUBTASK_CYCLE', message: 'linking would create a subtask cycle' }
        if (!seen.has(id)) {
          seen.add(id)
          queue.push(id)
        }
      }
    }
    return undefined
  }

  /** Validate, append to the domain ledger, emit, and write the session receipt. */
  private async commit(taskId: TaskId, mutation: TaskMutation, actor: TaskActor, session?: Session): Promise<TaskView | TaskError> {
    const at = new Date().toISOString()
    const ledger = fold(this.store.events(), this.config.contextPackByteLimit)
    if (mutation.operation === 'subtask-add') {
      const rejected = this.checkLink(ledger.tasks, taskId, mutation.childId)
      if (rejected !== undefined) return rejected
    }
    if (mutation.operation === 'create' || mutation.operation === 'edit') {
      const target = mutation.projectId ?? undefined
      if (target !== undefined) {
        const rejected = this.checkProject(ledger, target)
        if (rejected !== undefined) return rejected
      }
    }
    const result = applyMutation(ledger.tasks.get(taskId), mutation, {
      actor, at, packByteLimit: this.config.contextPackByteLimit,
    })
    if ('error' in result) return result.error
    // The fold above reflects the stream before this append, so 'abandon' flips the flag here.
    const view: TaskView = {
      record: result.ok, blockedOverdue: false,
      archived: ledger.archivedTasks.has(taskId) || mutation.operation === 'abandon',
    }
    const change: TaskSnapshotChangeMeta = {
      kind: 'task/change', version: 1,
      operation: mutation.operation, taskId, revision: result.ok.revision, mutation, task: view,
    }
    await this.store.append({ taskId, revision: result.ok.revision, actor, at, change })
    this.ctx.emit('task/changed', { operation: mutation.operation, mutation, task: view })
    if (actor.kind === 'model' && session !== undefined) appendReceipt(session, 'task/change', change)
    return view
  }

  /** Validate and append one project event to the shared ledger, then emit. */
  private async commitProject(projectId: ProjectId, mutation: ProjectMutation, actor: TaskActor): Promise<ProjectView | TaskError> {
    const at = new Date().toISOString()
    const { projects } = fold(this.store.events(), this.config.contextPackByteLimit)
    const result = applyProjectMutation(projects.get(projectId), mutation, {
      actor, at, packByteLimit: this.config.contextPackByteLimit,
    })
    if ('error' in result) return result.error
    const view: ProjectView = { record: result.ok }
    const change: ProjectSnapshotChangeMeta = {
      kind: 'project/change', version: 1,
      operation: mutation.operation, projectId, revision: result.ok.revision, mutation, project: view,
    }
    const event: Omit<ProjectDomainEvent, 'eventId'> = { projectId, revision: result.ok.revision, actor, at, change }
    await this.store.append(event)
    this.ctx.emit('project/changed', { operation: mutation.operation, project: view })
    return view
  }

  /**
   * Cross-record guard for a task's project reference: the project must exist
   * and be live. Archiving a project keeps its existing tasks readable (they
   * still fold), but no task may be newly assigned to it.
   */
  private checkProject(ledger: ReturnType<typeof fold>, projectId: ProjectId | undefined): TaskError | undefined {
    if (projectId === undefined) return undefined
    const project = ledger.projects.get(projectId)
    if (project === undefined) return { code: 'PROJECT_NOT_FOUND', message: 'project does not exist' }
    if (project.archived) return { code: 'PROJECT_ARCHIVED', message: 'project is archived; reassign its tasks or create a new project' }
    return undefined
  }
}

export default TaskService
