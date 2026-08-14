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
import { Service } from '@deepseek-ai/cordis';
/**
 * The task seam service. Owns transition validation and the dual-ledger write
 * (domain event first, session receipt second); storage is opened by a provider.
 */
export class TaskService extends Service {
    config;
    /** The seam has no hard plugin dependencies; the provider injects `tasks`. */
    static inject = [];
    constructor(ctx, config) {
        super(ctx, 'tasks');
        this.config = config;
    }
    /** Create one task; the handle's disposer withdraws an unclaimed task. TODO(S1). */
    async create(input, actor) {
        void input;
        void actor;
        throw new Error('TODO(S1): task create');
    }
    /** Read one task view. */
    async get(taskId) {
        void taskId;
        throw new Error('TODO(S1): task get');
    }
    /** List task views by filter. */
    async list(filter) {
        void filter;
        throw new Error('TODO(S1): task list');
    }
    /** Register `session` as the holder; appends to `sessionIds`. TODO(S1). */
    async claim(taskId, session, actor) {
        void taskId;
        void session;
        void actor;
        throw new Error('TODO(S1): task claim');
    }
    /** Single entry point for every transition; compare-and-set on revision. TODO(S1). */
    async mutate(taskId, expectedRevision, change, actor) {
        void taskId;
        void expectedRevision;
        void change;
        void actor;
        throw new Error('TODO(S1): task mutate');
    }
    /** Wake rules that reached their target, for task-wake. TODO(S1). */
    async wakeRules() {
        throw new Error('TODO(S1): task wakeRules');
    }
    /** Fold the authoritative domain event stream into the record; invariant basis. TODO(S1). */
    static fold(events) {
        void events;
        throw new Error('TODO(S1): task fold');
    }
}
//# sourceMappingURL=index.js.map