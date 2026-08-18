/**
 * The task ledger store port. The seam owns the contract; a provider
 * (`@task-center/task-local`, slice 2) supplies the durable implementation over
 * the dsh storage domain. Tasks, projects, and candidates share one stream.
 * Stores assign `eventId` on append and resolve only after the event is
 * durable, so the service publishes after commit.
 * @module @task-center/task/store
 */

import { randomUUID } from 'node:crypto'
import type { CandidateDomainEvent, ProjectDomainEvent, TaskDomainEvent, TaskEventId, TaskId } from './types.ts'

/** One ledger event, minus the store-assigned id. */
export type LedgerEventInput = Omit<TaskDomainEvent, 'eventId'> | Omit<ProjectDomainEvent, 'eventId'> | Omit<CandidateDomainEvent, 'eventId'>

/** One committed event of any family. */
export type LedgerEvent = TaskDomainEvent | ProjectDomainEvent | CandidateDomainEvent

/** Append-only access to the authoritative domain event stream. */
export interface TaskStore {
  /** All committed events, stream order. */
  events(): readonly LedgerEvent[]
  /**
   * Append one event; resolves only after the event is committed. Store order
   * and `eventId` assignment are the store's responsibility.
   */
  append(event: LedgerEventInput): Promise<void>
  /** The domain-global archive set derived from the stream. */
  archived(): ReadonlySet<TaskId>
}

/** In-memory TaskStore: the default ledger for tests and single-run use. */
export class MemoryTaskStore implements TaskStore {
  private readonly log: LedgerEvent[] = []

  events(): readonly LedgerEvent[] {
    return this.log
  }

  async append(event: LedgerEventInput): Promise<void> {
    this.log.push({ ...event, eventId: randomUUID() as TaskEventId })
  }

  archived(): ReadonlySet<TaskId> {
    const archived = new Set<TaskId>()
    for (const event of this.log) {
      const change = event.change
      if (change.kind === 'task/change' && change.operation === 'abandon') archived.add(change.taskId)
    }
    return archived
  }
}
