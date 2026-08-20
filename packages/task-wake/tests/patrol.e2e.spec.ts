/**
 * Real-model patrol e2e: a human leaves two unfinished tasks shelved;
 * `runPatrol` starts one DeepSeek session that inventories both and records a
 * `task_patrol` observation on each — no claim, no status move, and the shelving
 * clock (`workedAt`) untouched, which is the whole point of the patrol.
 * Self-skips without DEEPSEEK_API_KEY, matching the harness e2e key policy.
 * @module dsh-task-center-task-wake/tests/patrol-e2e
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as llmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from 'dsh-task-center-task'
import * as TaskLocal from 'dsh-task-center-task-local'
import * as ToolTask from 'dsh-task-center-tool-task'
import * as TaskWake from '../src/index.ts'

const root = await mkdtemp(join(tmpdir(), 'task-patrol-'))
const ctx = new Context()
afterAll(async () => {
  await ctx.fiber.dispose().catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

const suite = process.env.DEEPSEEK_API_KEY === undefined ? describe.skip : describe

suite('real-model patrol', () => {
  it('observes every unfinished task once, without claiming or unshelving', { timeout: 300_000 }, async () => {
    for (const plugin of [
      await ctx.plugin(LlmRuntime),
      await ctx.plugin(SessionStore),
      await ctx.plugin(SystemPrompt, {}),
      await ctx.plugin(ToolRuntime, {}),
      await ctx.plugin(AgentRegistry),
      await ctx.plugin(AgentLoop, { agents: [] }),
      await ctx.plugin(llmDeepseek, {}),
      await ctx.plugin(Storage),
      await ctx.plugin(StorageJson, { root }),
      await ctx.plugin(StorageDomain, { backend: 'json', routes: {} }),
      await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 }),
      await ctx.plugin(TaskLocal),
      await ctx.plugin(ToolTask),
    ]) void plugin

    const first = await ctx.tasks.create({
      objective: '整理数据库迁移清单:列出待迁移的三张表',
      acceptance: '清单包含三张表名及各自迁移顺序',
    }, { kind: 'human' })
    if ('code' in first) throw new Error(first.code)
    const second = await ctx.tasks.create({
      objective: '给 CLI 加 --quiet 参数: suppress 非错误输出',
      acceptance: '带 --quiet 时只输出错误行',
    }, { kind: 'human' })
    if ('code' in second) throw new Error(second.code)
    const shelved = [first.task, second.task]

    const config: TaskWake.Config = { pollSeconds: 30, agent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }
    const idle = TaskWake.runPatrol(ctx, config)
    expect(idle).toBeDefined()
    await idle

    for (const view of shelved) {
      const after = ctx.tasks.get(view.record.id)!
      // Observation only: the patrol refreshed the pack but neither moved the
      // task nor rewound its shelving clock.
      expect(after.record.status).toBe('todo')
      expect(after.record.holder).toBeUndefined()
      expect(after.record.workedAt).toBe(view.record.workedAt)
      expect(after.record.contextPack).toContain('PATROL:')
    }
    const patrolSessions = ctx.agents.list().filter(agent => agent.session.id.startsWith('patrol-'))
    expect(patrolSessions).toHaveLength(1)
    // The patrol session logged its own receipts — model-visible means logged.
    expect(patrolSessions[0]!.session.events.some(event => event.type === 'task/change')).toBe(true)

    console.log('patrol packs:', JSON.stringify(shelved.map(view => ({
      objective: view.record.objective,
      pack: ctx.tasks.get(view.record.id)!.record.contextPack,
    })), null, 2))
  })
})
