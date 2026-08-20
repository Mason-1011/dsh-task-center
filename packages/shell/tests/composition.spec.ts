/**
 * Real-composition guard for the whole center: the shipped cordis.yml boots
 * through the actual Loader + Include path (tests/boot.ts), `/task`
 * round-trips a task through the booted command registry, shelving visibility
 * (idle days + stale banner) renders from the same ledger, and the same
 * composition restarted on the same data root still sees the ledger — the
 * one-command launcher's exact boot path minus the native module import.
 * @module dsh-task-center-shell/tests/composition
 */

import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentOf, bootCenter } from './boot.ts'

/**
 * Simulate days passing on the durable ledger: shift every stored `at` instant
 * back by whole days (wake anchors and scheduled points use other keys and
 * stay put). The next boot folds the shifted stream — the honest equivalent of
 * waiting, minus the wait.
 * @param root - the data root holding `task.json`.
 * @param days - whole days to age the ledger by.
 */
async function backdateLedger(root: string, days: number): Promise<void> {
  const file = join(root, 'task.json')
  const shift = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(shift)
    if (node === null || typeof node !== 'object') return node
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === 'at' && typeof value === 'string'
        ? new Date(Date.parse(value) - days * 86_400_000).toISOString()
        : shift(value)
    }
    return out
  }
  const aged = shift(JSON.parse(await readFile(file, 'utf8')))
  await writeFile(file, JSON.stringify(aged, null, 2))
}

/** Dispatch one slash line and return its result text, failing loud on errors. */
async function dispatch(ctx: Context, agent: Agent, line: string): Promise<string> {
  const signal = new AbortController().signal
  const execution = await ctx.commands.execute(agent, line, [], signal)
  if (execution === undefined) throw new Error(`${line} did not resolve to a command`)
  if (execution.result.kind === 'error') throw new Error(`${line} failed: ${execution.result.text}`)
  return execution.result.text ?? ''
}

const root = await mkdtemp(join(tmpdir(), 'task-center-shell-'))
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('center composition', () => {
  it('boots the shipped cordis.yml and round-trips a task through /task', { timeout: 60_000 }, async () => {
    const ctx = await bootCenter(root)
    try {
      const agent = agentOf(ctx)

      const panel = await dispatch(ctx, agent, '/task')
      expect(panel).toBe('任务队列为空')

      await dispatch(ctx, agent, '/task project create 迁移')
      await dispatch(ctx, agent, '/task create 数据核对 :: 数字全对 in 迁移')
      expect(await dispatch(ctx, agent, '/task')).toContain('📅 迁移 (1)')
      expect(ctx.tasks.list({})).toHaveLength(1)

      // Shelving visibility through the assembled composition: ledger
      // last-touch instants drive both the line markers and the stale banner
      // (shipped staleDays: 3).
      vi.useFakeTimers()
      vi.setSystemTime(Date.now() + 4.5 * 86_400_000)
      const stale = await dispatch(ctx, agent, '/task')
      vi.useRealTimers()
      expect(stale).toContain('⚠ 搁置最久(闲置 4 天)')
      expect(stale).toContain('📅 迁移 (1) · 闲置 4 天')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restarts on the same root with the aged ledger surfacing shelving', { timeout: 60_000 }, async () => {
    // The previous context is disposed: a fresh boot on the same data root is a
    // host restart. The ledger aged five days on disk, so it must still carry
    // the task and project AND greet the human with the stale banner.
    await backdateLedger(root, 5)
    const ctx = await bootCenter(root)
    try {
      const agent = agentOf(ctx)

      const tasks = ctx.tasks.list({})
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.record.objective).toBe('数据核对')
      const panel = await dispatch(ctx, agent, '/task')
      expect(panel).toContain('⚠ 搁置最久(闲置 5 天)')
      expect(panel).toContain('📅 迁移 (1) · 闲置 5 天')
      expect(await dispatch(ctx, agent, '/task project')).toContain('闲置 5 天')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
