/**
 * The task domain declaration: the zod envelope schemas and the `defineDomain`
 * spec the provider opens. Split of validation duties: zod checks the durable
 * envelopes (ids, revision, actor, operation) at the medium boundary; the
 * mutation and view semantics are re-derived by `fold` on load, which fails
 * loud on anything zod cannot see (illegal transition, revision gap, dangling
 * project reference).
 * @module @task-center/task-local/src/spec
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ProjectDomainEvent, ProjectId, TaskDomainEvent, TaskEventId, TaskId, TaskOperation } from '@task-center/task'

/** TaskId schema at the durable boundary; branding has no runtime representation. */
const taskId = z.string().transform(value => value as TaskId)

/** ProjectId schema at the durable boundary. */
const projectId = z.string().transform(value => value as ProjectId)

/** EventId schema at the durable boundary. */
const eventId = z.string().transform(value => value as TaskEventId)

/** The closed actor union; sessionId brands at the boundary. */
const actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), sessionId: z.string().transform(SessionId) }),
  z.object({ kind: z.literal('human') }),
  z.object({ kind: z.literal('wake') }),
  z.object({ kind: z.literal('system') }),
])

/** The closed task operation set; the fold enforces each verb's transition rules. */
const taskOperation = z.enum([
  'create', 'claim', 'progress', 'block', 'submit', 'approve', 'reject', 'release',
  'subtask-add', 'subtask-remove',
  'abandon', 'edit', 'wake-set', 'wake-clear', 'patrol',
] satisfies [TaskOperation, ...TaskOperation[]])

/** The closed project operation set. */
const projectOperation = z.enum(['project-create', 'project-rename', 'project-archive'])

/**
 * Durable envelope of one stored task event. `mutation` and `task` stay opaque
 * records here: their per-verb semantics are owned by the fold, not the medium.
 */
const storedTaskEvent = z.object({
  eventId,
  taskId,
  revision: z.number().int().positive(),
  actor,
  at: z.string(),
  change: z.object({
    kind: z.literal('task/change'),
    version: z.literal(1),
    operation: taskOperation,
    taskId,
    revision: z.number().int().positive(),
    mutation: z.record(z.string(), z.unknown()),
    task: z.record(z.string(), z.unknown()),
  }),
}).transform(event => event as unknown as TaskDomainEvent)

/** Durable envelope of one stored project event, opaque the same way. */
const storedProjectEvent = z.object({
  eventId,
  projectId,
  revision: z.number().int().positive(),
  actor,
  at: z.string(),
  change: z.object({
    kind: z.literal('project/change'),
    version: z.literal(1),
    operation: projectOperation,
    projectId,
    revision: z.number().int().positive(),
    mutation: z.record(z.string(), z.unknown()),
    project: z.record(z.string(), z.unknown()),
  }),
}).transform(event => event as unknown as ProjectDomainEvent)

/** Either family of the shared ledger, discriminated by its change kind. */
export const storedLedgerEvent = z.union([storedTaskEvent, storedProjectEvent])

/**
 * The task domain spec: one `events` table carrying the append-only stream of
 * both families. The KV key is the fixed-width append sequence (stream order);
 * the opaque `eventId` lives inside the record.
 */
export const taskDomainSpec = defineDomain({
  name: 'task',
  version: 1,
  tables: { events: domainTable<string, TaskDomainEvent | ProjectDomainEvent>(storedLedgerEvent) },
})
