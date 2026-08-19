/**
 * Materialization: mapped event logs written as REAL dsh sessions under the
 * sessions root, so the task-source sweep finds them through its own history
 * enumeration and its judgment gates do all task birthing. One cordis context
 * per run; identity is `cc-<uuid>` and idempotency is a `list()` pre-check —
 * `sessions.create` silently adopts an existing id instead of throwing.
 * @module @task-center/cc-import/materialize
 */

import { mkdir } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence, { type JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'

/** The durable session id a CC transcript materializes under. */
export function ccSessionId(sessionUuid: string): string {
  return `cc-${sessionUuid}`
}

/** One session to materialize: identity, header metadata, and the mapped log. */
export interface MaterializeInput {
  readonly id: string
  readonly cwd: string | undefined
  readonly createdAt: number | undefined
  readonly events: readonly SessionEvent[]
}

/** Where and how the sessions root writes. */
export interface MaterializeOptions {
  readonly root: string
  readonly compression?: JsonlCompression
}

/** What one run did, per session. */
export interface MaterializeReport {
  readonly created: readonly { id: string; events: number }[]
  readonly skipped: readonly string[]
}

/**
 * Write every input as a durable dsh session, skipping ids already stored.
 * The seed carries the backdated event times (and the header its createdAt),
 * so imported history keeps its original age for the extractor's idle gates.
 * @param inputs - mapped sessions in any order.
 * @param options - sessions root and physical encoding.
 * @returns which ids were created (with event counts) and which were skipped.
 */
export async function materializeSessions(inputs: readonly MaterializeInput[], options: MaterializeOptions): Promise<MaterializeReport> {
  await mkdir(options.root, { recursive: true })
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SessionStore),
    await ctx.plugin(JsonlSessionPersistence, {
      root: options.root,
      ...options.compression === undefined ? {} : { compression: options.compression },
      writeBatchMaxDelayMs: 1,
    }),
  ]
  try {
    // `create` adopts an existing id silently — the skip decision is ours.
    const existing = new Set((await ctx.sessionPersistence.list()).map(header => header.id as string))
    const created: { id: string; events: number }[] = []
    const skipped: string[] = []
    for (const input of inputs) {
      if (input.events.length === 0) {
        skipped.push(input.id)
        continue
      }
      if (existing.has(input.id)) {
        skipped.push(input.id)
        continue
      }
      ctx.sessions.create(SessionId(input.id), {
        seed: input.events,
        ...input.cwd === undefined && input.createdAt === undefined
          ? {}
          : {
            meta: {
              ...input.cwd === undefined ? {} : { cwd: input.cwd },
              ...input.createdAt === undefined ? {} : { createdAt: input.createdAt },
            },
          },
      })
      created.push({ id: input.id, events: input.events.length })
    }
    // The write path batches; let the seeded logs land before teardown.
    await new Promise(resolve => setTimeout(resolve, 100))
    return { created, skipped }
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
}
