/**
 * Keyless extraction tests over the real session store and task seam: the
 * three structural folds (goal snapshots, approved plans, todo chains with
 * their human anchors), tier-priority birth / supersede / dedup through the
 * source actor, the idle gate with per-session watermarks, the boot sweep,
 * and disposed-session immediacy.
 * @module @task-center/task-source/tests/source
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalBlockReason, GoalChangeMeta, GoalClearChangeMeta, GoalOperation, GoalPhase, GoalSnapshotChangeMeta } from '@deepseek-ai/dsh-goal'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import { TaskService } from '@task-center/task'
import type { CandidateView } from '@task-center/task'
import { extractSession, foldApprovedPlan, foldGoals, foldTodos } from '../src/index.ts'
import * as TaskSource from '../src/index.ts'

const HOUR = 3_600_000

/** Boot the session store and the task seam — no extractor yet. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
  return ctx
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
    await extractSession(ctx, session)
    const candidates = ctx.tasks.candidates()
    expect(candidates.map(view => view.record.origin.key)).toEqual(['g-1', 'g-2', 'g-3'])
    expect(candidates[0]).toMatchObject({ record: { status: 'pending', objective: '支持暗色模式', note: '' } })
    expect(candidates[1]!.record.note).toContain('等第三方 SDK')
    expect(candidates.every(view => view.record.origin.tier === 'goal' && view.record.origin.sessionId === session.id)).toBe(true)
  })

  it('is idempotent per origin: re-extraction never births a second candidate', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-1', seed([[goal('create', 'g-1', 1, 'active'), 1_000]]))
    await extractSession(ctx, session)
    await extractSession(ctx, session)
    expect(ctx.tasks.candidates()).toHaveLength(1)
  })

  it('supersedes the pending candidate when the goal completes or clears', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-1', seed([[goal('create', 'g-1', 1, 'active'), 1_000]]))
    await extractSession(ctx, session)
    session.append('goal/change', goal('complete', 'g-1', 2, 'complete'))
    await extractSession(ctx, session)
    expect(sole(ctx).record.status).toBe('superseded')

    const second = liveSession(ctx, 's-2', seed([[goal('create', 'g-2', 1, 'active'), 1_000]]))
    await extractSession(ctx, second)
    second.append('goal/change', goalClear('g-2', 2))
    await extractSession(ctx, second)
    expect(ctx.tasks.candidates().find(view => view.record.origin.key === 'g-2')!.record.status).toBe('superseded')
  })

  it('never touches a candidate that already spoke: ignored and promoted stay put', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-1', seed([[goal('create', 'g-1', 1, 'active'), 1_000]]))
    await extractSession(ctx, session)
    const born = sole(ctx)
    const ignored = await ctx.tasks.candidateIgnore(born.record.id, born.record.revision, { kind: 'human' })
    if ('code' in ignored) throw new Error(ignored.code)
    // The goal later completes: an ignored verdict is final, and no re-birth.
    session.append('goal/change', goal('complete', 'g-1', 2, 'complete'))
    await extractSession(ctx, session)
    expect(sole(ctx).record.status).toBe('ignored')

    const second = liveSession(ctx, 's-2', seed([[goal('create', 'g-2', 1, 'active'), 1_000]]))
    await extractSession(ctx, second)
    const pending = ctx.tasks.candidates().find(view => view.record.origin.key === 'g-2')!
    const promoted = await ctx.tasks.candidatePromote(pending.record.id, pending.record.revision, { acceptance: '切换后全部界面生效' }, { kind: 'human' })
    if ('code' in promoted) throw new Error(promoted.code)
    second.append('goal/change', goal('complete', 'g-2', 2, 'complete'))
    await extractSession(ctx, second)
    expect(ctx.tasks.candidates().find(view => view.record.origin.key === 'g-2')!.record.status).toBe('promoted')
  })

  it('births a plan-tier candidate from an approved plan with unfinished todos', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-plan', renumber([
      ...planReview('# 暗色模式支持\n1. 定义颜色令牌\n2. 切换全部界面', 1_000),
      todoWrite([{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'pending' }], 2_000),
    ]))
    await extractSession(ctx, session)
    const born = sole(ctx)
    expect(born.record.origin).toEqual({ sessionId: session.id, tier: 'plan', key: '暗色模式支持' })
    expect(born.record.objective).toBe('暗色模式支持')
    expect(born.record.note).toContain('# 暗色模式支持')
    // All steps completed later: positive completion evidence retires it.
    session.append('todo/write', { todos: [{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'completed' }] })
    await extractSession(ctx, session)
    expect(sole(ctx).record.status).toBe('superseded')
  })

  it('births a todo-less approved plan only when nothing followed the approval', async () => {
    const ctx = await boot()
    const stalled = liveSession(ctx, 's-stalled', renumber([...planReview('# 一次通过', 1_000)]))
    await extractSession(ctx, stalled)
    expect(sole(ctx).record.origin).toEqual({ sessionId: stalled.id, tier: 'plan', key: '一次通过' })

    const started = liveSession(ctx, 's-started', renumber([
      ...planReview('# 动过手的计划', 1_000),
      assistantMessage('开始执行', 2_000),
    ]))
    await extractSession(ctx, started)
    // Work at least started without todo tracking: the summarizer tier's case,
    // not the structural one's — no candidate here.
    expect(ctx.tasks.candidates().filter(view => view.record.origin.sessionId === started.id)).toHaveLength(0)
  })

  it('births a todo-tier candidate anchored to the user, and retires it when the table completes', async () => {
    const ctx = await boot()
    const session = liveSession(ctx, 's-todo', renumber([
      userMessage('帮我支持暗色模式', 1_000),
      todoWrite([{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'in_progress' }], 2_000),
    ]))
    await extractSession(ctx, session)
    const born = sole(ctx)
    expect(born.record.origin).toEqual({ sessionId: session.id, tier: 'todo', key: `seq:${session.events[0]!.seq}` })
    expect(born.record.objective).toBe('帮我支持暗色模式')
    expect(born.record.note).toBe('- 切换全部界面')
    session.append('todo/write', { todos: [{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'completed' }] })
    await extractSession(ctx, session)
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
    await extractSession(ctx, withGoal)
    expect(sole(ctx).record.origin.tier).toBe('goal')

    const withPlan = liveSession(ctx, 's-plan-only', renumber([
      userMessage('帮我优化首屏', 1_000),
      ...planReview('# 首屏优化', 2_000),
      todoWrite([{ content: '压缩图片', status: 'pending' }], 3_000),
    ]))
    await extractSession(ctx, withPlan)
    const planCandidates = ctx.tasks.candidates().filter(view => view.record.origin.sessionId === withPlan.id)
    expect(planCandidates.map(view => view.record.origin.tier)).toEqual(['plan'])
  })
})

describe('task-source plugin', () => {
  it('rejects non-positive config loudly', async () => {
    await expect((async () => {
      const ctx = await boot()
      await ctx.plugin(TaskSource, { pollSeconds: 0, idleHours: 1 })
    })()).rejects.toThrow('pollSeconds')
    await expect((async () => {
      const ctx = await boot()
      await ctx.plugin(TaskSource, { pollSeconds: 60, idleHours: 0 })
    })()).rejects.toThrow('idleHours')
  })

  it('boot-sweeps idle sessions and skips fresh ones', async () => {
    const ctx = await boot()
    const now = Date.now()
    liveSession(ctx, 's-old', seed([[goal('create', 'g-old', 1, 'active'), now - 4 * HOUR]]))
    liveSession(ctx, 's-fresh', seed([[goal('create', 'g-fresh', 1, 'active'), now]]))
    // The awaited first tick is the boot sweep: no timer waits involved.
    await ctx.plugin(TaskSource, { pollSeconds: 3600, idleHours: 3 })
    expect(sole(ctx).record.origin).toEqual({ sessionId: SessionId('s-old'), tier: 'goal', key: 'g-old' })
  })

  it('waits out the idle window, then re-extracts only on new activity', async () => {
    const ctx = await boot()
    const now = Date.now()
    const session = liveSession(ctx, 's-1', seed([[goal('create', 'g-1', 1, 'active'), now]]))
    // 0.0003h ≈ 1.1s: fresh at boot, idle shortly after; ticks every 50ms.
    await ctx.plugin(TaskSource, { pollSeconds: 0.05, idleHours: 0.0003 })
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
    await ctx.plugin(TaskSource, { pollSeconds: 3600, idleHours: 24 })
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
