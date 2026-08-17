/**
 * Real-model wake e2e: a human creates a task and sets a due wake rule; the
 * timer consumes the occurrence in the ledger, then a fresh DeepSeek session
 * fires, claims the task, works it, and submits for review — with no human in
 * the loop beyond setting the rule. Self-skips without DEEPSEEK_API_KEY,
 * matching the harness e2e key policy.
 * @module @task-center/task-wake/tests/fire-e2e
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
import { TaskService } from '@task-center/task'
import type { TaskId } from '@task-center/task'
import * as TaskLocal from '@task-center/task-local'
import * as TaskWake from '../src/index.ts'
import * as ToolTask from '@task-center/tool-task'

const root = await mkdtemp(join(tmpdir(), 'task-wake-'))
const ctx = new Context()
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function boot(): Promise<void> {
  const fibers = [
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
    await ctx.plugin(TaskWake, { pollSeconds: 0.5, agent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
  ]
  void fibers
}

/** Poll until the task leaves todo, proving the fired session moved it. */
async function untilWorked(taskId: TaskId): Promise<'review' | 'blocked'> {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const status = ctx.tasks.get(taskId)?.record.status
    if (status === 'review' || status === 'blocked') return status
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('the fired session did not submit before the deadline')
}

const suite = process.env.DEEPSEEK_API_KEY === undefined ? describe.skip : describe

suite('real-model wake fire', () => {
  it('fires a session at the due time that claims and submits the task', { timeout: 300_000 }, async () => {
    await boot()

    const created = await ctx.tasks.create({
      objective: '统计单词 hello 在句子 "hello again, hello wake" 中出现的次数',
      acceptance: '给出出现次数并说明数法',
    }, { kind: 'human' })
    if ('code' in created) throw new Error(created.code)
    const taskId = created.task.record.id
    const set = await ctx.tasks.mutate(taskId, created.task.record.revision,
      { operation: 'wake-set', rule: { kind: 'at', scheduledAt: new Date(Date.now() - 1000).toISOString() } }, { kind: 'human' })
    if ('code' in set) throw new Error(set.code)

    const status = await untilWorked(taskId)
    expect(status).toBe('review')

    const task = ctx.tasks.get(taskId)!
    // The holder is the fired wake session, not any human or pre-existing one.
    expect(task.record.holder?.startsWith('wake-')).toBe(true)
    expect(task.record.contextPack).toContain('SUBMITTED')
    expect(task.record.wakeRule).toBeUndefined()

    const fired = ctx.agents.list().find(agent => agent.session.id.startsWith('wake-'))
    expect(fired).toBeDefined()
    expect(fired!.session.events.some(event => event.type === 'task/context-injected')).toBe(true)

    console.log('wake-fired task:', JSON.stringify({
      id: task.record.id,
      status: task.record.status,
      holder: task.record.holder,
      contextPack: task.record.contextPack,
    }, null, 2))
  })
})
