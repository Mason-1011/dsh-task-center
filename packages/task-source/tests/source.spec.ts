/**
 * Keyless extraction tests over the real session store, task seam, and agent
 * spine: the three structural folds (goal snapshots, approved plans, todo
 * chains with their human anchors), tier-priority birth / supersede / dedup
 * through the source actor, the idle gate with per-session watermarks, the
 * boot sweep, disposed-session immediacy, and the summarizer tier — verdict
 * parsing, the judged prompt, the keyless closed loop through a scripted
 * adapter, the per-tick cap, and the quota wall.
 * @module @task-center/task-source/tests/source
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter, MessageId, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalBlockReason, GoalChangeMeta, GoalClearChangeMeta, GoalOperation, GoalPhase, GoalSnapshotChangeMeta } from '@deepseek-ai/dsh-goal'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import type { CandidateView } from '@task-center/task'
import { buildSummaryPrompt, extractSession, foldApprovedPlan, foldGoals, foldTodos, parseVerdict, summarize } from '../src/index.ts'
import type { Config, SummaryRequest } from '../src/index.ts'
import * as TaskSource from '../src/index.ts'

const HOUR = 3_600_000

/** Boot the agent spine plus the task seam — no extractor yet. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
  return ctx
}

/** Extractor config over the named route; the first tick runs inside mount. */
function sourceConfig(route: string, overrides: Partial<Config> = {}): Config {
  return {
    pollSeconds: 3600,
    idleHours: 3,
    agent: { provider: route, model: 'm' },
    summariesPerTick: 3,
    transcriptEvents: 10,
    ...overrides,
  }
}

function goal(
  operation: Exclude<GoalOperation, 'clear'>,
  id: string,
  revision: number,
  phase: GoalPhase,
  objective = '支持暗色模式',
  blockedReason?: GoalBlockReason,
): GoalSnapshotChangeMeta {
  return {
    kind: 'goal/change', version: 1, operation,
    goal: { id: GoalId(id), revision, objective, phase, ...blockedReason === undefined ? {} : { blockedReason }, maxGoalRounds: 5 },
    roundsStarted: 0, createdAt: 1_000, updatedAt: 1_000,
  }
}

function goalClear(id: string, revision: number): GoalClearChangeMeta {
  return { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: GoalId(id), revision }, clearedAt: 2_000 }
}

/** Fabricated goal history as a contiguous seed log. */
function seed(changes: readonly (readonly [change: GoalChangeMeta, time: number])[]): SessionEvent<'goal/change'>[] {
  return changes.map(([data, time], index) => ({ type: 'goal/change' as const, seq: index, time, data }))
}

/** Event types on the ordered surface — seeds must mark how they entered it. */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** One event of any type with a contiguous seq, handed the payload verbatim. */
function eventOf<K extends SessionEvent['type']>(type: K, data: SessionEvent<K>['data'], time: number): SessionEvent<K> {
  // Surface-eligible events carry the plain-append marker; the distributive
  // mapped SessionEvent<K> defeats the generic assignability check, so one
  // cast assembles the four-field shape.
  return {
    type, seq: -1, time, data,
    ...SURFACE_TYPES.has(type) ? { surfaceOp: 'append' as const } : {},
  } as SessionEvent<K>
}

/** Renumber a mixed event list into a contiguous log. */
function renumber(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: index }))
}

/** A user/message event; a plugin notice passes its own `source`. */
function userMessage(text: string, time: number, source: SessionEvent<'user/message'>['data']['source'] = { kind: 'user' }): SessionEvent<'user/message'> {
  return eventOf('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), time)
}

/** An assistant/message event — one model activity record. */
function assistantMessage(text: string, time: number): SessionEvent<'assistant/message'> {
  return eventOf('assistant/message', {
    turn: 1, step: 1,
    message: {
      id: MessageId(`a-${time}`),
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'mock', model: 'mock-model' },
    },
  }, time)
}

/** An exit_plan_mode call and its paired result; `error` marks a rejected review. */
function planReview(plan: string, time: number, error?: { name: string; code: string }): SessionEvent[] {
  const callId = CallId(`c-${time}`)
  return [
    eventOf('tool/call', { turn: 1, step: 1, callId, name: 'exit_plan_mode', arguments: JSON.stringify({ plan }) }, time),
    eventOf('tool/result', {
      turn: 1, step: 1,
      message: {
        id: MessageId(`r-${time}`),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'reviewed' }] }],
        source: { kind: 'tool', callId },
      },
      ...error === undefined ? {} : { error },
    }, time + 1),
  ]
}

/** A todo/write whole-table snapshot. */
function todoWrite(entries: readonly { content: string; status: TodoItem['status'] }[], time: number): SessionEvent<'todo/write'> {
  return eventOf('todo/write', { todos: entries.map(entry => ({ ...entry })) }, time)
}

/** One live session carrying the given goal history. */
function liveSession(ctx: Context, id: string, events: readonly SessionEvent[]): ReturnType<Context['sessions']['create']> {
  return ctx.sessions.create(SessionId(id), { seed: events })
}

/** Poll until the predicate holds, failing loud past the deadline. */
async function until(predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met before the deadline')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function sole(ctx: Context): CandidateView {
  const candidates = ctx.tasks.candidates()
  if (candidates.length !== 1) throw new Error(`expected one candidate, found ${candidates.length}`)
  return candidates[0]!
}

describe('foldGoals', () => {
  it('keeps the latest snapshot per goal id and carries the blocker', () => {
    const events = seed([
      [goal('create', 'g-1', 1, 'active'), 1_000],
      [goal('edit', 'g-1', 2, 'blocked', '支持暗色模式', { code: 'token', message: '颜色令牌未定' }), 2_000],
      [goal('create', 'g-2', 1, 'active', '首屏优化'), 3_000],
    ])
    const folded = foldGoals(events)
    expect(folded.get('g-1')).toMatchObject({ phase: 'blocked', blockedReason: { code: 'token', message: '颜色令牌未定' } })
    expect(folded.get('g-2')).toMatchObject({ phase: 'active', objective: '首屏优化' })
  })

  it('pins a clear tombstone instead of deleting the goal', () => {
    const events = seed([
      [goal('create', 'g-1', 1, 'active'), 1_000],
      [goalClear('g-1', 2), 2_000],
    ])
    expect(foldGoals(events).get('g-1')).toBe('cleared')
  })

  it('ignores non-goal events', () => {
    const mixed: SessionEvent[] = [
      ...seed([[goal('create', 'g-1', 1, 'active'), 1_000]]),
      { type: 'session/end-seed', seq: 1, time: 2_000, data: {} },
    ]
    expect(foldGoals(mixed).size).toBe(1)
  })
})

describe('foldApprovedPlan', () => {
  const PLAN = '# 暗色模式支持\n1. 定义颜色令牌\n2. 切换全部界面'

  it('pairs an error-free exit result with its call and reads the plan', () => {
    const events = renumber([...planReview(PLAN, 1_000)])
    const plan = foldApprovedPlan(events)
    expect(plan).toMatchObject({ title: '暗色模式支持', plan: PLAN, todos: 'none', activityAfterApproval: false })
  })

  it('rejects a review that errored: no fact at all', () => {
    const events = renumber([...planReview(PLAN, 1_000, { name: 'Error', code: 'TOOL_FAILED' })])
    expect(foldApprovedPlan(events)).toBeUndefined()
  })

  it('marks post-approval model activity and folds the latest todo table', () => {
    const events = renumber([
      ...planReview(PLAN, 1_000),
      todoWrite([{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'in_progress' }], 2_000),
      assistantMessage('开始切换', 3_000),
    ])
    expect(foldApprovedPlan(events)).toMatchObject({ todos: 'unfinished', activityAfterApproval: true })

    const finished = renumber([
      ...planReview(PLAN, 1_000),
      todoWrite([{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'completed' }], 2_000),
    ])
    expect(foldApprovedPlan(finished)).toMatchObject({ todos: 'done' })
  })
})

describe('foldTodos', () => {
  it('anchors a new chain to the nearest preceding human message, not plugin notices', () => {
    const events = renumber([
      userMessage('帮我支持暗色模式', 1_000),
      assistantMessage('好的', 2_000),
      userMessage('稍后提示', 2_500, { kind: 'plugin', plugin: 'plan-mode', form: 'notice', summary: '稍后提示' }),
      todoWrite([{ content: '定义颜色令牌', status: 'pending' }], 3_000),
    ])
    const fact = foldTodos(events)
    expect(fact).toMatchObject({ anchorText: '帮我支持暗色模式' })
    expect(fact!.anchorSeq).toBe(events[0]!.seq)
    expect(fact!.unfinished).toHaveLength(1)
  })

  it('returns undefined without any write and finishes on an all-completed table', () => {
    expect(foldTodos(renumber([userMessage('随便聊聊', 1_000)]))).toBeUndefined()
    const done = renumber([
      userMessage('数到三', 1_000),
      todoWrite([{ content: '数到三', status: 'completed' }], 2_000),
    ])
    expect(foldTodos(done)!.unfinished).toHaveLength(0)
  })

  it('keeps the newest chain: a later human request with fresh entries re-anchors', () => {
    const events = renumber([
      userMessage('第一件事', 1_000),
      todoWrite([{ content: '甲', status: 'completed' }], 2_000),
      userMessage('第二件事,做多行说明', 3_000),
      todoWrite([{ content: '乙', status: 'in_progress' }], 4_000),
    ])
    const fact = foldTodos(events)
    expect(fact).toMatchObject({ anchorText: '第二件事,做多行说明' })
    expect(fact!.unfinished.map(item => item.content)).toEqual(['乙'])
  })
})

describe('extractSession', () => {
  it('births one pending candidate per unfinished goal, blocked goals carry the blocker note', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-1', seed([
      [goal('create', 'g-1', 1, 'active'), 1_000],
      [goal('block', 'g-2', 2, 'blocked', '首屏优化', { code: 'vendor', message: '等第三方 SDK' }), 2_000],
      [goal('pause', 'g-3', 1, 'paused', '已暂停的事'), 3_000],
      [goal('complete', 'g-4', 2, 'complete', '做完的事'), 4_000],
    ]))
    await extractSession(ctx, session, 10)
    const candidates = ctx.tasks.candidates()
    expect(candidates.map(view => view.record.origin.key)).toEqual(['g-1', 'g-2', 'g-3'])
    expect(candidates[0]).toMatchObject({ record: { status: 'pending', objective: '支持暗色模式', note: '' } })
    expect(candidates[1]!.record.note).toContain('等第三方 SDK')
    expect(candidates.every(view => view.record.origin.tier === 'goal' && view.record.origin.sessionId === session.id)).toBe(true)
  })

  it('is idempotent per origin: re-extraction never births a second candidate', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-1', seed([[goal('create', 'g-1', 1, 'active'), 1_000]]))
    await extractSession(ctx, session, 10)
    await extractSession(ctx, session, 10)
    expect(ctx.tasks.candidates()).toHaveLength(1)
  })

  it('supersedes the pending candidate when the goal completes or clears', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-1', seed([[goal('create', 'g-1', 1, 'active'), 1_000]]))
    await extractSession(ctx, session, 10)
    session.append('goal/change', goal('complete', 'g-1', 2, 'complete'))
    await extractSession(ctx, session, 10)
    expect(sole(ctx).record.status).toBe('superseded')

    const second = liveSession(ctx, 's-2', seed([[goal('create', 'g-2', 1, 'active'), 1_000]]))
    await extractSession(ctx, second, 10)
    second.append('goal/change', goalClear('g-2', 2))
    await extractSession(ctx, second, 10)
    expect(ctx.tasks.candidates().find(view => view.record.origin.key === 'g-2')!.record.status).toBe('superseded')
  })

  it('never touches a candidate that already spoke: ignored and promoted stay put', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-1', seed([[goal('create', 'g-1', 1, 'active'), 1_000]]))
    await extractSession(ctx, session, 10)
    const born = sole(ctx)
    const ignored = await ctx.tasks.candidateIgnore(born.record.id, born.record.revision, { kind: 'human' })
    if ('code' in ignored) throw new Error(ignored.code)
    // The goal later completes: an ignored verdict is final, and no re-birth.
    session.append('goal/change', goal('complete', 'g-1', 2, 'complete'))
    await extractSession(ctx, session, 10)
    expect(sole(ctx).record.status).toBe('ignored')

    const second = liveSession(ctx, 's-2', seed([[goal('create', 'g-2', 1, 'active'), 1_000]]))
    await extractSession(ctx, second, 10)
    const pending = ctx.tasks.candidates().find(view => view.record.origin.key === 'g-2')!
    const promoted = await ctx.tasks.candidatePromote(pending.record.id, pending.record.revision, { acceptance: '切换后全部界面生效' }, { kind: 'human' })
    if ('code' in promoted) throw new Error(promoted.code)
    second.append('goal/change', goal('complete', 'g-2', 2, 'complete'))
    await extractSession(ctx, second, 10)
    expect(ctx.tasks.candidates().find(view => view.record.origin.key === 'g-2')!.record.status).toBe('promoted')
  })

  it('births a plan-tier candidate from an approved plan with unfinished todos', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-plan', renumber([
      ...planReview('# 暗色模式支持\n1. 定义颜色令牌\n2. 切换全部界面', 1_000),
      todoWrite([{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'pending' }], 2_000),
    ]))
    await extractSession(ctx, session, 10)
    const born = sole(ctx)
    expect(born.record.origin).toEqual({ sessionId: session.id, tier: 'plan', key: '暗色模式支持' })
    expect(born.record.objective).toBe('暗色模式支持')
    expect(born.record.note).toContain('# 暗色模式支持')
    // All steps completed later: positive completion evidence retires it.
    session.append('todo/write', { todos: [{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'completed' }] })
    await extractSession(ctx, session, 10)
    expect(sole(ctx).record.status).toBe('superseded')
  })

  it('births a todo-less approved plan only when nothing followed the approval', async () => {
    const ctx = await boot()
    const stalled = liveSession(ctx, 's-stalled', renumber([...planReview('# 一次通过', 1_000)]))
    await extractSession(ctx, stalled, 10)
    expect(sole(ctx).record.origin).toEqual({ sessionId: stalled.id, tier: 'plan', key: '一次通过' })

    const started = liveSession(ctx, 's-started', renumber([
      ...planReview('# 动过手的计划', 1_000),
      assistantMessage('开始执行', 2_000),
    ]))
    await extractSession(ctx, started, 10)
    // Work at least started without todo tracking: no tier owns this stall in
    // v1 (the summarizer only takes sessions with no structural signal) —
    // no candidate here.
    expect(ctx.tasks.candidates().filter(view => view.record.origin.sessionId === started.id)).toHaveLength(0)
  })

  it('births a todo-tier candidate anchored to the user, and retires it when the table completes', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-todo', renumber([
      userMessage('帮我支持暗色模式', 1_000),
      todoWrite([{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'in_progress' }], 2_000),
    ]))
    await extractSession(ctx, session, 10)
    const born = sole(ctx)
    expect(born.record.origin).toEqual({ sessionId: session.id, tier: 'todo', key: `seq:${session.events[0]!.seq}` })
    expect(born.record.objective).toBe('帮我支持暗色模式')
    expect(born.record.note).toBe('- 切换全部界面')
    session.append('todo/write', { todos: [{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'completed' }] })
    await extractSession(ctx, session, 10)
    expect(sole(ctx).record.status).toBe('superseded')
  })

  it('respects tier priority: an unfinished goal claims the session, a plan claims the todo chain', async () => {
    const ctx = await boot()
    const withGoal = liveSession(ctx, 's-goal', renumber([
      userMessage('帮我支持暗色模式', 1_000),
      ...seed([[goal('create', 'g-1', 1, 'active'), 2_000]]),
      ...planReview('# 暗色模式支持', 3_000),
      todoWrite([{ content: '定义颜色令牌', status: 'pending' }], 4_000),
    ]))
    await extractSession(ctx, withGoal, 10)
    expect(sole(ctx).record.origin.tier).toBe('goal')

    const withPlan = liveSession(ctx, 's-plan-only', renumber([
      userMessage('帮我优化首屏', 1_000),
      ...planReview('# 首屏优化', 2_000),
      todoWrite([{ content: '压缩图片', status: 'pending' }], 3_000),
    ]))
    await extractSession(ctx, withPlan, 10)
    const planCandidates = ctx.tasks.candidates().filter(view => view.record.origin.sessionId === withPlan.id)
    expect(planCandidates.map(view => view.record.origin.tier)).toEqual(['plan'])
  })
})

describe('task-source plugin', () => {
  it('rejects invalid config loudly', async () => {
    await expect((async () => {
      const ctx = await boot()
      await ctx.plugin(TaskSource, sourceConfig('unused', { pollSeconds: 0 }))
    })()).rejects.toThrow('pollSeconds')
    await expect((async () => {
      const ctx = await boot()
      await ctx.plugin(TaskSource, sourceConfig('unused', { idleHours: 0 }))
    })()).rejects.toThrow('idleHours')
    await expect((async () => {
      const ctx = await boot()
      await ctx.plugin(TaskSource, sourceConfig(' ', { }))
    })()).rejects.toThrow('agent.provider')
    await expect((async () => {
      const ctx = await boot()
      await ctx.plugin(TaskSource, sourceConfig('unused', { summariesPerTick: 0 }))
    })()).rejects.toThrow('summariesPerTick')
    await expect((async () => {
      const ctx = await boot()
      await ctx.plugin(TaskSource, sourceConfig('unused', { transcriptEvents: 0 }))
    })()).rejects.toThrow('transcriptEvents')
  })

  it('boot-sweeps idle sessions and skips fresh ones', async () => {
    const ctx = await boot()
    const now = Date.now()
    liveSession(ctx, 's-old', seed([[goal('create', 'g-old', 1, 'active'), now - 4 * HOUR]]))
    liveSession(ctx, 's-fresh', seed([[goal('create', 'g-fresh', 1, 'active'), now]]))
    // The awaited first tick is the boot sweep: no timer waits involved.
    await ctx.plugin(TaskSource, sourceConfig('unused'))
    expect(sole(ctx).record.origin).toEqual({ sessionId: SessionId('s-old'), tier: 'goal', key: 'g-old' })
  })

  it('waits out the idle window, then re-extracts only on new activity', async () => {
    const ctx = await boot()
    const now = Date.now()
    const session = liveSession(ctx, 's-1', seed([[goal('create', 'g-1', 1, 'active'), now]]))
    // 0.0003h ≈ 1.1s: fresh at boot, idle shortly after; ticks every 50ms.
    await ctx.plugin(TaskSource, sourceConfig('unused', { pollSeconds: 0.05, idleHours: 0.0003 }))
    expect(ctx.tasks.candidates()).toHaveLength(0)
    await until(() => ctx.tasks.candidates().length === 1)
    expect(sole(ctx).record.objective).toBe('支持暗色模式')

    // New activity re-arms the session, but the same origin never re-births
    // nor updates: v1 dedup leaves the standing candidate untouched.
    session.append('goal/change', goal('block', 'g-1', 2, 'blocked', '支持暗色模式', { code: 'token', message: '颜色令牌未定' }))
    await until(() => Date.now() - session.events.at(-1)!.time > 1_200)
    await until(() => ctx.tasks.candidates().length > 0)
    const candidate = sole(ctx)
    expect(candidate.record.note).toBe('')
    expect(ctx.tasks.candidates()).toHaveLength(1)
  })

  it('extracts a disposed session immediately, bypassing the idle gate', async () => {
    const ctx = await boot()
    await ctx.plugin(TaskSource, sourceConfig('unused', { idleHours: 24 }))
    // A detached session entered and announced by hand: `enter` returns the
    // detach disposer whose call emits `session/disposed`.
    const session = Session.create(SessionId('s-gone'), seed([[goal('create', 'g-1', 1, 'active'), Date.now()]]))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    detach()
    await until(() => ctx.tasks.candidates().length === 1)
    expect(sole(ctx).record.origin.sessionId).toBe(SessionId('s-gone'))
  })
})

/** An idle chat-only session: conversation, no structural record. */
function chatSession(ctx: Context, id: string, time = Date.now() - 4 * HOUR): ReturnType<Context['sessions']['create']> {
  return liveSession(ctx, id, renumber([
    userMessage('以后有空把首屏优化一下,现在先不管', time),
    assistantMessage('好的,先记下这件事。', time + 1),
  ]))
}

/** Adapter that answers every request with one fixed assistant text. */
class VerdictAdapter extends LlmAdapter {
  /** Every user text this route has seen, probes included. */
  readonly inputs: string[] = []

  constructor(private readonly answer: string) {
    super()
  }

  providerInfo(provider: string) {
    return { id: provider, name: `verdict ${provider}` }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages.find(message => message.role === 'user')?.content
      .find(block => block.type === 'text')
    if (text !== undefined && text.type === 'text') this.inputs.push(text.text)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const TASK_VERDICT = '{"objective": "首屏加载时间降到 1 秒以内", "acceptance": "本地刷新后 Lighthouse 性能分 ≥ 90", "note": "用户自己搁置的意图"}'

describe('summarizer tier', () => {
  it('parses a verdict from bare JSON, fenced JSON, and prose; rejects the rest', () => {
    expect(parseVerdict(TASK_VERDICT)).toEqual({
      objective: '首屏加载时间降到 1 秒以内',
      acceptance: '本地刷新后 Lighthouse 性能分 ≥ 90',
      note: '用户自己搁置的意图',
    })
    expect(parseVerdict(`判定如下:\n\`\`\`json\n${TASK_VERDICT}\n\`\`\`\n以上。`)).toMatchObject({ objective: '首屏加载时间降到 1 秒以内' })
    expect(parseVerdict('{"none": "问题已解答"}')).toEqual({ none: '问题已解答' })
    expect(parseVerdict('完全没有 JSON')).toBeUndefined()
    expect(parseVerdict('{"objective": "只有目标"}')).toBeUndefined()
    expect(parseVerdict('{"objective": 1, "acceptance": 2}')).toBeUndefined()
  })

  it('builds the judged prompt: conditions, examples, dedup list, transcript, answer contract', () => {
    const request: SummaryRequest = {
      sessionId: SessionId('s-chat'), lastSeq: 5,
      transcript: ['用户: 以后有空把首屏优化一下', '模型: 好的'],
    }
    const prompt = buildSummaryPrompt(request, ['支持暗色模式'])
    expect(prompt).toContain('三必要条件')
    expect(prompt).toContain('可判定的完成')
    expect(prompt).toContain('- 支持暗色模式')
    expect(prompt).toContain('用户: 以后有空把首屏优化一下')
    expect(prompt).toContain('{"objective"')
    expect(prompt).toContain('{"none"')
    // The dedup list only appears when something stands.
    expect(buildSummaryPrompt(request, [])).not.toContain('既有任务与候选的目标')
  })

  it('yields a summary request only for chat-only sessions, windowed', async () => {
    const ctx = await boot()
    const chat = chatSession(ctx, 's-chat')
    const request = await extractSession(ctx, chat, 1)
    expect(request).toMatchObject({ sessionId: chat.id, lastSeq: chat.events.at(-1)!.seq })
    // Window 1 keeps only the newest line.
    expect(request!.transcript).toEqual(['模型: 好的,先记下这件事。'])

    // Any structural record claims the session — even a finished goal.
    const withGoal = liveSession(ctx, 's-goal', renumber([
      userMessage('帮我支持暗色模式', 1_000),
      ...seed([[goal('create', 'g-1', 1, 'complete'), 2_000]]),
    ]))
    expect(await extractSession(ctx, withGoal, 10)).toBeUndefined()
    // A session with no human line has nothing to judge.
    const quiet = liveSession(ctx, 's-quiet', renumber([
      userMessage('插件通知', 1_000, { kind: 'plugin', plugin: 'p', form: 'notice', summary: '插件通知' }),
    ]))
    expect(await extractSession(ctx, quiet, 10)).toBeUndefined()
  })

  it('summarizes an idle chat-only session into a candidate through a scripted route', async () => {
    const ctx = await boot()
    const created = await ctx.tasks.create({ objective: '支持暗色模式', acceptance: '切换后全部界面生效' }, { kind: 'human' })
    if ('code' in created) throw new Error(created.code)
    chatSession(ctx, 's-chat')
    const adapter = new VerdictAdapter(TASK_VERDICT)
    ctx.llm.registerAdapter(['summary-route'], adapter)
    // The boot tick runs (and awaits) the whole summary inside mount.
    await ctx.plugin(TaskSource, sourceConfig('summary-route'))

    const born = sole(ctx)
    expect(born.record.origin).toEqual({ sessionId: SessionId('s-chat'), tier: 'summary', key: 'summary' })
    expect(born.record.objective).toBe('首屏加载时间降到 1 秒以内')
    expect(born.record.acceptance).toBe('本地刷新后 Lighthouse 性能分 ≥ 90')
    expect(born.record.note).toBe('用户自己搁置的意图')
    // The judged prompt reached the model: marker, standing objective for
    // dedup, the user's own words, and the answer contract.
    const prompt = adapter.inputs.find(text => text.includes('[task-source]'))!
    expect(prompt).toContain('支持暗色模式')
    expect(prompt).toContain('用户: 以后有空把首屏优化一下')
    expect(prompt).toContain('{"objective"')
  })

  it('births nothing on a none verdict and retires the pending summary candidate', async () => {
    const ctx = await boot()
    const chat = chatSession(ctx, 's-chat')
    const adapter = new VerdictAdapter('{"none": "请求已解答,无后续工作"}')
    ctx.llm.registerAdapter(['summary-route'], adapter)
    await ctx.plugin(TaskSource, sourceConfig('summary-route', { idleHours: 24 }))
    expect(ctx.tasks.candidates()).toHaveLength(0)

    // A pending summary candidate from an earlier burst: the none verdict on
    // new activity retires it.
    const request = await extractSession(ctx, chat, 10)
    if (request === undefined) throw new Error('expected a summary request')
    const seeded = await ctx.tasks.candidateCreate({
      objective: '旧的搁置意图', acceptance: '旧标准',
      origin: { sessionId: chat.id, tier: 'summary', key: 'summary' },
    }, { kind: 'source' })
    if ('code' in seeded) throw new Error(seeded.code)
    await summarize(ctx, sourceConfig('summary-route'), request)
    expect(sole(ctx).record.status).toBe('superseded')
    expect(sole(ctx).record.origin.tier).toBe('summary')
  })

  it('caps summaries per tick: the over-cap session defers to the next tick', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    chatSession(ctx, 's-one')
    chatSession(ctx, 's-two')
    const adapter = new VerdictAdapter(TASK_VERDICT)
    ctx.llm.registerAdapter(['summary-route'], adapter)
    await ctx.plugin(TaskSource, sourceConfig('summary-route', { pollSeconds: 0.05, summariesPerTick: 1 }))

    // The awaited boot tick spent its single summary; the second session waits.
    const summaries = () => ctx.agents.list().filter(agent => agent.session.id.startsWith('summary-'))
    expect(summaries()).toHaveLength(1)
    expect(ctx.tasks.candidates()).toHaveLength(1)
    await until(() => summaries().length === 2)
    await until(() => ctx.tasks.candidates().length === 2)
  })

  it('defers the summary while the route is quota-walled, then runs it', { timeout: 8_000 }, async () => {
    /** Route that dies in QUOTA with a short delay until reopened. */
    class WallAdapter extends LlmAdapter {
      walled = true

      providerInfo(provider: string) {
        return { id: provider, name: `wall ${provider}` }
      }

      async *stream(): AsyncIterable<StreamChunk> {
        if (this.walled) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'usage limit reached', code: QUOTA_EXCEEDED_CODE, providerRetryAfterMs: 150 } } }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: TASK_VERDICT }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: TASK_VERDICT } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    const ctx = await boot()
    chatSession(ctx, 's-chat')
    const adapter = new WallAdapter()
    ctx.llm.registerAdapter(['summary-route'], adapter)
    await ctx.plugin(TaskSource, sourceConfig('summary-route', { pollSeconds: 0.05 }))

    // Walled: the probe defers each tick — no summary session, no candidate.
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(ctx.agents.list().some(agent => agent.session.id.startsWith('summary-'))).toBe(false)
    expect(ctx.tasks.candidates()).toHaveLength(0)

    adapter.walled = false
    await until(() => ctx.tasks.candidates().length === 1)
    expect(sole(ctx).record.origin.tier).toBe('summary')
  })

  it('summarizes a disposed chat session immediately and queues it when walled', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    const adapter = new VerdictAdapter(TASK_VERDICT)
    ctx.llm.registerAdapter(['summary-route'], adapter)
    await ctx.plugin(TaskSource, sourceConfig('summary-route', { pollSeconds: 0.05, idleHours: 24 }))
    const session = Session.create(SessionId('s-gone'), renumber([
      userMessage('以后有空把首屏优化一下,现在先不管', Date.now()),
      assistantMessage('好的,先记下这件事。', Date.now() + 1),
    ]))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    detach()
    // Disposal bypasses the idle gate: the summary runs right away.
    await until(() => ctx.tasks.candidates().length === 1)
    expect(sole(ctx).record.origin).toEqual({ sessionId: SessionId('s-gone'), tier: 'summary', key: 'summary' })
  })
})
