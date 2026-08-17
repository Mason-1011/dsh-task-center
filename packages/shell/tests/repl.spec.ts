/**
 * Keyless REPL tests over the real composition (tests/boot.ts, through the
 * Loader): slash lines dispatch through the command registry and print their
 * result, unknown commands hint instead of reaching the model, `/exit`
 * terminates the loop, and the composition disposes with the context fiber.
 * @module @task-center/shell/tests/repl
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { runRepl } from '../src/index.ts'
import type { ReplIo } from '../src/index.ts'
import { bootCenter } from './boot.ts'

const root = await mkdtemp(join(tmpdir(), 'task-center-repl-'))
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Scripted input plus collected output; the prompt marker is a no-op. */
function scriptedIo(lines: readonly string[]): { io: ReplIo; output: string[] } {
  const output: string[] = []
  const queue = [...lines]
  const io: ReplIo = {
    lines: (async function* () {
      while (queue.length > 0) yield queue.shift()!
    })(),
    write: line => { output.push(line) },
    prompt: () => {},
  }
  return { io, output }
}

describe('task-shell REPL', () => {
  it('dispatches commands, hints on unknown ones, and exits on /exit', { timeout: 60_000 }, async () => {
    const ctx = await bootCenter(root)
    try {
      const agent = ctx.agentLoop.create(SessionId('repl'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

      const { io, output } = scriptedIo([
        '/task create 数数 :: 数到三',
        '/task',
        '/frobnicate',
        '/exit',
        '/task 这一行不应执行',
      ])
      await runRepl(ctx, agent, io)

      const text = output.join('\n')
      expect(text).toContain('已创建')
      expect(text).toContain('数数')
      expect(text).toContain('未知命令:/frobnicate')
      // /exit terminated the loop: the queued trailing line never dispatched.
      expect(output.filter(line => line.includes('这一行不应执行'))).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('disposes its composition with the context fiber', { timeout: 60_000 }, async () => {
    const ctx = await bootCenter(root)
    const agent = ctx.agentLoop.create(SessionId('repl-2'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const { io } = scriptedIo(['/exit'])
    await runRepl(ctx, agent, io)
    await ctx.fiber.dispose()
    expect(ctx.get('tasks')).toBeUndefined()
  })
})
