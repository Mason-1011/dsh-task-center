/**
 * `task-source`: the extraction layer of the task seam — watches dsh's own
 * session records and births task candidates from work the user already
 * started, so task creation is never a ceremony beside the conversation.
 * The trigger skeleton (per-session watermarks, the idle scan, disposed
 * session immediacy) carries three structural tiers, all model-free reads of
 * the session log: an unfinished goal births a candidate (a finished or
 * cleared one retires it), a user-approved plan whose work shows no positive
 * completion evidence births one, and a session with unfinished todos and
 * neither of the above births one anchored to the user's own words. Tier
 * priority: goal over approved plan over todo — the three are often three
 * shadows of one piece of work.
 * Spec: docs/design/06-extraction.md §4–§6.
 * @module @task-center/task-source
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GoalChangeMeta, GoalPhase } from '@deepseek-ai/dsh-goal'
import type { Session, SessionEvent, SessionId, TodoItem, UserMessage } from '@deepseek-ai/dsh-session'
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

/** The exit-plan tool's name, matched on `tool/call` events. */
const EXIT_PLAN_MODE = 'exit_plan_mode'

/** The plan's first markdown heading text; the tool guarantees the plan starts with an H1. */
function headingTitle(plan: string): string {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match !== null) return match[1]!
  }
  return plan.trim()
}

/** A plan the user approved through the exit-plan review, as read from one session log. */
export interface PlanFact {
  /** The plan's first heading — the objective draft. */
  readonly title: string
  /** The complete plan markdown — the note body. */
  readonly plan: string
  /** The latest todo snapshot's state; `none` when the session never wrote todos. */
  readonly todos: 'none' | 'unfinished' | 'done'
  /** Whether any assistant message or further tool call followed this approval. */
  readonly activityAfterApproval: boolean
}

/**
 * Fold one session log to the latest user-approved plan. An `exit_plan_mode`
 * call paired with an error-free `tool/result` is exactly the approved path —
 * a rejection or a dismissed review throws inside the tool, so the result
 * carries `error` — and `/plan off` never issues this call, so the approval
 * evidence does not depend on the deferred `plan/mode` flip. The latest
 * approval wins; activity is measured from it.
 * @param events - the complete session log, in seq order.
 * @returns the approved plan's facts, or undefined when none was approved.
 */
export function foldApprovedPlan(events: readonly SessionEvent[]): PlanFact | undefined {
  const argumentsByCall = new Map<string, string>()
  let approved: { title: string; plan: string; seq: number } | undefined
  let todos: PlanFact['todos'] = 'none'
  let activity = false
  for (const event of events) {
    if (event.type === 'tool/call') {
      if (event.data.name === EXIT_PLAN_MODE) argumentsByCall.set(event.data.callId, event.data.arguments)
      if (approved !== undefined && event.seq > approved.seq) activity = true
    } else if (event.type === 'tool/result') {
      const block = event.data.message.content[0]!
      if (event.data.error === undefined && argumentsByCall.has(block.toolCallId)) {
        // Approval implies the tool accepted the arguments, so the JSON parse
        // cannot fail on a log this tool produced.
        const args = JSON.parse(argumentsByCall.get(block.toolCallId)!) as { plan: string }
        approved = { title: headingTitle(args.plan), plan: args.plan, seq: event.seq }
        activity = false
      }
    } else if (event.type === 'assistant/message') {
      if (approved !== undefined && event.seq > approved.seq) activity = true
    } else if (event.type === 'todo/write') {
      const entries = event.data.todos
      todos = entries.every(item => item.status === 'completed') ? 'done' : 'unfinished'
    }
  }
  return approved === undefined
    ? undefined
    : { title: approved.title, plan: approved.plan, todos, activityAfterApproval: activity }
}

/** The todo tier's folded facts: the newest chain's anchor plus today's unfinished entries. */
export interface TodoFact {
  /** Seq of the human message that triggered the newest chain; null when none precedes it. */
  readonly anchorSeq: number | null
  /** That message's first non-empty line — the objective draft in the user's own words. */
  readonly anchorText: string
  /** Unfinished entries of the latest todo snapshot. */
  readonly unfinished: readonly TodoItem[]
}

/** Text blocks of one user message joined by newlines. */
function messageText(message: UserMessage): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** First non-empty line: the objective draft stays scannable on long messages. */
function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}

/**
 * Fold one session log's todo tables. Adjacent `todo/write` snapshots are
 * diffed: entries new to a snapshot open a chain anchored to the nearest
 * preceding human message (plugin notices, tool results, and model steering
 * are not human — `source.kind === 'user'` is); the latest snapshot supplies
 * the unfinished entries. The newest chain wins; several chains in one
 * session merge into it (design §10.4).
 * @param events - the complete session log, in seq order.
 * @returns the anchor and unfinished entries, or undefined when the session never wrote todos.
 */
export function foldTodos(events: readonly SessionEvent[]): TodoFact | undefined {
  let latest: TodoItem[] | undefined
  let previous = new Set<string>()
  let anchor: { seq: number; text: string } | null = null
  let lastHuman: { seq: number; text: string } | null = null
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      lastHuman = { seq: event.seq, text: messageText(event.data) }
    } else if (event.type === 'todo/write') {
      const entries = event.data.todos
      if (entries.some(item => !previous.has(item.content))) anchor = lastHuman
      previous = new Set(entries.map(item => item.content))
      latest = entries
    }
  }
  if (latest === undefined) return undefined
  return {
    anchorSeq: anchor?.seq ?? null,
    anchorText: anchor === null ? '' : firstLine(anchor.text),
    unfinished: latest.filter(item => item.status !== 'completed'),
  }
}

/**
 * Extract candidates from one session's three structural tiers. Birth follows
 * tier priority — goal over approved plan over anchored todo, since the three
 * are often shadows of one piece of work — and same-origin dedup: a candidate
 * in any status suppresses re-birth (an ignored origin stays ignored).
 * Retirement is tier-independent: positive completion evidence (a finished
 * goal, an all-completed todo table) retires that tier's pending candidates
 * whenever it appears. Model-free.
 * @param ctx - Context carrying `tasks`.
 * @param session - the session whose log is read.
 */
export async function extractSession(ctx: Context, session: Session): Promise<void> {
  const logger = ctx.logger('task-source')
  const source: TaskActor = { kind: 'source' }

  const supersedePending = async (tier: 'plan' | 'todo', reason: string): Promise<void> => {
    for (const view of ctx.tasks.candidates()) {
      const { origin, status, id, revision } = view.record
      if (origin.sessionId !== session.id || origin.tier !== tier || status !== 'pending') continue
      const retired = await ctx.tasks.candidateSupersede(id, revision, reason, source)
      if ('code' in retired) logger.warn('supersede rejected', { sessionId: session.id, tier, code: retired.code })
    }
  }

  // Goal tier: one candidate per unfinished goal; a finished or cleared goal
  // retires its own pending candidate.
  let goalOwned = false
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
    goalOwned = true
    if (existing !== undefined) continue
    const created = await ctx.tasks.candidateCreate({
      objective: fact.objective,
      ...fact.blockedReason === undefined ? {} : { note: `goal 阻塞中(${fact.blockedReason.code}): ${fact.blockedReason.message}` },
      origin,
    }, source)
    if ('code' in created) logger.warn('candidate create rejected', { sessionId: session.id, goalId, code: created.code })
  }

  // Approved-plan tier: the plan is born unless positive evidence says the
  // work finished — an all-completed todo table is that evidence; a session
  // that never tracked todos counts as unfinished until model activity
  // followed the approval (work at least started; a stall is the summarizer
  // tier's case, not this one's).
  const plan = foldApprovedPlan(session.events)
  if (plan !== undefined) {
    if (plan.todos === 'done') {
      await supersedePending('plan', '计划步骤已全部完成')
    } else if (!goalOwned && (plan.todos === 'unfinished' || !plan.activityAfterApproval)) {
      // The plan's first heading is the origin key: a re-approved revision of
      // the same plan keeps one origin, a genuinely different plan is new.
      const origin = { sessionId: session.id, tier: 'plan' as const, key: plan.title }
      if (ctx.tasks.candidateByOrigin(origin) === undefined) {
        const created = await ctx.tasks.candidateCreate({ objective: plan.title, note: plan.plan, origin }, source)
        if ('code' in created) logger.warn('candidate create rejected', { sessionId: session.id, tier: 'plan', code: created.code })
      }
    }
  }

  // Anchored-todo tier: only when neither structural elder claimed the
  // session — an unfinished goal or an approved plan subsumes the todo chain.
  const todos = foldTodos(session.events)
  if (todos !== undefined) {
    if (todos.unfinished.length > 0) {
      if (!goalOwned && plan === undefined && todos.anchorSeq !== null) {
        const origin = { sessionId: session.id, tier: 'todo' as const, key: `seq:${todos.anchorSeq}` }
        if (ctx.tasks.candidateByOrigin(origin) === undefined) {
          const note = todos.unfinished.map(item => `- ${item.content}`).join('\n')
          const created = await ctx.tasks.candidateCreate({ objective: todos.anchorText, note, origin }, source)
          if ('code' in created) logger.warn('candidate create rejected', { sessionId: session.id, tier: 'todo', code: created.code })
        }
      }
    } else {
      await supersedePending('todo', 'todo 已全部完成')
    }
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
