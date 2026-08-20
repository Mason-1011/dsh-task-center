/**
 * Real-model project assignment (e2e): a human seeds one project through the
 * seam; the agent discovers it with task_projects, creates a task assigned by
 * the exact id from that listing, and verifies the scoped task_query. Proves
 * the model can navigate human-managed grouping without inventing ids.
 * Self-skips without DEEPSEEK_API_KEY.
 * @module dsh-task-center-tool-task/tests/project-e2e
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as llmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from 'dsh-task-center-task'
import * as TaskLocal from 'dsh-task-center-task-local'
import * as ToolTask from '../src/index.ts'

const root = await mkdtemp(join(tmpdir(), 'task-project-'))
const ctx = new Context()
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const instruction = [
  '你在参与一个项目归组演示。人类已建好一个项目。请严格用任务工具:',
  '1) task_projects 查看项目列表(只有一个,记住它返回的精确 id);',
  '2) task_create 建任务:objective 为「维护 README 的安装一节」,acceptance 为「步骤按当前版本逐条核对过」,参数 project_id 填刚才记住的 id;',
  '3) task_query 参数只用 project_id(同一个 id),确认列表里恰好有你刚建的任务。',
  '只使用任务工具。',
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
  ]
  void fibers
}

const suite = process.env.DEEPSEEK_API_KEY === undefined ? describe.skip : describe

suite('real-model project assignment', () => {
  it('discovers the human project, assigns the task, and queries the scope', { timeout: 300_000 }, async () => {
    await boot()
    const project = await ctx.tasks.projectCreate('文档维护', { kind: 'human' })
    if ('code' in project) throw new Error(project.code)
    const projectId = project.project.record.id

    const run = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('proj-a'), agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    const idle = run.agent.whenIdle()
    run.agent.followup(createUserMessage({ content: [{ type: 'text', text: instruction }], source: { kind: 'user' } }))
    await idle

    const tasks = ctx.tasks.list({})
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.record.objective).toContain('README')
    expect(tasks[0]!.record.projectId).toBe(projectId)
    console.log('assigned task after the live round trip:', JSON.stringify({
      taskId: tasks[0]!.record.id,
      projectId: tasks[0]!.record.projectId,
      projectName: ctx.tasks.project(projectId)?.record.name,
    }, null, 2))
  })
})
