/**
 * Session-log receipt plumbing for this package's two domain events.
 *
 * The harness's known-event registry is generated at build time; it has no
 * registration surface for downstream plugins yet, so a log carrying a
 * `task/change` receipt is refused by every strict reader — including a stock
 * dsh opening a session this family has touched. Two guards close that gap
 * from this side: {@link registerReceiptTypes} adds the types to the runtime
 * registry (mutable today; a frozen future registry means the harness shipped
 * its own surface and this becomes a no-op), and {@link appendReceipt} marks
 * every receipt `ignorable` — the envelope contract's escape hatch a foreign
 * build uses to carry an event without interpreting it. The append option is
 * passed through a cast because published dsh-session types do not declare it
 * yet; runtimes without the support drop the extra key, which the runtime
 * registration already covers for reads inside a process that loaded this
 * package.
 *
 * @module @task-center/task/receipts
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'

/** The session-log event types this package writes. */
const RECEIPT_TYPES = ['task/change', 'task/context-injected'] as const

/**
 * Make the receipt types known to the persistence read path of this process.
 * Idempotent; a no-op once the registry is frozen (the harness then owns the
 * vocabulary itself).
 */
export function registerReceiptTypes(): void {
  if (Object.isFrozen(KNOWN_SESSION_EVENT_TYPES)) return
  for (const type of RECEIPT_TYPES) (KNOWN_SESSION_EVENT_TYPES as Set<string>).add(type)
}

/** Append options this package needs: the envelope's ignorable marker. */
interface ReceiptIntent {
  ignorable?: true
}

/**
 * Append one domain receipt marked `ignorable`, so a build that does not know
 * the type carries it instead of refusing the log.
 * @param session - the live session receiving the receipt.
 * @param type - one of the two receipt types this package declares.
 * @param data - the receipt payload.
 * @returns the appended event.
 */
export function appendReceipt<T extends (typeof RECEIPT_TYPES)[number]>(session: Session, type: T, data: SessionEventMap[T]): SessionEvent<T> {
  return (session as unknown as {
    append<U extends SessionEventType>(receiptType: U, receiptData: SessionEventMap[U], intent: ReceiptIntent): SessionEvent<U>
  }).append(type, data, { ignorable: true })
}
