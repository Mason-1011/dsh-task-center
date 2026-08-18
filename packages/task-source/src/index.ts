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
 * shadows of one piece of work. A session where no structural tier spoke at
 * all falls to the summarizer tier: one model session judges the three
 * necessary conditions against the conversation, quota-probed and per-tick
 * capped.
 * Spec: docs/design/06-extraction.md §4–§6.
 * @module @task-center/task-source
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: carries the Context.agentLoop augmentation into src-only builds
// (the emit path cannot lean on test files importing the module).
import type AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { GoalChangeMeta, GoalPhase } from '@deepseek-ai/dsh-goal'
import { createUserMessage, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, TodoItem, UserMessage } from '@deepseek-ai/dsh-session'
// Type-only: carries the `tasks` service augmentation into the build program.
import type { TaskActor } from '@task-center/task'

/** Cordis plugin name. */
export const name = 'task-source'

/** The task seam, the session store, the agent factory, and the model-call service must be present. */
export const inject = ['tasks', 'sessions', 'agentLoop', 'llm']

/** Deployment knobs for the extractor (no hardcoded tunables). */
export interface Config {
  /** Scan cadence in seconds. Required, positive. */
  readonly pollSeconds: number
  /** Session silence in hours before extraction is attempted. Required, positive. */
  readonly idleHours: number
  /** Model route for summarizer sessions. Both fields required. */
  readonly agent: { readonly provider: string; readonly model: string }
  /** Summarizer sessions one tick may start; over-cap sessions defer to the next tick. Required, positive integer. */
  readonly summariesPerTick: number
  /** Recent conversation messages the summarizer prompt carries. Required, positive integer. */
  readonly transcriptEvents: number
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

/** What one session's structural extraction left for the summarizer tier. */
export interface SummaryRequest {
  /** The session the transcript came from; also the candidate origin's session. */
  readonly sessionId: SessionId
  /** Seq of the session's last event; the summarizer session id embeds it, so one activity burst summarizes once. */
  readonly lastSeq: number
  /** Rendered conversation lines, newest last, at most the configured window. */
  readonly transcript: readonly string[]
}

/**
 * Render the conversation a summary is judged over: human messages and model
 * text answers, in log order. Plugin notices, tool results, and every
 * non-conversational record are skipped — the summarizer reads a dialogue,
 * not a debug log.
 */
function conversationLines(events: readonly SessionEvent[]): string[] {
  const lines: string[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      lines.push(`用户: ${messageText(event.data)}`)
    } else if (event.type === 'assistant/message') {
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text.trim() !== '') lines.push(`模型: ${text}`)
    }
  }
  return lines
}

/**
 * Extract candidates from one session's three structural tiers. Birth follows
 * tier priority — goal over approved plan over anchored todo, since the three
 * are often shadows of one piece of work — and same-origin dedup: a candidate
 * in any status suppresses re-birth (an ignored origin stays ignored).
 * Retirement is tier-independent: positive completion evidence (a finished
 * goal, an all-completed todo table) retires that tier's pending candidates
 * whenever it appears. The structural pass itself is model-free; a session
 * where no structural tier spoke at all yields a summary request instead, and
 * the caller owns the model spend.
 * @param ctx - Context carrying `tasks`.
 * @param session - the session whose log is read.
 * @param transcriptEvents - the conversation window handed to the summarizer.
 * @returns the summary request when the conversation is the only record, else undefined.
 */
export async function extractSession(ctx: Context, session: Session, transcriptEvents: number): Promise<SummaryRequest | undefined> {
  const logger = ctx.logger('task-source')
  const source: TaskActor = { kind: 'source' }

  const supersedePending = async (tier: 'plan' | 'todo' | 'summary', reason: string): Promise<void> => {
    for (const view of ctx.tasks.candidates()) {
      const { origin, status, id, revision } = view.record
      if (origin.sessionId !== session.id || origin.tier !== tier || status !== 'pending') continue
      const retired = await ctx.tasks.candidateSupersede(id, revision, reason, source)
      if ('code' in retired) logger.warn('supersede rejected', { sessionId: session.id, tier, code: retired.code })
    }
  }

  // Goal tier: one candidate per unfinished goal; a finished or cleared goal
  // retires its own pending candidate.
  const goals = foldGoals(session.events)
  let goalOwned = false
  for (const [goalId, fact] of goals) {
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
  // followed the approval (work at least started; a started-but-untracked
  // stall is owned by no tier in v1 — the summarizer only takes sessions
  // with no structural signal at all).
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

  // Summarizer tier: only when no structural tier ever spoke — no goal was
  // set, no plan approved, no todo written. The conversation is then the only
  // record, and one model session judges the three necessary conditions; a
  // session without a single human line has nothing to judge.
  if (goals.size === 0 && plan === undefined && todos === undefined) {
    const lines = conversationLines(session.events)
    if (lines.some(line => line.startsWith('用户: '))) {
      return {
        sessionId: session.id,
        lastSeq: session.events.at(-1)?.seq ?? -1,
        transcript: lines.slice(-transcriptEvents),
      }
    }
  }
  return undefined
}

/** The summarizer's judgment of one conversation: a task, or a reasoned none. */
export type SummaryVerdict =
  | { readonly objective: string; readonly acceptance: string; readonly note: string }
  | { readonly none: string }

/**
 * Parse the summarizer session's final answer. The prompt asks for one bare
 * JSON object; prose around it and markdown fences are tolerated, the last
 * balanced object wins. Anything that is not a well-formed `none` or a
 * full objective/acceptance pair is rejected — a verdict that fails to parse
 * births nothing.
 * @param text - the summarizer's final assistant text.
 * @returns the verdict, or undefined when no valid object is present.
 */
export function parseVerdict(text: string): SummaryVerdict | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record.none === 'string') return { none: record.none }
  if (typeof record.objective === 'string' && typeof record.acceptance === 'string') {
    return {
      objective: record.objective,
      acceptance: record.acceptance,
      note: typeof record.note === 'string' ? record.note : '',
    }
  }
  return undefined
}

/**
 * The summarizer session's single prompt: the three necessary conditions with
 * their positive and negative examples, the dedup list of standing
 * objectives, the conversation window, and the strict JSON answer contract.
 * @param request - the session summary extraction yielded.
 * @param existingObjectives - objectives of standing tasks and candidates, for dedup.
 * @returns the first user message text of the summarizer session.
 */
export function buildSummaryPrompt(request: SummaryRequest, existingObjectives: readonly string[]): string {
  const lines = [
    '[task-source] 会话总结抽取:下面是一条已被搁置的 dsh 会话记录。判断其中是否留下了一个未完成、值得跨会话跟进的任务。',
    '三必要条件,必须全部满足才算任务:',
    '1. 可命名的结果:一句话说清做成之后世界里多了什么(objective 是结果,不是动作:「支持暗色模式」✓,「看看暗色模式」✗)。',
    '2. 可判定的完成:写得出一条事后可检查的验收标准;写不出(纯讨论、开放探索、感受表达)不是任务。',
    '3. 未完成且需要后续:本会话内已做完、已解答的,不算任务,是历史。',
    '例:「为什么这里报错?」已解答 → 无任务;「聊聊这个架构」→ 无任务;「帮我加暗色模式」没做完 → 任务;「以后有空把首屏优化一下」→ 任务(搁置的意图正是要找回的东西)。',
  ]
  if (existingObjectives.length > 0) {
    lines.push('既有任务与候选的目标(与会话同一件事的判「无任务」,在原因里注明与哪条重复):')
    for (const objective of existingObjectives) lines.push(`- ${objective}`)
  }
  lines.push('会话记录(按时间先后,已截断到最近的消息):')
  lines.push(request.transcript.join('\n'))
  lines.push('只输出一个 JSON 对象,不要代码块,不要任何多余文字:')
  lines.push('判定有任务:{"objective": "结果一句话", "acceptance": "事后可检查的验收标准", "note": "补充说明,可空串"}')
  lines.push('判定无任务:{"none": "原因"}')
  return lines.join('\n')
}

/** The last non-empty assistant text of one session — the summarizer's answer. */
function lastAssistantText(session: Session): string {
  let text = ''
  for (const event of session.events) {
    if (event.type !== 'assistant/message') continue
    const joined = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (joined.trim() !== '') text = joined
  }
  return text
}

/**
 * Run the summarizer tier for one summary request: a fresh agent session on
 * the configured route judges the conversation, and its verdict births or
 * retires the session's single summary-tier candidate. The fixed origin key
 * `summary` keeps one candidate per session across re-summarizations — a
 * later `none` verdict on new activity retires the pending one; a task
 * verdict never re-births over any status. A failed session or an unparsable
 * verdict births nothing (宁缺毋滥) — the caller advances regardless, so one
 * activity burst costs at most one summarizer run.
 * @param ctx - Context carrying `tasks`, `agentLoop`, and `llm`.
 * @param config - the summarizer route.
 * @param request - the session summary extraction yielded.
 */
export async function summarize(ctx: Context, config: Config, request: SummaryRequest): Promise<void> {
  const logger = ctx.logger('task-source')
  const source: TaskActor = { kind: 'source' }
  const origin = { sessionId: request.sessionId, tier: 'summary' as const, key: 'summary' }
  const retire = async (reason: string): Promise<void> => {
    const existing = ctx.tasks.candidateByOrigin(origin)
    if (existing?.record.status !== 'pending') return
    const retired = await ctx.tasks.candidateSupersede(existing.record.id, existing.record.revision, reason, source)
    if ('code' in retired) logger.warn('supersede rejected', { sessionId: request.sessionId, tier: 'summary', code: retired.code })
  }

  const objectives = [
    ...ctx.tasks.list({ limit: Number.MAX_SAFE_INTEGER }).map(view => view.record.objective),
    ...ctx.tasks.candidates().map(view => view.record.objective),
  ]
  const agent = ctx.agentLoop.create(
    SessionId(`summary-${request.sessionId}-${request.lastSeq}`),
    config.agent,
  )
  const idle = agent.whenIdle()
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: buildSummaryPrompt(request, objectives) }],
    source: { kind: 'user' },
  }))
  try {
    await idle
  } catch (error) {
    logger.warn('summary session failed', { sessionId: request.sessionId, error })
    return
  }

  const verdict = parseVerdict(lastAssistantText(agent.session))
  if (verdict === undefined) {
    logger.warn('summary verdict unparsable', { sessionId: request.sessionId })
    return
  }
  if ('none' in verdict) {
    await retire(`总结判定无任务: ${verdict.none}`)
    return
  }
  // The three conditions gate here too: a blank objective or acceptance is a
  // none the model failed to phrase as one.
  if (verdict.objective.trim() === '' || verdict.acceptance.trim() === '') {
    await retire('总结判定无任务: 验收标准写不出')
    return
  }
  if (ctx.tasks.candidateByOrigin(origin) !== undefined) return
  const created = await ctx.tasks.candidateCreate({
    objective: verdict.objective,
    acceptance: verdict.acceptance,
    ...verdict.note === '' ? {} : { note: verdict.note },
    origin,
  }, source)
  if ('code' in created) logger.warn('candidate create rejected', { sessionId: request.sessionId, tier: 'summary', code: created.code })
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

/** Outcome of one preflight probe of the summarizer route. */
interface Probe {
  /** Whether the route still reports quota exhaustion. */
  readonly walled: boolean
  /** Provider-requested delay to hold further probes, when it sent one. */
  readonly holdMs?: number
}

/**
 * Arm the watermark tracker and the idle scan. The first scan runs inside
 * `apply` (the boot sweep over every live session — restored histories get
 * their first extraction without waiting a full poll interval); later scans
 * run on the timer and only re-extract sessions with activity since their
 * last extraction. A disposed session extracts immediately on the event, not
 * at the next idle gate — disposal is the last chance to read it. Summary
 * requests pay one model call each: every run is preceded by a quota probe of
 * the route (a positive QUOTA answer defers the request to a later tick) and
 * counts against the per-tick cap; a live session that gets deferred keeps
 * its watermark behind so the next tick retries, while a request whose
 * session was disposed first is queued — the tick is its only remaining
 * carrier.
 * @param ctx - Plugin context.
 * @param config - Scan cadence, idle threshold, summarizer route, and caps.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!Number.isFinite(config.pollSeconds) || config.pollSeconds <= 0) {
    throw new Error('task-source: pollSeconds must be a positive number of seconds')
  }
  if (!Number.isFinite(config.idleHours) || config.idleHours <= 0) {
    throw new Error('task-source: idleHours must be a positive number of hours')
  }
  if (config.agent.provider.trim() === '' || config.agent.model.trim() === '') {
    throw new Error('task-source: agent.provider and agent.model must name the summarizer sessions\' route')
  }
  if (!Number.isInteger(config.summariesPerTick) || config.summariesPerTick <= 0) {
    throw new Error('task-source: summariesPerTick must be a positive integer')
  }
  if (!Number.isInteger(config.transcriptEvents) || config.transcriptEvents <= 0) {
    throw new Error('task-source: transcriptEvents must be a positive integer')
  }
  const logger = ctx.logger('task-source')
  const idleMs = config.idleHours * 3_600_000
  const watermarks = new Map<SessionId, Watermark>()
  /** Summary requests whose session was disposed before they could run; ticks drain them. */
  const orphaned: SummaryRequest[] = []
  let probeHoldUntil = 0

  /**
   * One minimal request (no session identity) asking whether the route's quota
   * window reopened. Only a positive `QUOTA` answer defers; every other
   * finish — success, auth or transport error — and a thrown stream both mean
   * run: a broken probe never blocks work.
   */
  const probe = async (): Promise<Probe> => {
    const options: GenerateOptions = {
      provider: config.agent.provider,
      model: config.agent.model,
      maxTokens: 1,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'ping' }], source: { kind: 'user' } })],
    }
    try {
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk.type !== 'finish') continue
        if (chunk.reason.kind === 'error' && chunk.reason.failure.code === QUOTA_EXCEEDED_CODE) {
          const ms = chunk.reason.failure.providerRetryAfterMs
          return { walled: true, holdMs: ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : undefined }
        }
        return { walled: false }
      }
      return { walled: false }
    } catch (error) {
      // The stream contract keeps middleware and consumer failures thrown;
      // running the summary surfaces the real failure instead of silently
      // parking on a broken probe.
      logger.warn('probe failed; summarizing anyway', { error })
      return { walled: false }
    }
  }

  /**
   * Spend one summarizer run on a request, probe-gated. The summarize call
   * itself contains its failures; only the quota wall reports back.
   */
  const runSummary = async (request: SummaryRequest): Promise<'ran' | 'walled'> => {
    if (Date.now() < probeHoldUntil) return 'walled'
    const probed = await probe()
    if (probed.walled) {
      if (probed.holdMs !== undefined) probeHoldUntil = Date.now() + probed.holdMs
      logger.info('summary deferred: route still quota-exhausted', { sessionId: request.sessionId })
      return 'walled'
    }
    await summarize(ctx, config, request)
    return 'ran'
  }

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
    void (async () => {
      const request = await extractSession(ctx, session, config.transcriptEvents)
      if (request === undefined) return
      // Disposal is the last chance to read the session, so the cap does not
      // apply here; a walled route parks the request for the next tick.
      if (await runSummary(request) === 'walled') orphaned.push(request)
    })().catch(error => logger.warn('disposed extraction failed', { sessionId: session.id, error }))
  })

  const tick = async (): Promise<void> => {
    const now = Date.now()
    if (now < probeHoldUntil) return
    let budget = config.summariesPerTick
    // Disposed requests first: their sessions no longer appear in the scan,
    // so this queue is their only retry.
    while (orphaned.length > 0 && budget > 0) {
      const request = orphaned[0]!
      if (await runSummary(request) === 'walled') return
      orphaned.shift()
      budget--
    }
    for (const session of ctx.sessions.list()) {
      const mark = watermarks.get(session.id) ?? seed(session)
      watermarks.set(session.id, mark)
      // No activity since the last extraction, or not idle enough: skip.
      if (mark.extractedThrough >= mark.lastSeq) continue
      if (now - mark.lastEventTime < idleMs) continue
      const covered = mark.lastSeq
      const request = await extractSession(ctx, session, config.transcriptEvents)
      if (request === undefined) {
        mark.extractedThrough = covered
        continue
      }
      // Over-cap sessions defer: the watermark stays behind, so the next tick
      // re-extracts and retries.
      if (budget <= 0) continue
      budget--
      if (await runSummary(request) === 'walled') return
      // Events appended during the awaits stay ahead of the watermark: only
      // the snapshot the extraction actually covered advances it.
      mark.extractedThrough = covered
    }
  }

  await tick()
  const timer = setInterval(() => void tick().catch(error => logger.warn('tick failed', { error })), config.pollSeconds * 1000)
  ctx.effect(() => () => clearInterval(timer))
}
