/**
 * The task ledger store port. The seam owns the contract; a provider
 * (`@task-center/task-local`, slice 2) supplies the durable implementation over
 * the dsh storage domain. The in-memory default serves tests and single-run
 * compositions.
 * @module @task-center/task/store
 */

import type { TaskDomainEvent, TaskId } from './types.ts'

/** Append-only access to the authoritative domain event stream. */
export interface TaskStore {
  /** All committed events, stream order. */
  events(): readonly TaskDomainEvent[]
  /** Append one committed event. Order is the store's responsibility. */
  append(event: TaskDomainEvent): void
  /** The domain-global archive set derived from the stream. */
  archived(): ReadonlySet<TaskId>
}

/** In-memory TaskStore: the default ledger for tests and single-run use. */
export class MemoryTaskStore implements TaskStore {
  private readonly log: TaskDomainEvent[] = []

  events(): readonly TaskDomainEvent[] {
    return this.log
  }

  append(event: TaskDomainEvent): void {
    this.log.push(event)
  }

  archived(): ReadonlySet<TaskId> {
    const archived = new Set<TaskId>()
    for (const event of this.log) if (event.change.operation === 'abandon') archived.add(event.taskId)
    return archived
  }
}
