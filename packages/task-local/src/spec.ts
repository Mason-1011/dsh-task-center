/**
 * The task domain declaration: the zod envelope schema and the `defineDomain`
 * spec the provider opens. Split of validation duties: zod checks the durable
 * envelope (ids, revision, actor, operation) at the medium boundary; the
 * mutation and view semantics are re-derived by `foldTasks` on load, which
 * fails loud on any envelope zod cannot see (illegal transition, revision gap).
 * @module @task-center/task-local/src/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { TaskDomainEvent, TaskEventId, TaskId, TaskOperation } from '@task-center/task'

/** TaskId schema at the durable boundary; branding has no runtime representation. */
const taskId = z.string().transform(value => value as TaskId)

/** EventId schema at the durable boundary. */
const eventId = z.string().transform(value => value as TaskEventId)

/** The closed actor union; sessionId brands at the boundary. */
const actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), sessionId: z.string().transform(SessionId) }),
  z.object({ kind: z.literal('human') }),
  z.object({ kind: z.literal('wake') }),
])

/** The closed operation set; the fold enforces each verb's transition rules. */
const operation = z.enum([
  'create', 'claim', 'progress', 'block', 'submit', 'approve', 'reject',
  'abandon', 'edit', 'wake-set', 'wake-clear',
] satisfies [TaskOperation, ...TaskOperation[]])

/**
 * Durable envelope of one stored event. `mutation` and `task` stay opaque
 * records here: their per-verb semantics are owned by the fold, not the medium.
 */
export const storedTaskEvent = z.object({
  eventId,
  taskId,
  revision: z.number().int().positive(),
  actor,
  at: z.string(),
  change: z.object({
    kind: z.literal('task/change'),
    version: z.literal(1),
    operation,
    taskId,
    revision: z.number().int().positive(),
    mutation: z.record(z.string(), z.unknown()),
    task: z.record(z.string(), z.unknown()),
  }),
}).transform(event => event as unknown as TaskDomainEvent)

/**
 * The task domain spec: one `events` table carrying the append-only domain
 * stream. The KV key is the fixed-width append sequence (stream order); the
 * opaque `eventId` lives inside the record.
 */
export const taskDomainSpec = defineDomain({
  name: 'task',
  version: 1,
  tables: { events: domainTable<string, TaskDomainEvent>(storedTaskEvent) },
})
