/**
 * `task-source`: the extraction layer of the task seam — watches dsh's own
 * session records and births task candidates from work the user already
 * started, so task creation is never a ceremony beside the conversation.
 * The trigger skeleton (per-session watermarks, the idle scan, disposed
 * session immediacy, and immediate structural passes — a goal being set, a
 * plan being approved, or todos being written births at once, while the idle
 * gate only serves the summarizer's chat-only fallback) carries three
 * structural tiers, all model-free reads of the session log: an unfinished goal births a candidate (a finished or
 * cleared one retires it), a user-approved plan whose work shows no positive
 * completion evidence births one, and a session with unfinished todos and
 * neither of the above births one anchored to the user's own words. Tier
 * priority: goal over approved plan over todo — the three are often three
 * shadows of one piece of work. A session where no structural tier spoke at
 * all falls to the summarizer tier: one model session judges the three
 * necessary conditions against the conversation, quota-probed and per-tick
 * capped. Machinery sessions (the summarizer's own, task-wake's fired and
 * patrol sessions) are never extraction sources: their transcripts are
 * prompts this family wrote, and their work already reaches the ledger
 * through reflow and patrol notes. The same skeleton also reflows progress: each turn a holding
 * session closes with todo or goal evidence writes one `progress` line into
 * every task it holds, so the ledger learns what the conversation did
 * without waiting for the model to report it — and a goal entering `blocked`
 * (non-quota) or `complete` mirrors into the held tasks' state: the ledger's
 * status follows the goal the conversation already recorded.
 * At boot a history sweep reads every stored session through the persistence
 * backend — not only the live ones — so a fresh install recovers the whole
 * backlog at once: structural tiers birth immediately (model-free), chat-only
 * history queues behind the same idle gate and per-tick cap. Durable marks
 * (the plugin's own storage domain) record what each session's extraction
 * already covered, so a restart re-reads no covered ground and re-pays no
 * summarizer run.
 * Spec: docs/design/06-extraction.md §4–§8.
 * @module @task-center/task-source
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: carries the agent subject event declarations (`agent/error`)
// into src-only builds; the listener never touches a runtime export.
import type {} from '@deepseek-ai/dsh-agent'
import type { GoalChangeMeta, GoalPhase } from '@deepseek-ai/dsh-goal'
import { createUserMessage, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, TodoItem, UserMessage } from '@deepseek-ai/dsh-session'
// Type-only: carries the `sessionPersistence` service augmentation into the
// build program; the sweep reads it optionally through `ctx.get`.
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
// Type-only: carries the `tasks` service augmentation into the build program.
import type { TaskActor } from '@task-center/task'
import { memoryMarks, openMarks } from './marks.ts'
import type { Marks } from './marks.ts'

/** Cordis plugin name. */
export const name = 'task-source'

/** The task seam, the session store, the agent registry (owned summarizer handles), and the model-call service must be present. */
export const inject = ['tasks', 'sessions', 'agents', 'llm']

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
 * are not human — `source.kind === 'user'` is); a chain the model opened on
 * its own initiative, with no human message before it, anchors to the last
 * assistant text instead — the trace is to whatever produced the todos. The
 * latest snapshot supplies the unfinished entries. The newest chain wins;
 * several chains in one session merge into it (design §10.4).
 * @param events - the complete session log, in seq order.
 * @returns the anchor and unfinished entries, or undefined when the session never wrote todos.
 */
export function foldTodos(events: readonly SessionEvent[]): TodoFact | undefined {
  let latest: TodoItem[] | undefined
  let previous = new Set<string>()
  let anchor: { seq: number; text: string } | null = null
  let lastHuman: { seq: number; text: string } | null = null
  let lastAssistant: { seq: number; text: string } | null = null
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      lastHuman = { seq: event.seq, text: messageText(event.data) }
    } else if (event.type === 'assistant/message') {
      const text = event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      if (text.trim() !== '') lastAssistant = { seq: event.seq, text }
    } else if (event.type === 'todo/write') {
      const entries = event.data.todos
      if (entries.some(item => !previous.has(item.content))) anchor = lastHuman ?? lastAssistant
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

/** Session id prefixes this plugin family mints for its own machinery sessions. */
const MACHINERY_PREFIXES = ['summary-', 'wake-', 'patrol-'] as const

/**
 * Whether one session id names machinery rather than a human conversation:
 * the summarizer's own sessions (`summary-`, minted here) and task-wake's
 * fired and patrol sessions (`wake-`/`patrol-`, minted by `@task-center/task-wake`).
 * Their transcripts are prompts this family wrote — extracting candidates
 * from them would feed the extractor its own output, and the work they did
 * already reaches the ledger through reflow and patrol notes.
 * @param id - one session id.
 */
export function isMachinerySession(id: SessionId): boolean {
  return MACHINERY_PREFIXES.some(prefix => id.startsWith(prefix))
}

/** What extraction reads from one session: identity plus the ordered log. `Session` satisfies this structurally. */
export interface ExtractionSource {
  /** Session identity; doubles as the candidate origin's session and the mark key. */
  readonly id: SessionId
  /** The complete session log, in seq order. */
  readonly events: readonly SessionEvent[]
  /** The session's working directory, when known; anchors the summarizer session. */
  readonly cwd?: string
}

/** What one session's structural extraction left for the summarizer tier. */
export interface SummaryRequest {
  /** The session the transcript came from; also the candidate origin's session. */
  readonly sessionId: SessionId
  /** Seq of the session's last event; the summarizer session id embeds it for traceability. */
  readonly lastSeq: number
  /** Rendered conversation lines, newest last, at most the configured window. */
  readonly transcript: readonly string[]
  /** The source session's working directory, when known; anchors the summarizer session. */
  readonly cwd?: string
}

/**
 * One goal the session declared complete that no human message has followed:
 * the model's own "done" is a claim, not a verdict — the completion surfaces
 * as a review-born task for the human to accept or reject.
 */
export interface UnverifiedCompletion {
  /** The goal's stable id; doubles as the acceptance-birth dedup key. */
  readonly goalId: string
  /** The goal's completion objective; the born task's objective. */
  readonly objective: string
  /** Seq of the change that completed the goal; only human messages after it verify. */
  readonly completedAtSeq: number
}

/**
 * Fold one session log to its completed-but-unaccepted goals. A goal counts
 * while its latest completing change stands (a later edit, resume, or clear
 * takes it out — unfinished goals are the candidate tier's business) AND no
 * human message follows that change: any later human line means the person
 * came back, saw the result, and had their chance to object.
 * @param events - the complete session log, in seq order.
 * @returns the unverified completions, in completion order.
 */
export function foldUnverifiedCompletions(events: readonly SessionEvent[]): readonly UnverifiedCompletion[] {
  const standing = new Map<string, UnverifiedCompletion & { seq: number }>()
  let lastHumanSeq = -1
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind === 'user') lastHumanSeq = event.seq
    } else if (event.type === 'goal/change') {
      const change: GoalChangeMeta = event.data
      if (change.operation === 'clear') {
        standing.delete(change.cleared.id)
      } else if (change.goal.phase === 'complete') {
        standing.set(change.goal.id, { goalId: change.goal.id, objective: change.goal.objective, completedAtSeq: event.seq, seq: event.seq })
      } else {
        standing.delete(change.goal.id)
      }
    }
  }
  return [...standing.values()]
    .filter(completion => completion.seq > lastHumanSeq)
    .map(({ seq, ...completion }) => completion)
    .sort((left, right) => left.completedAtSeq - right.completedAtSeq)
}

/**
 * Birth one session's unverified completions as review tasks (the shelving
 * gates call this — never the immediate pass): the objective is the goal's
 * own, the completion note names the submission's nature, and same-origin
 * dedup at the seam keeps a re-trigger from birthing twice.
 * @param ctx - Context carrying `tasks`.
 * @param sessionId - the session whose goals completed unaccepted.
 * @param completions - the session's folded unverified completions.
 */
async function birthAcceptances(ctx: Context, sessionId: SessionId, completions: readonly UnverifiedCompletion[]): Promise<void> {
  if (completions.length === 0) return
  const logger = ctx.logger('task-source')
  for (const completion of completions) {
    const created = await ctx.tasks.acceptanceCreate({
      objective: completion.objective,
      completionNote: '目标已在来源会话标记完成,其后无人回应;由抽取层提交,请人工验收',
      sessionId,
      goalId: completion.goalId,
    }, { kind: 'source' })
    if ('code' in created) {
      logger.warn('acceptance birth rejected', { sessionId, goalId: completion.goalId, code: created.code })
    }
  }
}

/** A live session as an extraction source, carrying its working directory. */
function fromSession(session: Session): ExtractionSource {
  return {
    id: session.id,
    events: session.events,
    ...session.header.cwd === undefined ? {} : { cwd: session.header.cwd },
  }
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

/** What one session's extraction left for the caller's gates. */
export interface ExtractionResult {
  /** A chat-only summary request, present exactly when no structural tier spoke. */
  readonly summary?: SummaryRequest
  /**
   * Goals the session declared complete with no human message after — model-free
   * evidence the shelving gates (idle, disposal, sweep) turn into review-born
   * acceptance tasks; the immediate pass reads them only to stay uncovered.
   */
  readonly unverified: readonly UnverifiedCompletion[]
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
 * the caller owns the model spend. Machinery sessions yield nothing at all.
 * @param ctx - Context carrying `tasks`.
 * @param session - the session whose log is read.
 * @param transcriptEvents - the conversation window handed to the summarizer.
 * @returns the summary request and/or unverified completions the caller's gates own.
 */
export async function extractSession(ctx: Context, session: ExtractionSource, transcriptEvents: number): Promise<ExtractionResult> {
  if (isMachinerySession(session.id)) return { unverified: [] }
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
  let summary: SummaryRequest | undefined
  if (goals.size === 0 && plan === undefined && todos === undefined) {
    const lines = conversationLines(session.events)
    if (lines.some(line => line.startsWith('用户: '))) {
      summary = {
        sessionId: session.id,
        lastSeq: session.events.at(-1)?.seq ?? -1,
        transcript: lines.slice(-transcriptEvents),
        ...session.cwd === undefined ? {} : { cwd: session.cwd },
      }
    }
  }
  return { ...summary === undefined ? {} : { summary }, unverified: foldUnverifiedCompletions(session.events) }
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
 * retires the session's single summary-tier candidate. The judgment is
 * one-shot, so the agent is disposed the moment its final text is read — a
 * summarizer session never lingers in the registry. The fixed origin key
 * `summary` keeps one candidate per session across re-summarizations — a
 * later `none` verdict on new activity retires the pending one; a task
 * verdict never re-births over any status. A session that never completes
 * (a broken route) reports `'failed'` so the caller may retry later without
 * covering the session; a completed-but-unparsable verdict births nothing
 * (宁缺毋滥) and reports `'done'` — one activity burst costs at most one
 * summarizer run.
 * @param ctx - Context carrying `tasks`, `agents`, and `llm`.
 * @param config - the summarizer route.
 * @param request - the session summary extraction yielded.
 * @returns `'done'` when the session completed (verdict or not), `'failed'` when it never ran to completion.
 */
export async function summarize(ctx: Context, config: Config, request: SummaryRequest): Promise<'done' | 'failed'> {
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
  const handle = await ctx.agents.create({
    // The id embeds the source session and seq for traceability and ends with
    // the mint time: persistence rejects a same-id create whose cwd differs
    // from the stored artifact's, so a deterministic id would collide with
    // the log a failed attempt left behind (stored at a different anchor than
    // a later deployment mints) and never retry.
    sessionId: SessionId(`summary-${request.sessionId}-${request.lastSeq}-${Date.now()}`),
    // Deployment assemblies render the `cwd` prompt variable in their persona
    // section; a machinery session without a cwd fails its first turn before
    // any model call. Anchor to the summarized conversation's own working
    // directory when known, else the process's — the summarizer only emits a
    // JSON verdict, so the anchor's exact value is presentation.
    meta: { cwd: request.cwd ?? process.cwd() },
    agentOptions: config.agent,
  })
  // A broken route does not reject `whenIdle` — the loop contains the failure
  // at its driver boundary and reports it as `agent/error`. Watch the event
  // for this agent, so a session that never produced an answer is a failure
  // the caller retries, not a verdict-less `done` that covers the session.
  let sessionFailed: unknown
  const offError = ctx.on('agent/error', payload => {
    if (payload.agent === handle.agent && sessionFailed === undefined) sessionFailed = payload.error
  })
  let finalText: string
  try {
    const idle = handle.agent.whenIdle()
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: buildSummaryPrompt(request, objectives) }],
      source: { kind: 'user' },
    }))
    try {
      await idle
    } catch (error) {
      logger.warn('summary session failed', { sessionId: request.sessionId, error })
      return 'failed'
    }
    if (sessionFailed !== undefined) {
      logger.warn('summary session errored', { sessionId: request.sessionId, error: sessionFailed })
      return 'failed'
    }
    finalText = lastAssistantText(handle.agent.session)
  } finally {
    offError()
    // The judgment is one-shot: the handle's disposer releases the agent and
    // its session id the moment the answer is read (or the session dies), so
    // a leaked registration can neither accumulate across a backlog nor
    // collide with the retry the same id would mint.
    await handle.dispose()
  }

  const verdict = parseVerdict(finalText)
  if (verdict === undefined) {
    logger.warn('summary verdict unparsable', { sessionId: request.sessionId })
    return 'done'
  }
  if ('none' in verdict) {
    await retire(`总结判定无任务: ${verdict.none}`)
    return 'done'
  }
  // The three conditions gate here too: a blank objective or acceptance is a
  // none the model failed to phrase as one.
  if (verdict.objective.trim() === '' || verdict.acceptance.trim() === '') {
    await retire('总结判定无任务: 验收标准写不出')
    return 'done'
  }
  if (ctx.tasks.candidateByOrigin(origin) !== undefined) return 'done'
  const created = await ctx.tasks.candidateCreate({
    objective: verdict.objective,
    acceptance: verdict.acceptance,
    ...verdict.note === '' ? {} : { note: verdict.note },
    origin,
  }, source)
  if ('code' in created) logger.warn('candidate create rejected', { sessionId: request.sessionId, tier: 'summary', code: created.code })
  return 'done'
}

/** One todo table's move inside a settled window, by discriminant. */
export type TodoMove =
  | { readonly kind: 'add'; readonly content: string; readonly to: TodoItem['status'] }
  | { readonly kind: 'move'; readonly content: string; readonly from: TodoItem['status']; readonly to: TodoItem['status'] }
  | { readonly kind: 'remove'; readonly content: string; readonly from: TodoItem['status'] }

/** Progress evidence one settled window of a session log carries (design 06 §7 第二层). */
export interface TurnEvidence {
  /** Todo table diff between the window's opening state and its closing state. */
  readonly todo: readonly TodoMove[]
  /** Rendered goal-change lines, in log order. */
  readonly goals: readonly string[]
}

/**
 * Fold one window of a session log into reflow evidence. The window is
 * `(settledThrough, endSeq]` — everything since evidence last settled through
 * the window's close. The todo diff compares the last table written at or
 * before the window's open against the last one written inside it: a window
 * with no `todo/write` moved nothing. Goal changes render per event; a clear
 * names its objective from any earlier snapshot of the same goal id.
 * @param events - the complete session log, in seq order.
 * @param settledThrough - exclusive lower bound; evidence at or before it already reflowed.
 * @param endSeq - inclusive upper bound of the window.
 * @returns the window's todo moves and goal lines; both empty means no write.
 */
export function foldEvidence(
  events: readonly SessionEvent[],
  settledThrough: number,
  endSeq: number,
): TurnEvidence {
  let opened = new Map<string, TodoItem['status']>()
  let closed: Map<string, TodoItem['status']> | undefined
  const objectives = new Map<string, string>()
  const goals: string[] = []
  const inWindow = (seq: number): boolean => seq > settledThrough && seq <= endSeq
  for (const event of events) {
    if (event.type === 'todo/write') {
      const table = new Map(event.data.todos.map(item => [item.content, item.status]))
      if (!inWindow(event.seq)) opened = table
      else closed = table
    } else if (event.type === 'goal/change') {
      const change: GoalChangeMeta = event.data
      if (change.operation !== 'clear') objectives.set(change.goal.id, change.goal.objective)
      if (!inWindow(event.seq)) continue
      if (change.operation === 'clear') {
        goals.push(`goal 已清除: ${objectives.get(change.cleared.id) ?? change.cleared.id}`)
      } else {
        const blocked = change.goal.blockedReason === undefined ? ''
          : `(${change.goal.blockedReason.code}: ${change.goal.blockedReason.message})`
        goals.push(`goal ${change.goal.objective}: ${change.goal.phase}${blocked}`)
      }
    }
  }
  if (closed === undefined) return { todo: [], goals }
  const todo: TodoMove[] = []
  for (const [content, to] of closed) {
    const from = opened.get(content)
    if (from === to) continue
    todo.push(from === undefined
      ? { kind: 'add', content, to }
      : { kind: 'move', content, from, to })
  }
  for (const [content, from] of opened) {
    if (!closed.has(content)) todo.push({ kind: 'remove', content, from })
  }
  return { todo, goals }
}

/**
 * Render one window's evidence as the progress note line. The `自动回流` prefix
 * keeps the automatic write distinguishable from the model's own
 * `task_update` reports in the pack.
 * @param evidence - one settled window's fold.
 * @returns the note, or `''` when the window carries no evidence.
 */
export function renderEvidence(evidence: TurnEvidence): string {
  const parts: string[] = []
  if (evidence.todo.length > 0) {
    const render = (move: TodoMove): string => {
      switch (move.kind) {
        case 'add': return `+ ${move.content}(${move.to})`
        case 'move': return `${move.content} ${move.from}→${move.to}`
        case 'remove': return `− ${move.content}`
      }
    }
    parts.push(`todo: ${evidence.todo.map(render).join('; ')}`)
  }
  if (evidence.goals.length > 0) parts.push(`goal: ${evidence.goals.join('; ')}`)
  return parts.length === 0 ? '' : `自动回流 ${parts.join(' | ')}`
}

/**
 * Write one settled window's note into every task the session holds — one
 * `progress` per task, the actor being the holding session itself (the
 * authority matrix is satisfied structurally). A compare-and-set collision
 * retries once against the fresh revision; a second failure drops the line —
 * the next window's diff carries the table forward, so no progress is lost.
 * Tasks outside `active`/`blocked` (awaiting verdict, finished, archived) are
 * skipped: the transition table would refuse them anyway.
 * @param ctx - Context carrying `tasks`.
 * @param sessionId - the holding session whose evidence this is.
 * @param note - the rendered evidence line; callers skip the empty case.
 * @param receipt - the live session to write the `task/change` receipt into; omit for a disposed session.
 */
export async function reflowHeldTasks(
  ctx: Context,
  sessionId: SessionId,
  note: string,
  receipt?: Session,
): Promise<void> {
  const logger = ctx.logger('task-source')
  const actor: TaskActor = { kind: 'model', sessionId }
  for (const view of ctx.tasks.list({ includeArchived: true })) {
    const { id, holder, status } = view.record
    if (view.archived || holder !== sessionId || (status !== 'active' && status !== 'blocked')) continue
    const mutation = { operation: 'progress' as const, note }
    let attempted = await ctx.tasks.mutate(id, view.record.revision, mutation, actor, receipt)
    if ('code' in attempted && attempted.code === 'TASK_STALE_REVISION') {
      const current = ctx.tasks.get(id)
      if (current !== undefined) {
        attempted = await ctx.tasks.mutate(id, current.record.revision, mutation, actor, receipt)
      }
    }
    if ('code' in attempted) logger.warn('reflow dropped', { sessionId, taskId: id, code: attempted.code })
  }
}

/** One goal's decisive phase change inside a settled window (design 06 §7 第三层). */
export type GoalMirror =
  | { readonly kind: 'blocked'; readonly goalId: string; readonly objective: string; readonly reason: { readonly code: string; readonly message: string } }
  | { readonly kind: 'complete'; readonly goalId: string; readonly objective: string }

/**
 * Fold a settled window's decisive goal transitions — changes whose operation
 * enters `blocked` or `complete`. Latest change per goal id wins (a goal that
 * flips twice in one window counts once, at its final phase); mirrors come
 * back ordered by that final change's seq. Operations that keep the phase
 * (edit while blocked, resume into active) carry no state to mirror.
 * @param events - the complete session log, in seq order.
 * @param settledThrough - exclusive lower bound of the window.
 * @param endSeq - inclusive upper bound of the window.
 * @returns the window's decisive goal transitions, in event order.
 */
export function foldGoalMirrors(
  events: readonly SessionEvent[],
  settledThrough: number,
  endSeq: number,
): readonly GoalMirror[] {
  const mirrors = new Map<string, { seq: number; mirror: GoalMirror }>()
  for (const event of events) {
    if (event.type !== 'goal/change') continue
    const change: GoalChangeMeta = event.data
    if (event.seq <= settledThrough || event.seq > endSeq) continue
    const mirror: GoalMirror | undefined = change.operation === 'block' && change.goal.blockedReason !== undefined
      ? {
        kind: 'blocked',
        goalId: change.goal.id,
        objective: change.goal.objective,
        reason: { code: change.goal.blockedReason.code, message: change.goal.blockedReason.message },
      }
      : change.operation === 'complete'
        ? { kind: 'complete', goalId: change.goal.id, objective: change.goal.objective }
        : undefined
    if (mirror !== undefined) mirrors.set(mirror.goalId, { seq: event.seq, mirror })
  }
  return [...mirrors.values()].sort((left, right) => left.seq - right.seq).map(entry => entry.mirror)
}

/**
 * Mirror one window's decisive goal transitions into every task the session
 * holds: a non-quota `blocked` parks the task with the goal's reason; a
 * `complete` submits it into review with a note naming the automatic
 * submission — the human stays the final judge. Only `active` tasks mirror
 * (`block` and `submit` are legal from `active` alone); the window's progress
 * write runs first and normalizes `blocked` back to `active`, so a goal that
 * unblocks into completion within the window still submits. Quota-coded
 * blocks are skipped — task-quota owns the quota lifecycle. Compare-and-set
 * collisions retry once against the fresh revision; a second failure drops
 * the mirror (the evidence line in the pack still says what happened).
 * @param ctx - Context carrying `tasks`.
 * @param sessionId - the holding session whose goal transitions these are.
 * @param mirrors - the window's decisive transitions, in event order.
 * @param receipt - the live session to write the `task/change` receipt into; omit for a disposed session.
 */
export async function mirrorHeldTasks(
  ctx: Context,
  sessionId: SessionId,
  mirrors: readonly GoalMirror[],
  receipt?: Session,
): Promise<void> {
  if (mirrors.length === 0) return
  const logger = ctx.logger('task-source')
  const actor: TaskActor = { kind: 'model', sessionId }
  for (const view of ctx.tasks.list({ includeArchived: true })) {
    const { id, holder, status } = view.record
    if (view.archived || holder !== sessionId || status !== 'active') continue
    let revision = view.record.revision
    for (const mirror of mirrors) {
      if (mirror.kind === 'blocked' && mirror.reason.code === QUOTA_EXCEEDED_CODE) continue
      const mutation = mirror.kind === 'blocked'
        ? { operation: 'block' as const, reason: mirror.reason }
        : { operation: 'submit' as const, completionNote: `由 goal「${mirror.objective}」完成自动提交,请按验收标准人工裁决` }
      let attempted = await ctx.tasks.mutate(id, revision, mutation, actor, receipt)
      if ('code' in attempted && attempted.code === 'TASK_STALE_REVISION') {
        const current = ctx.tasks.get(id)
        if (current !== undefined && current.record.holder === sessionId && current.record.status === 'active') {
          revision = current.record.revision
          attempted = await ctx.tasks.mutate(id, revision, mutation, actor, receipt)
        }
      }
      if ('code' in attempted) {
        logger.warn('mirror dropped', { sessionId, taskId: id, goalId: mirror.goalId, code: attempted.code })
        continue
      }
      revision = attempted.record.revision
    }
  }
}

/** Call ids of pending `exit_plan_mode` calls, shared by the trigger checks. */
const exitPlanCalls = new Set<string>()

/**
 * Whether one session event carries structural extraction signal — the
 * explicit declarations of work (goal set, plan approved, todos written)
 * that birth immediately instead of waiting out the idle gate.
 * @param event - one freshly appended session event.
 */
function structuralTrigger(event: SessionEvent): boolean {
  if (event.type === 'goal/change' || event.type === 'todo/write') return true
  if (event.type === 'tool/call') {
    if (event.data.name === EXIT_PLAN_MODE) exitPlanCalls.add(event.data.callId)
    return false
  }
  return event.type === 'tool/result'
    && event.data.message.content[0] !== undefined
    && exitPlanCalls.has(event.data.message.content[0].toolCallId)
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
 * The last real event of one log: seq -1 and `now` for an empty log. The
 * `session/end-seed` marker is store bookkeeping stamped at attach time, not
 * session activity — skipping it anchors the idle clock to the last durable
 * event, so a session restored from disk can already be idle at boot.
 * @param events - the complete log, in seq order.
 * @returns the last activity's seq and epoch-ms time.
 */
function lastActivity(events: readonly SessionEvent[]): { seq: number; time: number } {
  let seq = -1
  let time = Number.NaN
  for (const event of events) {
    if (event.type === 'session/end-seed') continue
    seq = event.seq
    time = event.time
  }
  return { seq, time: Number.isNaN(time) ? Date.now() : time }
}

/** Outcome of one preflight probe of the summarizer route. */
interface Probe {
  /** Whether the route still reports quota exhaustion. */
  readonly walled: boolean
  /** Provider-requested delay to hold further probes, when it sent one. */
  readonly holdMs?: number
}

/**
 * Arm the watermark tracker, the immediate structural passes, the idle scan,
 * the history sweep, and progress reflow. Structural evidence (goal set,
 * plan approved, todos written) births at the moment it lands — an explicit
 * declaration of work needs no shelving proof, and the pass is model-free;
 * the boot sweep gives restored histories the same immediacy. The first full
 * scan also runs inside `apply`; later scans run on the timer and only
 * re-extract sessions with activity since their last extraction, gated on
 * silence for the summarizer. A detached history sweep then reads every
 * session the persistence backend stores — not only live ones — so a fresh
 * install recovers the whole backlog once: covered ground is skipped by the
 * durable marks, structural tiers birth model-free, and chat-only history
 * queues behind the same idle gate. A disposed session extracts immediately
 * on the event, not at the next idle gate — disposal is the last chance to
 * read it.
 * Summary requests pay one model call each: every run is preceded by a quota
 * probe of the route (a positive QUOTA answer defers the request to a later
 * tick) and counts against the per-tick cap; a live session that gets
 * deferred keeps its watermark behind so the next tick retries, while a
 * request whose carrier is not the live scan (disposed session, history
 * sweep) is queued — the tick is its only remaining carrier. A route whose
 * sessions never complete backs off exponentially (doubling per consecutive
 * failure, capped at 32 polls) and covers nothing: configure the route and
 * the backlog flows. Progress reflow rides the same stream: every `turn/end`
 * settles its window's todo/goal evidence into the closing session's held
 * tasks (a decisive goal transition mirrors into their state), and a disposed
 * session gets one final flush of the turn it died in.
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
  // Durable marks when a storage-domain facility is mounted (the deployed
  // composition always mounts one); an in-memory fallback keeps tests and
  // minimal compositions working, at the price of re-reading ground after a
  // restart. `ctx.get`, not `inject`: a missing inject service would silently
  // defer this whole plugin.
  const storageFacility = ctx.get('storageDomain')
  const opened = storageFacility === undefined ? undefined : await openMarks(storageFacility)
  if (opened !== undefined) {
    ctx.effect(() => () => void opened.close().catch(error => logger.warn('marks close failed', { error })))
  }
  const marks: Marks = opened?.marks ?? memoryMarks()
  const persistMark = (sessionId: SessionId, seq: number): void => {
    void marks.advance(sessionId, seq).catch(error => logger.warn('mark write failed', { sessionId, error }))
  }
  /** Seed one session's watermark from its log plus the durable mark. */
  const seed = (session: Session): Watermark => {
    const { seq, time } = lastActivity(session.events)
    return { lastSeq: seq, lastEventTime: time, extractedThrough: marks.covered(session.id) }
  }
  /**
   * Gate carries the live scan no longer owns: their session was disposed, or
   * they came from the history sweep. A summary entry waits on the idle gate's
   * own anchor (a disposed session is ready now, swept history is ready once
   * its last event has been idle long enough); an acceptance entry carries
   * deferred completion births behind the same anchor. Ticks drain both.
   */
  type PendingEntry =
    | { readonly kind: 'summary'; readonly request: SummaryRequest; readonly readyAt: number }
    | { readonly kind: 'acceptance'; readonly sessionId: SessionId; readonly lastSeq: number; readonly completions: readonly UnverifiedCompletion[]; readonly readyAt: number }
  const queue: PendingEntry[] = []
  /** The session one queued entry speaks for, whatever its kind. */
  const entrySession = (entry: PendingEntry): SessionId =>
    entry.kind === 'summary' ? entry.request.sessionId : entry.sessionId
  let probeHoldUntil = 0
  /** Consecutive summarizer failures; each failure doubles the hold, capped. */
  let failureStreak = 0

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
   * itself contains its failures — a returned `'failed'` and a thrown error
   * (a session-create collision, a storage failure) are the same outcome —
   * so a throw escaping here can never drop the caller's queued request. A
   * failed run (broken route, no key) backs off exponentially — each
   * consecutive failure doubles the hold from one poll interval, capped at
   * 32 — and never covers the session, so fixing the route lets the backlog
   * flow. A completed run, verdict or not, clears the streak; only the quota
   * wall reports back without a failure.
   */
  const runSummary = async (request: SummaryRequest): Promise<'ran' | 'walled' | 'failed'> => {
    if (Date.now() < probeHoldUntil) return 'walled'
    const probed = await probe()
    if (probed.walled) {
      if (probed.holdMs !== undefined) probeHoldUntil = Date.now() + probed.holdMs
      logger.info('summary deferred: route still quota-exhausted', { sessionId: request.sessionId })
      return 'walled'
    }
    let outcome: 'done' | 'failed'
    try {
      outcome = await summarize(ctx, config, request)
    } catch (error) {
      logger.warn('summary threw; treating as failed', { sessionId: request.sessionId, error })
      outcome = 'failed'
    }
    if (outcome === 'failed') {
      failureStreak++
      probeHoldUntil = Date.now() + Math.min(2 ** failureStreak, 32) * config.pollSeconds * 1000
      logger.warn('summary failed; backing off', { sessionId: request.sessionId, streak: failureStreak })
      return 'failed'
    }
    failureStreak = 0
    return 'ran'
  }

  ctx.on('session/event', (session, event) => {
    const mark = watermarks.get(session.id) ?? seed(session)
    watermarks.set(session.id, mark)
    if (event.seq > mark.lastSeq) {
      mark.lastSeq = event.seq
      mark.lastEventTime = event.time
    }
    // Structural signals birth immediately (design §4: the idle gate exists
    // only for the summarizer's chat-only fallback): a goal being set, a plan
    // being approved, or todos being written is an explicit declaration of
    // work — waiting for silence adds nothing, the human promotion is the
    // noise gate, and the pass itself is model-free.
    if (structuralTrigger(event)) {
      void structuralPass(session).catch(error => logger.warn('immediate extraction failed', { sessionId: session.id, error }))
    }
  })

  /**
   * One immediate structural pass. It births and retires structural-tier
   * candidates the moment their evidence lands; a returned summary request
   * (no structural tier spoke) is ignored — the idle gate, disposal, and the
   * history sweep own the summarizer, so immediate passes never pay for a
   * model call. Unverified completions are read but never born and never
   * covered here: at the moment a goal completes no human has replied YET,
   * and only the shelving gates see the settled log that answers whether one
   * ever did — so the watermark stays behind and the session re-opens on its
   * own at the next extraction. A session the pass fully resolved (a
   * structural tier spoke with nothing unverified, or nothing human was ever
   * said) is covered through its tail: neither the idle tick nor a restart
   * re-reads it. Later activity moves `lastSeq` ahead of the mark and
   * re-opens the session on its own.
   */
  const structuralPass = async (session: Session): Promise<void> => {
    const result = await extractSession(ctx, fromSession(session), config.transcriptEvents)
    if (result.summary !== undefined || result.unverified.length > 0) return
    const mark = watermarks.get(session.id) ?? seed(session)
    watermarks.set(session.id, mark)
    if (mark.extractedThrough < mark.lastSeq) {
      mark.extractedThrough = mark.lastSeq
      persistMark(session.id, mark.lastSeq)
    }
  }

  /**
   * Window state for progress reflow: the seq evidence last settled through,
   * per session. Seeded from the last turn that closed strictly before the
   * window being settled — a turn that ends after mount reflows in full,
   * including its pre-mount tail (crash-recovery of a reflow this process
   * missed), while fully historical turns never do.
   */
  const settledThrough = new Map<SessionId, number>()
  const seedSettled = (session: Session, before: number): number => {
    let last = 0
    for (const event of session.events) {
      if (event.type === 'turn/end' && event.seq < before) last = event.seq
    }
    settledThrough.set(session.id, last)
    return last
  }

  /**
   * Settle one window's evidence into the held tasks: the progress write
   * first, then the goal-state mirror (progress normalizes `blocked` back to
   * `active`, so the mirror's block/submit stays transition-legal). The mark
   * advances synchronously before the first await, so back-to-back turns
   * never double-settle the same window. A dropped write (CAS twice stale,
   * task moved on) consumes its window: the next window's diff carries the
   * table forward.
   */
  const settleWindow = async (session: Session, endSeq: number, receipt: Session | undefined): Promise<void> => {
    const mark = settledThrough.get(session.id) ?? seedSettled(session, endSeq)
    const note = renderEvidence(foldEvidence(session.events, mark, endSeq))
    settledThrough.set(session.id, endSeq)
    if (note !== '') await reflowHeldTasks(ctx, session.id, note, receipt)
    await mirrorHeldTasks(ctx, session.id, foldGoalMirrors(session.events, mark, endSeq), receipt)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    void settleWindow(session, event.seq, session)
      .catch(error => logger.warn('turn reflow failed', { sessionId: session.id, error }))
  })

  ctx.on('session/disposed', session => {
    watermarks.delete(session.id)
    // Purge queued entries for this session: disposal re-reads the whole log,
    // so a stale queued request (an earlier burst's snapshot) must not be
    // summarized after the fresher read.
    for (let index = queue.length - 1; index >= 0; index--) {
      if (entrySession(queue[index]!) === session.id) queue.splice(index, 1)
    }
    void (async () => {
      // Final flush of a turn that never closed: headless one-shot sessions
      // often die mid-turn, and disposal is the last chance to settle. No
      // receipt — the session's log is closed.
      await settleWindow(session, session.events.at(-1)?.seq ?? 0, undefined)
      settledThrough.delete(session.id)
      const { seq: covered } = lastActivity(session.events)
      const result = await extractSession(ctx, fromSession(session), config.transcriptEvents)
      // Disposal is decisive for acceptance too: the session is closed, so a
      // completion without a reply is unverified forever — birth it now.
      await birthAcceptances(ctx, session.id, result.unverified)
      if (result.summary === undefined) {
        persistMark(session.id, covered)
        return
      }
      // Disposal is the last chance to read the session, so the cap does not
      // apply here; a walled or failed route parks the request for the next
      // tick — the queue is its only remaining carrier.
      if (await runSummary(result.summary) === 'ran') persistMark(session.id, covered)
      else queue.push({ kind: 'summary', request: result.summary, readyAt: 0 })
    })().catch(error => logger.warn('disposed extraction failed', { sessionId: session.id, error }))
  })

  const tick = async (): Promise<void> => {
    const now = Date.now()
    if (now < probeHoldUntil) return
    let budget = config.summariesPerTick
    // Queued entries first: their sessions no longer appear in the live scan
    // (disposed) or never did (history sweep), so this queue is their only
    // carrier. Not-yet-ready entries wait; a summary over the per-tick cap
    // waits while an acceptance birth never does (it is model-free); a session
    // that came back to life returns to the live scan below, and its queued
    // snapshot is stale.
    const held: PendingEntry[] = []
    for (const entry of queue.splice(0)) {
      if (entry.readyAt > now || ctx.sessions.get(entrySession(entry)) !== undefined) {
        held.push(entry)
        continue
      }
      if (entry.kind === 'acceptance') {
        try {
          await birthAcceptances(ctx, entry.sessionId, entry.completions)
          persistMark(entry.sessionId, entry.lastSeq)
        } catch (error) {
          logger.warn('acceptance birth threw; re-queued', { sessionId: entry.sessionId, error })
          held.push(entry)
        }
        continue
      }
      if (budget <= 0) {
        held.push(entry)
        continue
      }
      const outcome = await runSummary(entry.request)
      if (outcome === 'ran') {
        budget--
        persistMark(entry.request.sessionId, entry.request.lastSeq)
        continue
      }
      // Walled or failed: the hold now covers every later run this tick.
      held.push(entry)
      queue.push(...held)
      return
    }
    queue.push(...held)
    for (const session of ctx.sessions.list()) {
      const mark = watermarks.get(session.id) ?? seed(session)
      watermarks.set(session.id, mark)
      // No activity since the last extraction, or not idle enough: skip.
      if (mark.extractedThrough >= mark.lastSeq) continue
      if (now - mark.lastEventTime < idleMs) continue
      const covered = mark.lastSeq
      const result = await extractSession(ctx, fromSession(session), config.transcriptEvents)
      // Idle acceptance births ride before the summary budget: they are
      // model-free, and the session was silent a full idle window — the human
      // had their chance to reply to the completion.
      await birthAcceptances(ctx, session.id, result.unverified)
      if (result.summary === undefined) {
        mark.extractedThrough = covered
        persistMark(session.id, covered)
        continue
      }
      // Over-cap sessions defer: the watermark stays behind, so the next tick
      // re-extracts and retries.
      if (budget <= 0) continue
      const outcome = await runSummary(result.summary)
      if (outcome !== 'ran') return
      budget--
      // Events appended during the awaits stay ahead of the watermark: only
      // the snapshot the extraction actually covered advances it.
      mark.extractedThrough = covered
      persistMark(session.id, covered)
    }
  }

  /**
   * The history sweep: read every session the persistence backend stores —
   * not only the live ones — so a fresh install recovers the whole backlog
   * once. Skipped: machinery sessions (this family's own transcripts),
   * subagent children (delegation machinery — their work reaches the ledger
   * through the parent's receipt), live sessions (the boot structural pass
   * and the idle scan own them), and ground the durable marks already
   * covered. A structural resolution covers its session immediately unless it
   * left unverified completions, which ride the idle gate like everything the
   * human may still answer; a chat-only one queues behind the same gate
   * anchored to its last stored event. One migration: the acceptance tier
   * postdates marks earlier boots wrote, so the first sweep after the upgrade
   * re-reads covered ground once — model-free (a covered session's summary
   * already ran or never applied; only acceptance births and deferred
   * structural births happen) — before stamping the flag that never re-runs
   * it. The sweep runs detached: mount must not wait on the whole stored
   * history, and every model spend it queues flows through the tick's cap
   * and probe anyway.
   */
  const sweepHistory = async (): Promise<void> => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) {
      logger.info('no session persistence backend mounted; skipping the history sweep')
      return
    }
    const migrating = marks.flag('acceptance-births') === undefined
    const headers = await persistence.list()
    let extracted = 0
    for (const header of headers) {
      if (isMachinerySession(header.id) || header.origin === 'subagent') continue
      if (ctx.sessions.get(header.id) !== undefined) continue
      const inspection = await persistence.inspect(header.id)
      const { seq: lastSeq, time: lastEventTime } = lastActivity(inspection.events)
      const covered = marks.covered(header.id) >= lastSeq
      if (covered && !migrating) continue
      extracted++
      const result = await extractSession(ctx, {
        id: header.id,
        events: inspection.events,
        ...header.cwd === undefined ? {} : { cwd: header.cwd },
      }, config.transcriptEvents)
      // Already-paid ground: the summary never re-runs; only the acceptance
      // tier has anything new to say, and the mark stays where it was.
      if (covered) {
        if (lastEventTime + idleMs <= Date.now()) await birthAcceptances(ctx, header.id, result.unverified)
        else if (result.unverified.length > 0) {
          queue.push({ kind: 'acceptance', sessionId: header.id, lastSeq, completions: result.unverified, readyAt: lastEventTime + idleMs })
        }
        continue
      }
      if (result.summary === undefined) {
        // The human may still come back to a not-yet-idle session, so
        // acceptance births wait out the same idle gate as summaries;
        // everything else structural resolved now. An idle birth covers the
        // session — the shelved log is frozen, so re-reading could only
        // re-fold the same completions the dedup would reject.
        if (lastEventTime + idleMs <= Date.now()) {
          await birthAcceptances(ctx, header.id, result.unverified)
          persistMark(header.id, lastSeq)
        } else if (result.unverified.length > 0) {
          queue.push({ kind: 'acceptance', sessionId: header.id, lastSeq, completions: result.unverified, readyAt: lastEventTime + idleMs })
        } else {
          persistMark(header.id, lastSeq)
        }
        continue
      }
      queue.push({ kind: 'summary', request: result.summary, readyAt: lastEventTime + idleMs })
    }
    if (migrating) await marks.setFlag('acceptance-births', new Date().toISOString())
    logger.info('history sweep done', { storedSessions: headers.length, extracted, migrating })
  }

  // Boot sweep: every live session gets one structural pass — restored
  // histories birth their candidates without waiting for the idle gate —
  // then the stored history flows in behind it.
  for (const session of ctx.sessions.list()) {
    await structuralPass(session)
  }
  void sweepHistory().catch(error => logger.warn('history sweep failed', { error }))
  await tick()
  const timer = setInterval(() => void tick().catch(error => logger.warn('tick failed', { error })), config.pollSeconds * 1000)
  ctx.effect(() => () => clearInterval(timer))
}
