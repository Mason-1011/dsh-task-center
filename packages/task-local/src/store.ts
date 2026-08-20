/**
 * The durable TaskStore over one open task domain. Stream order lives in the
 * fixed-width KV key; each append writes through the domain's durability chain
 * before resolving, so the service publishes only committed state.
 * @module dsh-task-center-task-local/src/store
 */

import { randomUUID } from 'node:crypto'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { LedgerEvent, LedgerEventInput, TaskEventId, TaskId, TaskStore } from 'dsh-task-center-task'
import { taskDomainSpec } from './spec.ts'

/** KV key width; lexicographic order equals append order at any depth. */
const KEY_WIDTH = 12

/** TaskStore over the `events` table of one open task domain. */
export class DomainTaskStore implements TaskStore {
  private readonly table: KvTable<string, LedgerEvent>
  private nextSeq: number

  /**
   * @param domain - the open task domain; its in-memory state is authoritative
   * after the facility validated every stored record at open.
   */
  constructor(domain: Domain<typeof taskDomainSpec>) {
    this.table = domain.table('events')
    let max = 0
    for (const key of this.table.keys()) max = Math.max(max, Number(key))
    this.nextSeq = max + 1
  }

  events(): readonly LedgerEvent[] {
    return [...this.table.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, event]) => event)
  }

  async append(event: LedgerEventInput): Promise<void> {
    const key = String(this.nextSeq++).padStart(KEY_WIDTH, '0')
    await this.table.put(key, { ...event, eventId: randomUUID() as TaskEventId })
  }

  archived(): ReadonlySet<TaskId> {
    const archived = new Set<TaskId>()
    for (const event of this.events()) {
      const change = event.change
      if (change.kind === 'task/change' && change.operation === 'abandon') archived.add(change.taskId)
    }
    return archived
  }
}
