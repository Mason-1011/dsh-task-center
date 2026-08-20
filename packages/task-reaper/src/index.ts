/**
 * `task-reaper`: the liveness face of the task seam — it releases holds whose
 * session is gone, so a leaked hold never wedges a task. Two exact signals,
 * no staleness guessing: `session/disposed` (a session ended while still
 * holding) and the boot sweep (after a process crash every ledger holder is
 * absent from the fresh in-memory store). Releases commit as the `system`
 * actor — domain events only, honest attribution, no session receipt.
 * The fold pins the system actor to `release` alone; liveness itself is
 * judged here, outside the ledger.
 * @module dsh-task-center-task-reaper
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: carries the Context.tasks augmentation into src-only builds.
import type {} from 'dsh-task-center-task'

/** Cordis plugin name. */
export const name = 'task-reaper'

/**
 * The task seam and the live-session store must be present. `agentLoop` is
 * injected for ordering only: its startup creates config agents before this
 * plugin's boot sweep runs, so freshly created holders are never misread.
 */
export const inject = ['tasks', 'sessions', 'agentLoop']

/** Whether one task's hold may be released; review awaits the human verdict. */
function releasable(view: { readonly archived: boolean; readonly record: { readonly status: string } }): boolean {
  if (view.archived) return false
  const { status } = view.record
  return status === 'active' || status === 'blocked'
}

/**
 * Register the disposal listener and run the boot sweep — the listener first,
 * so no disposal between registration and the sweep escapes.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  const logger = ctx.logger('task-reaper')

  /** Release every releasable hold of one session; per-task failures stay contained. */
  const releaseHeldBy = async (sessionId: SessionId, cause: string): Promise<void> => {
    for (const view of ctx.tasks.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })) {
      if (!releasable(view) || view.record.holder !== sessionId) continue
      try {
        const released = await ctx.tasks.mutate(view.record.id, view.record.revision, { operation: 'release' }, { kind: 'system' })
        if ('code' in released) throw new Error(released.code)
        logger.info('released dead hold', { taskId: view.record.id, sessionId, cause })
      } catch (error) {
        // A concurrent mutation raced the CAS; the ledger keeps the first write and the next signal retries.
        logger.warn('dead-hold release failed', { taskId: view.record.id, error })
      }
    }
  }

  ctx.on('session/disposed', session => void releaseHeldBy(session.id, 'session disposed')
    .catch(error => logger.warn('disposal sweep failed', { error })))

  /** After a restart, every pre-boot holder is dead; live ones are in the store. */
  const sweep = async (): Promise<void> => {
    const dead = new Set<SessionId>()
    for (const view of ctx.tasks.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })) {
      const holder = view.record.holder
      if (holder !== undefined && releasable(view) && ctx.sessions.get(holder) === undefined) dead.add(holder)
    }
    for (const sessionId of dead) await releaseHeldBy(sessionId, 'boot sweep after restart')
  }
  void sweep().catch(error => logger.warn('boot sweep failed', { error }))
}
