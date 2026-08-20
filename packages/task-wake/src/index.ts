/**
 * `task-wake`: the time face of the task seam — a host-level timer that reads
 * due `wakeRule`s, probes the fired-session route once (quota still exhausted
 * → defer: no consume, no fire, hold per the provider's delay), then consumes
 * the occurrence in the domain ledger as the wake actor (one-shots clear,
 * `every` advances its anchor past now — state commits before the session
 * starts, so a crash never double-fires) and starts a fresh agent session
 * whose first message injects the task and its context pack. The fired
 * session is an ordinary model actor: it claims and works the task through
 * the task tools. The timer itself performs no work operations, per the
 * authority matrix.
 *
 * The same timer runs the daily patrol: once per local day at the configured
 * slot, one fire-and-forget session refreshes the 现状/下一步/卡点 of every
 * unfinished task through `task_patrol` — observation only, never work.
 * Spec: docs/design/03-plugins.md §2, 05-seam-spec.md §1 and §4.
 * @module dsh-task-center-task-wake
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: carries the Context.agentLoop augmentation into src-only builds
// (the emit path cannot lean on test files importing the module).
import type AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskId, TaskRecord, TaskView, WakeRule } from 'dsh-task-center-task'

/** Cordis plugin name. */
export const name = 'task-wake'

/** The task seam, the agent factory, and the model-call service must be present. */
export const inject = ['tasks', 'agentLoop', 'llm']

/** Deployment knobs for the wake host (no hardcoded tunables). */
export interface Config {
  /** Tick cadence in seconds. Required, positive. */
  readonly pollSeconds: number
  /** Model route for fired sessions. Both fields required. */
  readonly agent: { readonly provider: string; readonly model: string }
  /** Daily patrol target: local wall-clock `HH:MM`. Absent disables the patrol. */
  readonly patrol?: { readonly at: string }
}

/** Local calendar day key `YYYY-MM-DD` of one instant. */
function localDay(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Verdict of one patrol-slot check at tick time. */
export type PatrolSignal = 'before-slot' | 'due' | 'passed'

/**
 * Decide the daily patrol at one tick. `before-slot` means the caller should
 * record today as pre-slot-seen; `due` means fire now and record today as run;
 * `passed` changes nothing. A process that first looks after the slot never
 * saw today's pre-slot moment, so it waits for tomorrow — a missed slot is
 * skipped, never caught up on boot.
 * @param slot - the configured local `HH:MM`.
 * @param now - the tick time.
 * @param sawPreSlotDay - the day key this process last observed before a slot.
 * @param ranDay - the day key the patrol last ran.
 * @returns the signal for the caller to act on and record.
 */
export function patrolDecision(slot: string, now: Date, sawPreSlotDay: string, ranDay: string): PatrolSignal {
  const [hours, minutes] = slot.split(':')
  const slotMinutes = Number(hours) * 60 + Number(minutes)
  const day = localDay(now)
  if (now.getHours() * 60 + now.getMinutes() < slotMinutes) return 'before-slot'
  if (day === ranDay) return 'passed'
  if (sawPreSlotDay !== day) return 'passed'
  return 'due'
}

/**
 * The rule after this occurrence consumes it: one-shots (`after`, `at`) end,
 * `every` advances its anchor to the first occurrence strictly after `now`.
 * @param rule - the rule that just fired.
 * @param now - the wall-clock decision time.
 * @returns the replacement rule, or `'clear'` when the rule is spent.
 */
export function consumeOccurrence(rule: WakeRule, now: Date): WakeRule | 'clear' {
  if (rule.kind !== 'every') return 'clear'
  const step = rule.everySeconds * 1000
  let anchor = Date.parse(rule.anchorAt) + step
  while (anchor <= now.getTime()) anchor += step
  return { kind: 'every', everySeconds: rule.everySeconds, anchorAt: new Date(anchor).toISOString() }
}

/** First message of one fired session: the task and its pack, then the instruction. */
function injection(record: TaskRecord): string {
  return [
    '[task-wake] 定时唤醒:以下任务到点。',
    `目标: ${record.objective}`,
    `验收: ${record.acceptance}`,
    `状态: ${record.status}`,
    `上下文包(历次会话的累积记录):`,
    record.contextPack === '' ? '(尚无记录)' : record.contextPack,
    '指令:先用 task_claim 认领该任务,然后完成它;以 task_report(outcome=review)提交,completion note 逐条对照验收标准。',
  ].join('\n')
}

/** First message of the daily patrol session: the inventory, then the instruction. */
function patrolMessage(inventory: string): string {
  return [
    '[task-wake] 每日巡检:刷新所有未完结任务的现状。',
    inventory,
    '指令:对上面每个任务调用一次 task_patrol:note 用一句话写该任务现状;next 写下一步(如有);有卡点写 blocker。',
    '不要 task_claim,不要改变任何任务状态,不要新建任务。完成后用一段话总结整体进展与最该被人类注意的事项。',
  ].join('\n')
}

/**
 * Start one patrol session over every unfinished task: the inventory line of
 * each (exact id, revision, status, holder, idle days by `workedAt`, last pack
 * line) followed by the observe-only instruction. Exported for e2e — the timer
 * path waits for a wall-clock slot no test should.
 * @param ctx - Context carrying `tasks` and `agentLoop`.
 * @param config - The model route for the patrol session.
 * @returns the session's idle promise, or undefined when nothing is unfinished.
 */
export function runPatrol(ctx: Context, config: Config): Promise<void> | undefined {
  const open = ctx.tasks.list({}).filter(view => view.record.status !== 'done')
  if (open.length === 0) return undefined
  const projectNames = new Map(ctx.tasks.projects().map(view => [view.record.id, view.record.name] as const))
  const now = Date.now()
  const inventory = open.map(view => {
    const { record } = view
    const idle = Math.max(0, Math.floor((now - Date.parse(record.workedAt)) / 86_400_000))
    const last = record.contextPack === '' ? '(尚无记录)' : record.contextPack.split('\n').at(-1)!
    return [
      `- 任务 id: ${record.id}(revision ${record.revision})`,
      `  状态: ${record.status}${record.holder === undefined ? '' : ` · 持有会话 ${record.holder.slice(0, 8)}`} · 闲置 ${idle} 天${record.projectId === undefined ? '' : ` · 项目 ${projectNames.get(record.projectId) ?? record.projectId}`}`,
      `  目标: ${record.objective}`,
      `  最近记录: ${last}`,
    ].join('\n')
  }).join('\n')
  // Deployment assemblies render the `cwd` prompt variable in their persona
  // section; a machinery session without a cwd fails its first turn before any
  // model call. Tasks carry no directory of their own, so the process's is the
  // anchor — the inventory text, not the directory, is the patrol's subject.
  const agent = ctx.agentLoop.create(SessionId(`patrol-${localDay(new Date())}-${Date.now()}`), config.agent, { cwd: process.cwd() })
  const idle = agent.whenIdle()
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: patrolMessage(inventory) }],
    source: { kind: 'user' },
  }))
  return idle
}

/** Outcome of one preflight probe of the fired-session route. */
interface Probe {
  /** Whether the route still reports quota exhaustion. */
  readonly walled: boolean
  /** Provider-requested delay to hold further probes, when it sent one. */
  readonly holdMs?: number
}

/**
 * Arm the poll timer and run one immediate tick. Fired sessions are
 * fire-and-forget: LLM failures are contained (the occurrence is already
 * consumed in the ledger) and logged.
 * @param ctx - Plugin context.
 * @param config - Tick cadence and fired-session model route.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isFinite(config.pollSeconds) || config.pollSeconds <= 0) {
    throw new Error('task-wake: pollSeconds must be a positive number of seconds')
  }
  if (config.agent.provider.trim() === '' || config.agent.model.trim() === '') {
    throw new Error('task-wake: agent.provider and agent.model must name the fired sessions\' route')
  }
  if (config.patrol !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.patrol.at)) {
    throw new Error('task-wake: patrol.at must be local HH:MM on a 24-hour clock')
  }
  const logger = ctx.logger('task-wake')

  /**
   * One minimal request (no session identity) asking whether the route's quota
   * window reopened. Only a positive `QUOTA` answer defers; every other
   * finish — success, auth or transport error — and a thrown stream both mean
   * fire: a broken probe never blocks work.
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
      // The stream contract keeps middleware and consumer failures thrown; firing
      // surfaces the real failure instead of silently parking on a broken probe.
      logger.warn('probe failed; firing anyway', { error })
      return { walled: false }
    }
  }

  const fire = (record: TaskRecord): void => {
    // Same persona-variable constraint as the patrol session; see runPatrol.
    const agent = ctx.agentLoop.create(SessionId(`wake-${record.id.slice(0, 8)}-${Date.now()}`), config.agent, { cwd: process.cwd() })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: injection(record) }],
      source: { kind: 'user' },
    }))
    void idle.catch(error => logger.warn('fired session failed', { taskId: record.id, error }))
  }

  /**
   * Consume one due occurrence in the ledger as the wake actor.
   * @returns the settled view, or undefined when the CAS lost a race.
   */
  const consume = async (taskId: TaskId, revision: number, rule: WakeRule): Promise<TaskView | undefined> => {
    const consumed = consumeOccurrence(rule, new Date())
    const bookkeeping = consumed === 'clear'
      ? { operation: 'wake-clear' as const }
      : { operation: 'wake-set' as const, rule: consumed }
    const settled = await ctx.tasks.mutate(taskId, revision, bookkeeping, { kind: 'wake' })
    if ('code' in settled) {
      logger.warn('wake bookkeeping rejected', { taskId, code: settled.code })
      return undefined
    }
    return settled
  }

  let probeHoldUntil = 0
  let patrolSawPreSlotDay = ''
  let patrolRanDay = ''

  const tick = async (): Promise<void> => {
    if (Date.now() < probeHoldUntil) return
    if (config.patrol !== undefined) {
      const now = new Date()
      const signal = patrolDecision(config.patrol.at, now, patrolSawPreSlotDay, patrolRanDay)
      if (signal === 'before-slot') {
        patrolSawPreSlotDay = localDay(now)
      } else if (signal === 'due') {
        patrolRanDay = localDay(now)
        const idle = runPatrol(ctx, config)
        if (idle !== undefined) {
          logger.info('firing patrol session')
          void idle.catch(error => logger.warn('patrol session failed', { error }))
        }
      }
    }
    let probed: Probe | undefined
    for (const due of ctx.tasks.wakeRules()) {
      const view = ctx.tasks.get(due.taskId)
      if (view === undefined || view.record.revision !== due.revision) continue
      const rule = view.record.wakeRule
      if (rule === undefined) continue
      // A held task consumes its occurrence without a probe: nothing would be fired.
      if (view.record.holder !== undefined) {
        if (await consume(due.taskId, due.revision, rule) === undefined) continue
        logger.info('due task is held by a live session; occurrence consumed without firing', { taskId: due.taskId })
        continue
      }
      if (probed === undefined) probed = await probe()
      if (probed.walled) {
        if (probed.holdMs !== undefined) probeHoldUntil = Date.now() + probed.holdMs
        logger.info('wake deferred: route still quota-exhausted', { taskId: due.taskId })
        continue
      }
      const settled = await consume(due.taskId, due.revision, rule)
      if (settled === undefined) continue
      logger.info('firing wake session', { taskId: due.taskId, status: settled.record.status })
      fire(settled.record)
    }
  }

  const guarded = (): void => void tick().catch(error => logger.warn('tick failed', { error }))
  const timer = setInterval(guarded, config.pollSeconds * 1000)
  ctx.effect(() => () => clearInterval(timer))
  guarded()
}
