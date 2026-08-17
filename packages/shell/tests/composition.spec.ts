/**
 * Real-composition guard for the whole center: the shipped cordis.yml boots
 * through the actual Loader + Include path (tests/boot.ts), `/task`
 * round-trips a task through the booted command registry, and the same
 * composition restarted on the same data root still sees the ledger — the
 * one-command launcher's exact boot path minus the native module import.
 * @module @task-center/shell/tests/composition
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentOf, bootCenter } from './boot.ts'

/** Dispatch one slash line and return its result text, failing loud on errors. */
async function dispatch(ctx: Context, agent: Agent, line: string): Promise<string> {
  const signal = new AbortController().signal
  const execution = await ctx.commands.execute(agent, line, signal)
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
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restarts on the same root with the ledger intact', { timeout: 60_000 }, async () => {
    // The previous context is disposed: a fresh boot on the same data root is a
    // host restart, and the durable ledger must still carry the task and project.
    const ctx = await bootCenter(root)
    try {
      const agent = agentOf(ctx)

      const tasks = ctx.tasks.list({})
      expect(tasks).toHaveLength(1)
      expect(tasks[0]!.record.objective).toBe('数据核对')
      const panel = await dispatch(ctx, agent, '/task')
      expect(panel).toContain('📅 迁移 (1)')
      expect(await dispatch(ctx, agent, '/task project')).toContain('迁移')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
