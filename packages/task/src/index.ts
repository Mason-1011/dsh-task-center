/**
 * Task seam definition service (`ctx.tasks`): transition validation,
 * compare-and-set mutation, the dual-ledger write (domain event first,
 * session receipt second), and `task/changed` notifications.
 * Spec: docs/design/05-seam-spec.md. Slice 1 of docs/design/04-plan.md.
 * @module @task-center/task
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { applyMutation, foldTasks } from './fold.ts'
import { MemoryTaskStore } from './store.ts'
import type { TaskStore } from './store.ts'
import { TaskId } from './types.ts'
import type {
  TaskActor,
  TaskContextInjectedMeta,
  TaskError,
  TaskMutation,
  TaskOperation,
  TaskSnapshotChangeMeta,
  TaskStatus,
  TaskView,
  WakeRule,
} from './types.ts'

export * from './types.ts'
export { foldTasks, applyMutation, TRANSITIONS, appendPackLine } from './fold.ts'
export { MemoryTaskStore } from './store.ts'
export type { TaskStore, TaskEventInput } from './store.ts'

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
  readonly task: TaskView
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
  readonly workspaceId?: string
  readonly includeArchived?: boolean
  readonly limit?: number
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
    const { records, archived } = foldTasks(this.store.events(), this.config.contextPackByteLimit)
    const record = records.get(taskId)
    return record === undefined ? undefined : { record, blockedOverdue: false, archived: archived.has(taskId) }
  }

  /** List task views by filter. */
  list(filter: TaskListFilter = {}): TaskView[] {
    const { records, archived } = foldTasks(this.store.events(), this.config.contextPackByteLimit)
    const limit = filter.limit ?? this.config.listDefaultLimit
    const views: TaskView[] = []
    for (const record of records.values()) {
      if (archived.has(record.id) && filter.includeArchived !== true) continue
      if (filter.status !== undefined && record.status !== filter.status) continue
      if (filter.workspaceId !== undefined && !record.workspaceIds.includes(filter.workspaceId)) continue
      views.push({ record, blockedOverdue: false, archived: archived.has(record.id) })
      if (views.length >= limit) break
    }
    return views
  }

  /**
   * Create one task. The handle's disposer abandons the task (legal only
   * before the first claim, which withdrawal enforces by error).
   */
  async create(input: { objective: string; acceptance: string; workspaceIds?: readonly string[] }, actor: TaskActor): Promise<TaskHandle | TaskError> {
    const taskId = TaskId(randomUUID())
    const view = await this.commit(taskId, { operation: 'create', taskId, objective: input.objective, acceptance: input.acceptance, workspaceIds: input.workspaceIds }, actor)
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

  /** Register `session` as the holder; appends the session to `sessionIds`. */
  async claim(taskId: TaskId, session: Session, actor: TaskActor): Promise<TaskView | TaskError> {
    const current = this.get(taskId)
    if (current === undefined) return { code: 'TASK_NOT_FOUND', message: 'task does not exist' }
    const view = await this.commit(taskId, { operation: 'claim' }, actor, session)
    if ('code' in view) return view
    session.append('task/context-injected', {
      kind: 'task/context-injected', version: 1, taskId,
      revision: view.record.revision,
      content: view.record.contextPack,
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

  /** Wake rules that reached their target, for task-wake. TODO(S2): every-anchor math. */
  wakeRules(): readonly WakeDue[] {
    const due: WakeDue[] = []
    for (const view of this.list({ includeArchived: true })) {
      const rule = view.record.wakeRule
      if (rule === undefined || view.archived || view.record.status === 'done') continue
      const target = rule.kind === 'after'
        ? Date.parse(view.record.createdAt) + rule.afterSeconds * 1000
        : rule.kind === 'at' ? Date.parse(rule.scheduledAt)
          : Date.now() // every: S1 treats each call as due; anchor math lands with task-wake
      if (Number.isNaN(target) || target <= Date.now() || rule.kind === 'every') {
        due.push({ taskId: view.record.id, rule, revision: view.record.revision })
      }
    }
    return due
  }

  /** Validate, append to the domain ledger, emit, and write the session receipt. */
  private async commit(taskId: TaskId, mutation: TaskMutation, actor: TaskActor, session?: Session): Promise<TaskView | TaskError> {
    const at = new Date().toISOString()
    const { records, archived } = foldTasks(this.store.events(), this.config.contextPackByteLimit)
    const result = applyMutation(records.get(taskId), mutation, {
      actor, at, packByteLimit: this.config.contextPackByteLimit,
    })
    if ('error' in result) return result.error
    // The fold above reflects the stream before this append, so 'abandon' flips the flag here.
    const view: TaskView = {
      record: result.ok, blockedOverdue: false,
      archived: archived.has(taskId) || mutation.operation === 'abandon',
    }
    const change: TaskSnapshotChangeMeta = {
      kind: 'task/change', version: 1,
      operation: mutation.operation, taskId, revision: result.ok.revision, mutation, task: view,
    }
    await this.store.append({ taskId, revision: result.ok.revision, actor, at, change })
    this.ctx.emit('task/changed', { operation: mutation.operation, task: view })
    if (actor.kind === 'model' && session !== undefined) session.append('task/change', change)
    return view
  }
}
