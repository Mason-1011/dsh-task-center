/**
 * Pure idle-vocabulary tests: the subtree-aware effective idle and its
 * display-side join with the holder session's live activity (design 06 §7
 * 第一层 — a holder at work keeps its line fresh with zero ledger writes; a
 * session not live in this process falls back to `workedAt`).
 * @module dsh-task-center-task/tests/idle
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TaskService, effectiveIdle, lastSessionActivity } from '../src/index.ts'
import type { HolderActivity, TaskView } from '../src/index.ts'

const DAY = 86_400_000
const human = { kind: 'human' } as const

function setup(): TaskService {
  const ctx = new Context()
  return new TaskService(ctx, { contextPackByteLimit: 1000, listDefaultLimit: 20 })
}

/** One task claimed by a model session, failing loud; returns the view. */
async function claimedTask(service: TaskService): Promise<TaskView> {
  const created = await service.create({ objective: 'o', acceptance: 'a' }, human)
  if ('code' in created) throw new Error(created.code)
  const holder = Session.create(SessionId('s-holder'))
  const claimed = await service.claim(created.task.record.id, holder, { kind: 'model', sessionId: holder.id })
  if ('code' in claimed) throw new Error(claimed.code)
  return claimed
}

describe('lastSessionActivity', () => {
  it('reads the last non-marker event and skips end-seed bookkeeping', () => {
    const events: readonly { type: string; time: number }[] = [
      { type: 'user/message', time: 1_000 },
      { type: 'session/end-seed', time: 9_000 },
    ]
    expect(lastSessionActivity(events)).toBe(1_000)
    expect(lastSessionActivity([{ type: 'session/end-seed', time: 5 }])).toBeUndefined()
    expect(lastSessionActivity([])).toBeUndefined()
  })
})

describe('effectiveIdle holder join', () => {
  it('counts a live holder session as activity the ledger has not heard', async () => {
    vi.useFakeTimers()
    try {
      const service = setup()
      vi.setSystemTime(1_000 * DAY)
      const view = await claimedTask(service)
      const now = new Date(1_000 * DAY + 4.5 * DAY)
      const fresh: HolderActivity = () => now.getTime() - 3_600_000
      // No reader, an activity instant equal to the ledger's touch, and an
      // absent (not-live) holder all read the same four whole days.
      expect(effectiveIdle(service, view, now)).toBe(4)
      expect(effectiveIdle(service, view, now, () => 1_000 * DAY)).toBe(4)
      expect(effectiveIdle(service, view, now, () => undefined)).toBe(4)
      // A holder event from one hour ago reads fresh: zero whole idle days.
      expect(effectiveIdle(service, view, now, fresh)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never un-freshens: a holder older than the ledger touch changes nothing', async () => {
    vi.useFakeTimers()
    try {
      const service = setup()
      const view = await claimedTask(service)
      // A progress touch now; the holder's last event predates it by five days.
      const touched = await service.mutate(view.record.id, view.record.revision,
        { operation: 'progress', note: 'step' }, { kind: 'model', sessionId: SessionId('s-holder') })
      if ('code' in touched) throw new Error(touched.code)
      const now = new Date(Date.now() + 2 * DAY)
      const current = service.get(view.record.id)!
      expect(effectiveIdle(service, current, now, () => Date.now() - 5 * DAY)).toBe(2)
      // One hour before now reads fresh; exactly one day before reads 1.
      expect(effectiveIdle(service, current, now, () => now.getTime() - 3_600_000)).toBe(0)
      expect(effectiveIdle(service, current, now, () => now.getTime() - DAY)).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('extends to the subtree: a fresh holder on a child keeps the parent alive', async () => {
    vi.useFakeTimers()
    try {
      const service = setup()
      vi.setSystemTime(1_000 * DAY)
      const parent = await service.create({ objective: 'p', acceptance: 'a' }, human)
      if ('code' in parent) throw new Error(parent.code)
      const child = await service.create({ objective: 'c', acceptance: 'a' }, human)
      if ('code' in child) throw new Error(child.code)
      const attached = await service.mutate(parent.task.record.id, parent.task.record.revision,
        { operation: 'subtask-add', childId: child.task.record.id }, human)
      if ('code' in attached) throw new Error(attached.code)
      const holder = Session.create(SessionId('s-child'))
      const claimed = await service.claim(child.task.record.id, holder, { kind: 'model', sessionId: holder.id })
      if ('code' in claimed) throw new Error(claimed.code)

      const now = new Date(1_000 * DAY + 4.5 * DAY)
      const view = service.get(parent.task.record.id)!
      expect(effectiveIdle(service, view, now, () => undefined)).toBe(4)
      expect(effectiveIdle(service, view, now, () => now.getTime() - 60_000)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
