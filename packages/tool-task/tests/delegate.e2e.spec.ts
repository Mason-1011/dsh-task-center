/**
 * Real-model delegation (e2e): session A creates the parent task, claims it,
 * and decomposes it — task_create with parent_task_id links a fresh counting
 * child under the parent it holds. Session B, a stranger to the parent, lists
 * the parent's children via task_query, claims the child, counts 1 → 3, and
 * submits; the human approves. The parent stays held by A throughout: two
 * sessions hold two different tasks at once, and the parent-side aggregation
 * reads the child's live state. Self-skips without DEEPSEEK_API_KEY.
 * @module dsh-task-center-tool-task/tests/delegate-e2e
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

const root = await mkdtemp(join(tmpdir(), 'task-delegate-'))
const ctx = new Context()
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

const aInstruction = [
  '你在参与一个任务委派演示。请严格用任务工具做以下事,然后停止:',
  '1) task_create 建父任务:objective 为「委派演示:父任务负责分解与汇总,子任务负责实际数数」,acceptance 为「子任务数完 1 到 3 且被验收;父任务在其后汇总提交」;',
  '2) task_claim 认领父任务;',
  '3) 再用 task_create 建子任务并挂到父任务下:objective 为「数数子任务:把 1 到 3 逐个数完」,acceptance 为「contextPack 中 1、2、3 每个数恰好一行;提交 note 按顺序列出 1 到 3」,参数 parent_task_id 填父任务的 id;',
  '4) task_update 父任务一次,note 为「已分解出一个数数子任务,等待其完成后汇总」(revision 用工具返回的最新值);',
  '5) 到此为止:不要对父任务 task_report,也不要认领子任务,把子任务留给下一个会话。',
  '只使用任务工具。',
].join('\n')

/** B takes over the delegated child; both ids arrive after A ran. */
const bInstruction = (parentId: string, childId: string): string => [
  '你在参与一个任务委派演示:前一个会话持有一个父任务,并分解出了一个待办子任务。请严格用任务工具:',
  `1) task_query 参数 parent_task_id=${parentId},查看该父任务的子任务(应有一个待办的数数子任务);`,
  `2) task_claim 认领子任务 ${childId}(注意:这是子任务,不是父任务);`,
  '3) 依次 task_update 三次,note 分别为「数到 1」「数到 2」「数到 3」(revision 每次用工具返回的最新值);',
  '4) task_report 以 outcome=review 提交子任务,completion note 按顺序列出 1 到 3。',
  '不要动父任务。只使用任务工具。',
].join('\n')

/** Count the pure counting steps in a pack (see continue.e2e for the shape). */
function countedNumbers(pack: string): Map<number, number> {
  const counts = new Map<number, number>()
  for (const line of pack.split('\n')) {
    const match = /^- \S+ 数到 (\d+)( \(next: .*\))?$/.exec(line)
    if (match === null) continue
    const n = Number(match[1])
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return counts
}

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

suite('real-model subtask delegation', () => {
  it('session A decomposes its held parent, session B completes the child, the parent aggregates', { timeout: 300_000 }, async () => {
    await boot()

    // A: create parent, claim it, link one child under it, note the split, stop.
    const a = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('del-a'), agentOptions: route })
    const aIdle = a.agent.whenIdle()
    a.agent.followup(createUserMessage({ content: [{ type: 'text', text: aInstruction }], source: { kind: 'user' } }))
    await aIdle

    const parent = ctx.tasks.list({}).find(view => view.record.subtasks.length === 1)
    if (parent === undefined) throw new Error('session A did not link a child under the parent')
    expect(parent.record.status).toBe('active')
    expect(parent.record.holder).toBe(a.agent.session.id as never)
    const childId = parent.record.subtasks[0]!
    const child = ctx.tasks.get(childId)!
    expect(child.record.status).toBe('todo')
    expect(child.record.holder).toBeUndefined()

    // B: a stranger to the parent lists its children, claims the child, counts, submits.
    const b = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('del-b'), agentOptions: route })
    const bIdle = b.agent.whenIdle()
    b.agent.followup(createUserMessage({ content: [{ type: 'text', text: bInstruction(parent.record.id, childId) }], source: { kind: 'user' } }))
    await bIdle

    const finished = ctx.tasks.get(childId)!
    expect(finished.record.status).toBe('review')
    expect(finished.record.holder).toBe(b.agent.session.id as never)
    const counts = countedNumbers(finished.record.contextPack)
    for (let n = 1; n <= 3; n++) expect(counts.get(n), `数到 ${n}`).toBe(1)

    // The human approves the child; the parent (still held by A) sees it done.
    const approved = await ctx.tasks.mutate(childId, finished.record.revision, { operation: 'approve' }, { kind: 'human' })
    if ('code' in approved) throw new Error(approved.code)
    expect(ctx.tasks.get(childId)!.record.status).toBe('done')
    const children = ctx.tasks.children(parent.record.id)
    expect(children).toHaveLength(1)
    expect(children[0]!.record.status).toBe('done')
    expect(ctx.tasks.get(parent.record.id)!.record.status).toBe('active')

    console.log('delegation after the live round trip:', JSON.stringify({
      parent: {
        id: parent.record.id,
        status: ctx.tasks.get(parent.record.id)!.record.status,
        holder: ctx.tasks.get(parent.record.id)!.record.holder,
        pack: ctx.tasks.get(parent.record.id)!.record.contextPack,
      },
      child: {
        id: childId,
        status: 'done',
        pack: finished.record.contextPack,
      },
    }, null, 2))
  })
})
