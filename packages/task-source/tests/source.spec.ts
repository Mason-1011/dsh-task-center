/**
 * Keyless extraction tests over the real session store and task seam: the
 * goal fold (latest snapshot wins, clear tombstones pin), candidate birth /
 * supersede / dedup through the source actor, the idle gate with per-session
 * watermarks, the boot sweep, and disposed-session immediacy.
 * @module @task-center/task-source/tests/source
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalBlockReason, GoalChangeMeta, GoalClearChangeMeta, GoalOperation, GoalPhase, GoalSnapshotChangeMeta } from '@deepseek-ai/dsh-goal'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TaskService } from '@task-center/task'
import type { CandidateView } from '@task-center/task'
import { extractSession, foldGoals } from '../src/index.ts'
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
