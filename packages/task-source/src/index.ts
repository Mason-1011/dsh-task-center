/**
 * `task-source`: the extraction layer of the task seam — watches dsh's own
 * session records and births task candidates from work the user already
 * started, so task creation is never a ceremony beside the conversation.
 * This slice carries the trigger skeleton (per-session watermarks, the idle
 * scan, disposed-session immediacy) and the goal tier: an unfinished goal in
 * an idle session becomes a pending candidate; a finished or cleared goal
 * supersedes its pending candidate. The tier is model-free — one pure read of
 * the session log plus ledger writes.
 * Spec: docs/design/06-extraction.md §4–§6.
 * @module @task-center/task-source
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GoalChangeMeta, GoalPhase } from '@deepseek-ai/dsh-goal'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
// Type-only: carries the `tasks` service augmentation into the build program.
import type { TaskActor } from '@task-center/task'

/** Cordis plugin name. */
export const name = 'task-source'

/** The task seam and the session store must be present. */
export const inject = ['tasks', 'sessions']

/** Deployment knobs for the extractor (no hardcoded tunables). */
export interface Config {
  /** Scan cadence in seconds. Required, positive. */
  readonly pollSeconds: number
  /** Session silence in hours before extraction is attempted. Required, positive. */
  readonly idleHours: number
}

/** One goal's durable facts as read from a session log. */
export interface GoalFact {
  /** Stable goal identity; doubles as the candidate origin key. */
  readonly id: string
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: { readonly code: string; readonly message: string }
}

/** Latest goal state per goal id; `'cleared'` is a clear tombstone. */
export type GoalFold = ReadonlyMap<string, GoalFact | 'cleared'>

/**
 * Fold one session log's `goal/change` events to the latest fact per goal id.
 * Later snapshots replace earlier ones wholesale; a clear tombstone pins the
 * goal as cleared instead of deleting it, so the next extraction can still
 * supersede the goal's pending candidate.
 * @param events - the complete session log, in seq order.
 * @returns the latest goal fact (or `'cleared'`) keyed by goal id.
 */
export function foldGoals(events: readonly SessionEvent[]): GoalFold {
  const goals = new Map<string, GoalFact | 'cleared'>()
  for (const event of events) {
    if (event.type !== 'goal/change') continue
    const change: GoalChangeMeta = event.data
    if (change.operation === 'clear') {
      goals.set(change.cleared.id, 'cleared')
      continue
    }
    goals.set(change.goal.id, {
      id: change.goal.id,
      objective: change.goal.objective,
      phase: change.goal.phase,
      ...change.goal.blockedReason === undefined ? {} : {
        blockedReason: { code: change.goal.blockedReason.code, message: change.goal.blockedReason.message },
      },
    })
  }
  return goals
}

/** Whether one folded goal still needs work before it can birth a candidate. */
function unfinished(fact: GoalFact | 'cleared'): fact is GoalFact {
  return fact !== 'cleared' && fact.phase !== 'complete'
}

/**
 * Extract candidates from one session's goal tier: every unfinished goal with
 * no same-origin candidate yet becomes a pending candidate, and every finished
 * or cleared goal supersedes its pending candidate. A candidate in any status
 * suppresses re-birth (v1 dedup: an ignored origin stays ignored — the
 * "re-appeared after ignore" marker is a later slice). Model-free.
 * @param ctx - Context carrying `tasks`.
 * @param session - the session whose log is read.
 */
export async function extractSession(ctx: Context, session: Session): Promise<void> {
  const logger = ctx.logger('task-source')
  const source: TaskActor = { kind: 'source' }
  for (const [goalId, fact] of foldGoals(session.events)) {
    const origin = { sessionId: session.id, tier: 'goal' as const, key: goalId }
    const existing = ctx.tasks.candidateByOrigin(origin)
    if (!unfinished(fact)) {
      // Finished work must not wait in 待确认 forever: its pending candidate
      // retires; every other status already spoke its verdict.
      if (existing?.record.status === 'pending') {
        const reason = fact === 'cleared' ? 'goal 已清除' : 'goal 已完结'
        const superseded = await ctx.tasks.candidateSupersede(existing.record.id, existing.record.revision, reason, source)
        if ('code' in superseded) logger.warn('supersede rejected', { sessionId: session.id, goalId, code: superseded.code })
      }
      continue
    }
    if (existing !== undefined) continue
    const created = await ctx.tasks.candidateCreate({
      objective: fact.objective,
      ...fact.blockedReason === undefined ? {} : { note: `goal 阻塞中(${fact.blockedReason.code}): ${fact.blockedReason.message}` },
      origin,
    }, source)
    if ('code' in created) logger.warn('candidate create rejected', { sessionId: session.id, goalId, code: created.code })
  }
}

/** Per-session trigger state: what happened, and what extraction has covered. */
interface Watermark {
  /** Seq of the newest event seen; moves on every `session/event`. */
  lastSeq: number
  /** Epoch ms of the newest event seen; the idle clock's anchor. */
  lastEventTime: number
  /** The `lastSeq` snapshot the last extraction covered; -1 means never. */
  extractedThrough: number
}

/**
 * Seed one watermark from a session's current log; an empty log never arms.
 * The `session/end-seed` marker is store bookkeeping stamped at attach time,
 * not session activity — skipping it anchors the idle clock to the last
 * durable event, so a session restored from disk can already be idle at boot.
 */
function seed(session: Session): Watermark {
  let lastSeq = -1
  let lastEventTime = Number.NaN
  for (const event of session.events) {
    if (event.type === 'session/end-seed') continue
    lastSeq = event.seq
    lastEventTime = event.time
  }
  return {
    lastSeq,
    lastEventTime: Number.isNaN(lastEventTime) ? Date.now() : lastEventTime,
    extractedThrough: -1,
  }
}

/**
 * Arm the watermark tracker and the idle scan. The first scan runs inside
 * `apply` (the boot sweep over every live session — restored histories get
 * their first extraction without waiting a full poll interval); later scans
 * run on the timer and only re-extract sessions with activity since their
 * last extraction. A disposed session extracts immediately on the event, not
 * at the next idle gate — disposal is the last chance to read it.
 * @param ctx - Plugin context.
 * @param config - Scan cadence and the idle threshold in hours.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!Number.isFinite(config.pollSeconds) || config.pollSeconds <= 0) {
    throw new Error('task-source: pollSeconds must be a positive number of seconds')
  }
  if (!Number.isFinite(config.idleHours) || config.idleHours <= 0) {
    throw new Error('task-source: idleHours must be a positive number of hours')
  }
  const logger = ctx.logger('task-source')
  const idleMs = config.idleHours * 3_600_000
  const watermarks = new Map<SessionId, Watermark>()

  ctx.on('session/event', (session, event) => {
    const mark = watermarks.get(session.id) ?? seed(session)
    watermarks.set(session.id, mark)
    if (event.seq > mark.lastSeq) {
      mark.lastSeq = event.seq
      mark.lastEventTime = event.time
    }
  })

  ctx.on('session/disposed', session => {
    watermarks.delete(session.id)
    void extractSession(ctx, session).catch(error => logger.warn('disposed extraction failed', { sessionId: session.id, error }))
  })

  const extract = async (session: Session, mark: Watermark): Promise<void> => {
    const covered = mark.lastSeq
    await extractSession(ctx, session)
    // Events appended during the await stay ahead of the watermark: only the
    // snapshot the fold actually covered advances it.
    mark.extractedThrough = covered
  }

  const tick = async (): Promise<void> => {
    const now = Date.now()
    for (const session of ctx.sessions.list()) {
      const mark = watermarks.get(session.id) ?? seed(session)
      watermarks.set(session.id, mark)
      // No activity since the last extraction, or not idle enough: skip.
      if (mark.extractedThrough >= mark.lastSeq) continue
      if (now - mark.lastEventTime < idleMs) continue
      await extract(session, mark)
    }
  }

  await tick()
  const timer = setInterval(() => void tick().catch(error => logger.warn('tick failed', { error })), config.pollSeconds * 1000)
  ctx.effect(() => () => clearInterval(timer))
}
