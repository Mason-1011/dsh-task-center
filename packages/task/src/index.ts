/**
 * Task seam definition service (`ctx.tasks`): state-machine transitions,
 * context-pack reads, and `task/changed` notifications. The authoritative
 * ledger lives in the task storage domain (opened by `@task-center/task-local`);
 * this service validates transitions and writes both ledgers.
 * Spec: docs/design/05-seam-spec.md.
 * TODO(S1): implement the transition table, compare-and-set mutation, and the
 * session-event receipts. Slice 1 of docs/design/04-plan.md.
 * @module @task-center/task
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  TaskActor,
  TaskContextInjectedMeta,
  TaskDomainEvent,
  TaskError,
  TaskId,
  TaskOperation,
  TaskSnapshotChangeMeta,
  TaskView,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tasks: TaskService
  }
}

/** Deployment knobs for the task seam (05 §7). No hardcoded tunables. */
export interface Config {
  /** Context-pack byte limit, enforced on the complete value. Required. */
  contextPackByteLimit: number
  /** Minimum interval for `every` wake rules, in seconds. Required. */
  wakeMinIntervalSeconds: number
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
     * @param payload.task - fresh view of the mutated task.
     * @param payload.operation - verb that committed.
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

/** Filter for `list` and `task_query`. */
export interface TaskFilter {
  readonly status?: TaskView['record']['status']
  readonly workspaceId?: string
  readonly includeArchived?: boolean
  readonly limit?: number
}

/** Wake rule that reached its target — consumed by task-wake (05 §4). */
export interface WakeDue {
  readonly taskId: TaskId
  readonly rule: NonNullable<TaskView['record']['wakeRule']>
  readonly revision: number
}

/**
 * The task seam service. Owns transition validation and the dual-ledger write
 * (domain event first, session receipt second); storage is opened by a provider.
 */
export class TaskService extends Service {
  /** The seam has no hard plugin dependencies; the provider injects `tasks`. */
  static inject = [] as const

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'tasks')
  }

  /** Create one task; the handle's disposer withdraws an unclaimed task. TODO(S1). */
  async create(input: { objective: string; acceptance: string; workspaceIds?: readonly string[] }, actor: TaskActor): Promise<TaskHandle> {
    void input; void actor
    throw new Error('TODO(S1): task create')
  }

  /** Read one task view. */
  async get(taskId: TaskId): Promise<TaskView | undefined> {
    void taskId
    throw new Error('TODO(S1): task get')
  }

  /** List task views by filter. */
  async list(filter: TaskFilter): Promise<TaskView[]> {
    void filter
    throw new Error('TODO(S1): task list')
  }

  /** Register `session` as the holder; appends to `sessionIds`. TODO(S1). */
  async claim(taskId: TaskId, session: Session, actor: TaskActor): Promise<TaskView | TaskError> {
    void taskId; void session; void actor
    throw new Error('TODO(S1): task claim')
  }

  /** Single entry point for every transition; compare-and-set on revision. TODO(S1). */
  async mutate(taskId: TaskId, expectedRevision: number, change: TaskOperation, actor: TaskActor): Promise<TaskView | TaskError> {
    void taskId; void expectedRevision; void change; void actor
    throw new Error('TODO(S1): task mutate')
  }

  /** Wake rules that reached their target, for task-wake. TODO(S1). */
  async wakeRules(): Promise<readonly WakeDue[]> {
    throw new Error('TODO(S1): task wakeRules')
  }

  /** Fold the authoritative domain event stream into the record; invariant basis. TODO(S1). */
  static fold(events: readonly TaskDomainEvent[]): Map<TaskId, TaskDomainEvent> {
    void events
    throw new Error('TODO(S1): task fold')
  }
}
