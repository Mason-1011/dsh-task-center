/**
 * Real-model closed loop (e2e): boots the full published agent spine with the
 * DeepSeek provider and the task packages, then lets one live model session
 * walk 创建 → 认领 → 推进 → 提交 through the five task tools — and the human
 * actor closes it with `/task approve`. Self-skips without DEEPSEEK_API_KEY,
 * matching the harness e2e key policy.
 * @module @task-center/tool-task/tests/loop-e2e
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as llmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import * as CommandTask from '@task-center/command-task'
import * as TaskLocal from '@task-center/task-local'
import * as ToolTask from '../src/index.ts'

const root = await mkdtemp(join(tmpdir(), 'task-loop-'))
const ctx = new Context()
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const instruction = [
  '用任务工具完成一个小任务的全流程:',
  '1) task_create:objective 为「统计单词 hello 在句子 "hello world, hello task center" 中出现的次数」,acceptance 为「给出出现次数并说明数法」;',
  '2) task_claim 认领该任务;',
  '3) task_update 记录你的数法(带 next 可选);',
  '4) task_report 以 outcome=review 提交,completion note 逐条对照 acceptance。',
  '只使用任务工具,不要使用其他工具。',
].join('\n')

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
    await ctx.plugin(CommandRuntime),
    await ctx.plugin(CommandTask),
  ]
  void fibers
}

const suite = process.env.DEEPSEEK_API_KEY === undefined ? describe.skip : describe

suite('real-model task loop', () => {
  it('walks create → claim → update → submit → human approve through the live DeepSeek provider', { timeout: 240_000 }, async () => {
    await boot()

    const agent = ctx.agentLoop.create(SessionId('task-loop-1'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    const idle = agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'user' },
    }))
    await idle

    const types = agent.session.events.map(event => event.type)
    expect(types).toContain('task/context-injected')
    expect(types.filter(type => type === 'task/change').length).toBeGreaterThanOrEqual(3)

    const tasks = ctx.tasks.list({})
    expect(tasks).toHaveLength(1)
    let task = tasks[0]!
    expect(task.record.status).toBe('review')
    expect(task.record.objective).toContain('hello')
    expect(task.record.contextPack).not.toBe('')
    expect(task.record.contextPack).toContain('SUBMITTED')

    // The human actor closes the loop: the command never reaches the model.
    const approved = await ctx.commands.execute(agent, `/task approve ${task.record.id.slice(0, 8)}`, AbortSignal.timeout(10_000))
    expect(approved?.result.kind).toBe('success')
    task = ctx.tasks.list({})[0]!
    expect(task.record.status).toBe('done')
    expect(task.record.holder).toBeUndefined()
    expect(agent.session.events.some(event => event.type === 'command/done')).toBe(true)

    // The durable ledger holds the whole exchange, receipts included.
    expect((await readdir(root)).some(file => file.endsWith('.json'))).toBe(true)

    console.log('task after the live loop:', JSON.stringify({
      id: task.record.id,
      status: task.record.status,
      revision: task.record.revision,
      holder: task.record.holder,
      contextPack: task.record.contextPack,
    }, null, 2))
  })
})
