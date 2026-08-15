/**
 * The task ledger store port. The seam owns the contract; a provider
 * (`@task-center/task-local`, slice 2) supplies the durable implementation over
 * the dsh storage domain. The in-memory default serves tests and single-run
 * compositions. Stores assign `eventId` on append and resolve only after the
 * event is durable, so the service publishes after commit.
 * @module @task-center/task/store
 */

import { randomUUID } from 'node:crypto'
import type { TaskDomainEvent, TaskEventId, TaskId } from './types.ts'

/** One committed event, minus the store-assigned id. */
export type TaskEventInput = Omit<TaskDomainEvent, 'eventId'>

/** Append-only access to the authoritative domain event stream. */
export interface TaskStore {
  /** All committed events, stream order. */
  events(): readonly TaskDomainEvent[]
  /**
   * Append one event; resolves only after the event is committed. Store order
   * and `eventId` assignment are the store's responsibility.
   */
  append(event: TaskEventInput): Promise<void>
  /** The domain-global archive set derived from the stream. */
  archived(): ReadonlySet<TaskId>
}

/** In-memory TaskStore: the default ledger for tests and single-run use. */
export class MemoryTaskStore implements TaskStore {
  private readonly log: TaskDomainEvent[] = []

  events(): readonly TaskDomainEvent[] {
    return this.log
  }

  async append(event: TaskEventInput): Promise<void> {
    this.log.push({ ...event, eventId: randomUUID() as TaskEventId })
  }

  archived(): ReadonlySet<TaskId> {
    const archived = new Set<TaskId>()
    for (const event of this.log) if (event.change.operation === 'abandon') archived.add(event.taskId)
    return archived
  }
}
