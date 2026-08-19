/**
 * Keyless progress-reflow tests (design 06 §7 第二层 + 第三层): the window
 * fold over todo tables and goal changes, the note rendering, the closed
 * loop — a closing turn writes one `progress` line into the holding
 * session's tasks with a session receipt, pure chatter writes nothing,
 * compare-and-set collisions retry once then drop, and a disposed session
 * flushes the turn it died in without a receipt — and the goal mirror:
 * decisive goal transitions park or submit the held tasks.
 * @module @task-center/task-source/tests/reflow
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, MessageId, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalChangeMeta } from '@deepseek-ai/dsh-goal'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import type { TaskView } from '@task-center/task'
import { foldEvidence, foldGoalMirrors, reflowHeldTasks, renderEvidence } from '../src/index.ts'
import * as TaskSource from '../src/index.ts'

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

/** Extractor config over an unused route; idle gate far in the future. */
function sourceConfig() {
  return { pollSeconds: 3600, idleHours: 24, agent: { provider: 'unused', model: 'm' }, summariesPerTick: 3, transcriptEvents: 10 }
}

/** Event types on the ordered surface — seeds must mark how they entered it. */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** One event of any type with a fabricated seq, handed the payload verbatim. */
function eventOf<K extends SessionEvent['type']>(type: K, data: SessionEvent<K>['data'], time: number): SessionEvent<K> {
  // The distributive mapped SessionEvent<K> defeats the generic assignability
  // check, so one cast assembles the four-field shape.
  return {
    type, seq: -1, time, data,
    ...SURFACE_TYPES.has(type) ? { surfaceOp: 'append' as const } : {},
  } as SessionEvent<K>
}

/** Renumber a mixed event list into a contiguous log. */
function renumber(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: index }))
}

/** A user/message event from the human. */
function userMessage(text: string, time: number): SessionEvent<'user/message'> {
  return eventOf('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), time)
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

/** A todo/write whole-table snapshot. */
function todoWrite(entries: readonly { content: string; status: TodoItem['status'] }[], time: number): SessionEvent<'todo/write'> {
  return eventOf('todo/write', { todos: entries.map(entry => ({ ...entry })) }, time)
}

/** One goal snapshot change. */
function goalChange(objective: string, phase: 'active' | 'blocked' | 'complete', time: number, blockedReason?: { code: string; message: string }): SessionEvent<'goal/change'> {
  const data: GoalChangeMeta = {
    kind: 'goal/change', version: 1, operation: phase === 'active' ? 'create' : phase === 'blocked' ? 'block' : 'complete',
    goal: { id: GoalId('g-1'), revision: 1, objective, phase, ...blockedReason === undefined ? {} : { blockedReason }, maxGoalRounds: 5 },
    roundsStarted: 0, createdAt: time, updatedAt: time,
  }
  return eventOf('goal/change', data, time)
}

/** Turn framing events; the reason is irrelevant to the evidence. */
function turnStart(turn: number, time: number): SessionEvent<'turn/start'> {
  return eventOf('turn/start', { turn }, time)
}

function turnEnd(turn: number, time: number): SessionEvent<'turn/end'> {
  return eventOf('turn/end', { turn, reason: { kind: 'completed' } }, time)
}

/** One live session carrying the given log. */
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

/** One task claimed by the named session, failing loud; returns the view. */
async function heldTask(ctx: Context, sessionId: string): Promise<TaskView> {
  const created = await ctx.tasks.create({ objective: '支持暗色模式', acceptance: '切换后全部界面生效' }, { kind: 'human' })
  if ('code' in created) throw new Error(created.code)
  const holder = Session.create(SessionId(sessionId))
  const claimed = await ctx.tasks.claim(created.task.record.id, holder, { kind: 'model', sessionId: SessionId(sessionId) })
  if ('code' in claimed) throw new Error(claimed.code)
  return claimed
}

describe('foldEvidence', () => {
  it('diffs the window: adds, status moves, removals; the opening table comes from before it', () => {
    const events = renumber([
      todoWrite([{ content: '甲', status: 'completed' }, { content: '乙', status: 'pending' }, { content: '丙', status: 'pending' }], 1_000),
      turnEnd(1, 1_500),
      todoWrite([{ content: '甲', status: 'completed' }, { content: '乙', status: 'in_progress' }, { content: '丁', status: 'pending' }], 2_000),
      turnEnd(2, 2_500),
    ])
    const evidence = foldEvidence(events, events[1]!.seq, events[3]!.seq)
    expect(evidence.todo).toEqual([
      { kind: 'move', content: '乙', from: 'pending', to: 'in_progress' },
      { kind: 'add', content: '丁', to: 'pending' },
      { kind: 'remove', content: '丙', from: 'pending' },
    ])
    expect(evidence.goals).toEqual([])
    // Nothing moved in a window without a todo write, even across many events.
    const quiet = renumber([turnStart(1, 1_000), userMessage('继续', 1_100), assistantMessage('好的', 1_200), turnEnd(1, 1_300)])
    expect(foldEvidence(quiet, 0, quiet.at(-1)!.seq)).toEqual({ todo: [], goals: [] })
  })

  it('renders goal changes in the window and names a cleared goal from its earlier snapshot', () => {
    const events = renumber([
      goalChange('支持暗色模式', 'active', 1_000),
      turnEnd(1, 1_500),
      goalChange('支持暗色模式', 'blocked', 2_000, { code: 'token', message: '颜色令牌未定' }),
      eventOf('goal/change', { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: GoalId('g-1'), revision: 2 }, clearedAt: 2_100 }, 2_100),
      turnEnd(2, 2_500),
    ])
    const evidence = foldEvidence(events, events[1]!.seq, events[4]!.seq)
    expect(evidence.goals).toEqual([
      'goal 支持暗色模式: blocked(token: 颜色令牌未定)',
      'goal 已清除: 支持暗色模式',
    ])
    expect(renderEvidence(evidence)).toBe('自动回流 goal: goal 支持暗色模式: blocked(token: 颜色令牌未定); goal 已清除: 支持暗色模式')
  })
})

describe('renderEvidence', () => {
  it('joins both channels and reads empty when the window is quiet', () => {
    expect(renderEvidence({ todo: [], goals: [] })).toBe('')
    expect(renderEvidence({ todo: [{ kind: 'add', content: '丁', to: 'pending' }], goals: ['goal 目标: complete'] }))
      .toBe('自动回流 todo: + 丁(pending) | goal: goal 目标: complete')
    expect(renderEvidence({ todo: [{ kind: 'move', content: '乙', from: 'pending', to: 'completed' }], goals: [] }))
      .toBe('自动回流 todo: 乙 pending→completed')
    expect(renderEvidence({ todo: [{ kind: 'remove', content: '丙', from: 'pending' }], goals: [] }))
      .toBe('自动回流 todo: − 丙')
  })
})

describe('turn reflow closed loop', () => {
  it('writes one progress line per closing turn with evidence, and nothing for chatter', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    const before = Date.now()
    const session = liveSession(ctx, 's-work', renumber([
      turnStart(1, before),
      userMessage('开工', before + 1),
      assistantMessage('先分解', before + 2),
      turnEnd(1, before + 3),
    ]))
    const view = await heldTask(ctx, 's-work')
    const revisionAtClaim = ctx.tasks.get(view.record.id)!.record.revision
    await ctx.plugin(TaskSource, sourceConfig())

    // Turn 2 decomposes: three fresh entries are evidence of this turn.
    session.append('todo/write', { todos: [{ content: '定义颜色令牌', status: 'pending' }, { content: '切换全部界面', status: 'pending' }] })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await until(() => ctx.tasks.get(view.record.id)!.record.contextPack.includes('自动回流'))
    let record = ctx.tasks.get(view.record.id)!.record
    expect(record.contextPack).toContain('+ 定义颜色令牌(pending)')
    expect(record.revision).toBe(revisionAtClaim + 1)
    // The write is model-initiated by the holding session: a receipt landed.
    expect(session.events.some(event => event.type === 'task/change')).toBe(true)

    // Turn 3 checks one off; turn 4 is pure chatter and writes nothing.
    session.append('todo/write', { todos: [{ content: '定义颜色令牌', status: 'completed' }, { content: '切换全部界面', status: 'pending' }] })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await until(() => ctx.tasks.get(view.record.id)!.record.contextPack.includes('定义颜色令牌 pending→completed'))
    session.append('assistant/message', {
      turn: 4, step: 1,
      message: { id: MessageId('a-4'), role: 'assistant', content: [{ type: 'text', text: '闲聊一句' }], source: { kind: 'model', provider: 'mock', model: 'mock-model' } },
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 4, reason: { kind: 'aborted', reason: { kind: 'legacy' } } })
    await new Promise(resolve => setTimeout(resolve, 200))
    record = ctx.tasks.get(view.record.id)!.record
    expect(record.revision).toBe(revisionAtClaim + 2)
    expect(record.contextPack.split('\n')).toHaveLength(2)
    // Evidence stands however the turn ended: the aborted turn-4 window was empty,
    // and reflow never refreshed workedAt for it.
    expect(Date.parse(record.workedAt)).toBeGreaterThan(before)
  })

  it('never writes for a session that holds nothing, and skips tasks out of progress reach', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    const now = Date.now()
    const stranger = liveSession(ctx, 's-stranger', renumber([
      turnStart(1, now), userMessage('别人的活', now + 1), turnEnd(1, now + 2),
    ]))
    const holder = liveSession(ctx, 's-holder', renumber([
      turnStart(1, now), userMessage('我的活', now + 1), turnEnd(1, now + 2),
    ]))
    const view = await heldTask(ctx, 's-holder')
    // The holder submitted: progress is illegal from review.
    const submitted = await ctx.tasks.mutate(view.record.id, view.record.revision,
      { operation: 'submit', completionNote: '完成了' }, { kind: 'model', sessionId: SessionId('s-holder') }, holder)
    if ('code' in submitted) throw new Error(submitted.code)
    const revisionAtSubmit = submitted.record.revision
    await ctx.plugin(TaskSource, sourceConfig())

    stranger.append('todo/write', { todos: [{ content: '陌生条目', status: 'in_progress' }] })
    stranger.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    holder.append('todo/write', { todos: [{ content: '持有条目', status: 'in_progress' }] })
    holder.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(ctx.tasks.get(view.record.id)!.record.revision).toBe(revisionAtSubmit)
    expect(ctx.tasks.get(view.record.id)!.record.contextPack).not.toContain('自动回流')
  })

  it('retries a compare-and-set collision once, then drops on a second', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    const view = await heldTask(ctx, 's-race')
    const original = ctx.tasks.mutate.bind(ctx.tasks)
    // First reflow attempt is preempted by the model's own report; the retry lands.
    let preempt = true
    ctx.tasks.mutate = async (taskId, expectedRevision, mutation, actor, session) => {
      if (preempt && mutation.operation === 'progress' && actor.kind === 'model') {
        preempt = false
        const current = ctx.tasks.get(taskId)
        if (current !== undefined) {
          const raced = await original(taskId, current.record.revision, { operation: 'progress', note: '模型自己汇报' }, actor, session)
          if ('code' in raced) throw new Error(raced.code)
        }
      }
      return original(taskId, expectedRevision, mutation, actor, session)
    }
    await reflowHeldTasks(ctx, SessionId('s-race'), '自动回流 todo: 甲 pending→completed')
    ctx.tasks.mutate = original
    let record = ctx.tasks.get(view.record.id)!.record
    expect(record.contextPack).toContain('模型自己汇报')
    expect(record.contextPack).toContain('自动回流')

    // Always preempting: both attempts go stale, the line drops without throwing.
    ctx.tasks.mutate = async (taskId, expectedRevision, mutation, actor, session) => {
      if (mutation.operation === 'progress' && actor.kind === 'model') {
        const current = ctx.tasks.get(taskId)
        if (current !== undefined) {
          const raced = await original(taskId, current.record.revision, { operation: 'progress', note: '模型又汇报' }, actor, session)
          if ('code' in raced) throw new Error(raced.code)
        }
      }
      return original(taskId, expectedRevision, mutation, actor, session)
    }
    await reflowHeldTasks(ctx, SessionId('s-race'), '自动回流 todo: 乙 pending→completed')
    record = ctx.tasks.get(view.record.id)!.record
    expect(record.contextPack).not.toContain('乙')
    expect(record.contextPack).toContain('模型又汇报')
  })

  it('flushes the turn a disposed session died in, without a receipt', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    const now = Date.now()
    const session = Session.create(SessionId('s-gone'), renumber([
      turnStart(1, now), userMessage('做个总结', now + 1), turnEnd(1, now + 2),
      turnStart(2, now + 3), userMessage('继续', now + 4),
      todoWrite([{ content: '收尾条目', status: 'in_progress' }], now + 5),
      // Turn 2 never closes: the headless session dies mid-turn.
    ]))
    const view = await heldTask(ctx, 's-gone')
    await ctx.plugin(TaskSource, sourceConfig())
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    detach()
    await until(() => ctx.tasks.get(view.record.id)!.record.contextPack.includes('自动回流'))
    expect(ctx.tasks.get(view.record.id)!.record.contextPack).toContain('+ 收尾条目(in_progress)')
    // Disposal writes no receipt: the log is closed.
    expect(session.events.some(event => event.type === 'task/change')).toBe(false)
  })

  it('settles only post-mount turns: history before the last closed turn never reflows', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    const now = Date.now()
    // Two closed historical turns with evidence, then a turn that started
    // before mount and closes after it — only that one flushes, tail included.
    const session = liveSession(ctx, 's-restore', renumber([
      turnStart(1, now), todoWrite([{ content: '历史一', status: 'pending' }], now + 1), turnEnd(1, now + 2),
      turnStart(2, now + 3), todoWrite([{ content: '历史一', status: 'completed' }], now + 4), turnEnd(2, now + 5),
    ]))
    const view = await heldTask(ctx, 's-restore')
    const revisionAtClaim = ctx.tasks.get(view.record.id)!.record.revision
    session.append('todo/write', { todos: [{ content: '历史一', status: 'completed' }, { content: '恢复后新条目', status: 'pending' }] })
    await ctx.plugin(TaskSource, sourceConfig())
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await until(() => ctx.tasks.get(view.record.id)!.record.revision > revisionAtClaim)
    const pack = ctx.tasks.get(view.record.id)!.record.contextPack
    expect(pack).not.toContain('历史一 pending→completed')
    expect(pack).toContain('+ 恢复后新条目(pending)')
  })
})

describe('goal mirror', () => {
  it('folds decisive transitions only: latest per goal wins, ordered by their final event', () => {
    const events = renumber([
      eventOf('goal/change', { kind: 'goal/change', version: 1, operation: 'block', goal: { id: GoalId('g-1'), revision: 1, objective: '暗色', phase: 'blocked', blockedReason: { code: 'token', message: '令牌未定' }, maxGoalRounds: 5 }, roundsStarted: 0, createdAt: 1_000, updatedAt: 1_000 }, 1_000),
      turnEnd(1, 1_500),
      // Same goal resumes then completes inside the window: latest (complete) wins.
      eventOf('goal/change', { kind: 'goal/change', version: 1, operation: 'resume', goal: { id: GoalId('g-1'), revision: 2, objective: '暗色', phase: 'active', maxGoalRounds: 5 }, roundsStarted: 0, createdAt: 1_000, updatedAt: 2_000 }, 2_000),
      eventOf('goal/change', { kind: 'goal/change', version: 1, operation: 'complete', goal: { id: GoalId('g-1'), revision: 3, objective: '暗色', phase: 'complete', maxGoalRounds: 5 }, roundsStarted: 1, createdAt: 1_000, updatedAt: 2_100 }, 2_100),
      // A second goal blocks after it: both goals mirror, in final-event order.
      eventOf('goal/change', { kind: 'goal/change', version: 1, operation: 'block', goal: { id: GoalId('g-2'), revision: 1, objective: '迁移文档', phase: 'blocked', blockedReason: { code: 'deps', message: '上游未发版' }, maxGoalRounds: 5 }, roundsStarted: 0, createdAt: 2_200, updatedAt: 2_200 }, 2_200),
      // An edit while blocked keeps the phase: no mirror of its own.
      eventOf('goal/change', { kind: 'goal/change', version: 1, operation: 'edit', goal: { id: GoalId('g-2'), revision: 2, objective: '迁移文档(改)', phase: 'blocked', blockedReason: { code: 'deps', message: '上游未发版' }, maxGoalRounds: 5 }, roundsStarted: 0, createdAt: 2_200, updatedAt: 2_300 }, 2_300),
      turnEnd(2, 2_500),
    ])
    expect(foldGoalMirrors(events, events[1]!.seq, events[6]!.seq)).toEqual([
      { kind: 'complete', goalId: 'g-1', objective: '暗色' },
      { kind: 'blocked', goalId: 'g-2', objective: '迁移文档', reason: { code: 'deps', message: '上游未发版' } },
    ])
    // Outside the window: nothing.
    expect(foldGoalMirrors(events, events[6]!.seq, events[6]!.seq)).toEqual([])
  })

  it('parks a held task on a non-quota block, and the goal evidence line lands beside the BLOCKED line', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    const before = Date.now()
    const session = liveSession(ctx, 's-block', renumber([
      turnStart(1, before), userMessage('开工', before + 1), turnEnd(1, before + 2),
    ]))
    const view = await heldTask(ctx, 's-block')
    await ctx.plugin(TaskSource, sourceConfig())
    session.append('goal/change', {
      kind: 'goal/change', version: 1, operation: 'block',
      goal: { id: GoalId('g-9'), revision: 1, objective: '支持暗色模式', phase: 'blocked', blockedReason: { code: 'token', message: '颜色令牌未定' }, maxGoalRounds: 5 },
      roundsStarted: 0, createdAt: before, updatedAt: before + 3,
    })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await until(() => ctx.tasks.get(view.record.id)!.record.status === 'blocked')
    const record = ctx.tasks.get(view.record.id)!.record
    expect(record.blockedReason).toEqual({ code: 'token', message: '颜色令牌未定' })
    // Progress evidence and the state transition are two distinct pack lines.
    expect(record.contextPack).toContain('自动回流 goal: goal 支持暗色模式: blocked(token: 颜色令牌未定)')
    expect(record.contextPack).toContain('BLOCKED token: 颜色令牌未定')
    expect(session.events.some(event => event.type === 'task/change')).toBe(true)
  })

  it('submits on goal completion — even out of a blocked task, because the progress write normalized it first', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    const now = Date.now()
    const session = liveSession(ctx, 's-done', renumber([
      turnStart(1, now), userMessage('开工', now + 1), turnEnd(1, now + 2),
    ]))
    const view = await heldTask(ctx, 's-done')
    const actor = { kind: 'model' as const, sessionId: SessionId('s-done') }
    const parked = await ctx.tasks.mutate(view.record.id, view.record.revision,
      { operation: 'block', reason: { code: 'token', message: '颜色令牌未定' } }, actor, session)
    if ('code' in parked) throw new Error(parked.code)
    await ctx.plugin(TaskSource, sourceConfig())
    // One window carrying resume then complete of the same goal.
    session.append('goal/change', {
      kind: 'goal/change', version: 1, operation: 'resume',
      goal: { id: GoalId('g-8'), revision: 2, objective: '支持暗色模式', phase: 'active', maxGoalRounds: 5 },
      roundsStarted: 0, createdAt: now, updatedAt: now + 3,
    })
    session.append('goal/change', {
      kind: 'goal/change', version: 1, operation: 'complete',
      goal: { id: GoalId('g-8'), revision: 3, objective: '支持暗色模式', phase: 'complete', maxGoalRounds: 5 },
      roundsStarted: 1, createdAt: now, updatedAt: now + 4,
    })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await until(() => ctx.tasks.get(view.record.id)!.record.status === 'review')
    const record = ctx.tasks.get(view.record.id)!.record
    expect(record.contextPack).toContain('SUBMITTED: 由 goal「支持暗色模式」完成自动提交,请按验收标准人工裁决')
    expect(record.blockedReason).toBeUndefined()
    // Submit parks the task in review but keeps the hold: the human verdict releases it.
    expect(record.holder).toBe(SessionId('s-done'))
  })

  it('skips quota-coded blocks and tasks outside active', { timeout: 8_000 }, async () => {
    const ctx = await boot()
    const now = Date.now()
    const parkedSession = liveSession(ctx, 's-quota', renumber([
      turnStart(1, now), userMessage('开工', now + 1), turnEnd(1, now + 2),
    ]))
    const parkedView = await heldTask(ctx, 's-quota')
    await ctx.plugin(TaskSource, sourceConfig())
    parkedSession.append('goal/change', {
      kind: 'goal/change', version: 1, operation: 'block',
      goal: { id: GoalId('g-7'), revision: 1, objective: '批量翻译', phase: 'blocked', blockedReason: { code: QUOTA_EXCEEDED_CODE, message: '额度用尽' }, maxGoalRounds: 5 },
      roundsStarted: 0, createdAt: now, updatedAt: now + 3,
    })
    parkedSession.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await until(() => ctx.tasks.get(parkedView.record.id)!.record.contextPack.includes('自动回流'))
    // Let the settle window finish before judging its end state.
    await new Promise(resolve => setTimeout(resolve, 200))
    // Quota is task-quota's lifecycle: the mirror left the state alone.
    expect(ctx.tasks.get(parkedView.record.id)!.record.status).toBe('active')

    // A task already awaiting verdict: submit from review is the human's call.
    const reviewSession = liveSession(ctx, 's-review', renumber([
      turnStart(1, now), userMessage('收尾', now + 1), turnEnd(1, now + 2),
    ]))
    const reviewView = await heldTask(ctx, 's-review')
    const actor = { kind: 'model' as const, sessionId: SessionId('s-review') }
    const submitted = await ctx.tasks.mutate(reviewView.record.id, reviewView.record.revision,
      { operation: 'submit', completionNote: '模型自报完成' }, actor, reviewSession)
    if ('code' in submitted) throw new Error(submitted.code)
    reviewSession.append('goal/change', {
      kind: 'goal/change', version: 1, operation: 'complete',
      goal: { id: GoalId('g-6'), revision: 1, objective: '收尾', phase: 'complete', maxGoalRounds: 5 },
      roundsStarted: 0, createdAt: now, updatedAt: now + 3,
    })
    reviewSession.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await until(() => ctx.tasks.get(reviewView.record.id)!.record.contextPack.includes('SUBMITTED: 模型自报完成'))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(ctx.tasks.get(reviewView.record.id)!.record.status).toBe('review')
  })
})
