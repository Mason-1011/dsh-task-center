/**
 * Real-model cross-session continuation (e2e): session A creates the relay
 * counting task, claims it, and counts to 3 — then its handle is disposed
 * mid-hold and task-reaper releases the dead hold. Session B claims the freed
 * task, reads the injected context pack, and continues 4 → 10 without
 * repeating A's numbers, submitting for review; the human closes to done.
 * Every number appearing exactly once in the pack is the proof that B
 * continued A's work rather than redoing it. Self-skips without
 * DEEPSEEK_API_KEY, matching the harness e2e key policy.
 * @module @task-center/tool-task/tests/continue-e2e
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
import { TaskService } from '@task-center/task'
import * as TaskLocal from '@task-center/task-local'
import * as TaskReaper from '@task-center/task-reaper'
import * as ToolTask from '../src/index.ts'

const root = await mkdtemp(join(tmpdir(), 'task-continue-'))
const ctx = new Context()
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

const aInstruction = [
  '你在参与一个跨会话接力演示。请严格用任务工具做以下事,然后停止:',
  '1) task_create:objective 为「接力数数:把 1 到 10 逐个数完,每数一个数记一行进度」,acceptance 为「contextPack 中 1 到 10 每个数恰好出现一行;提交 note 按顺序列出 1 到 10」;',
  '2) task_claim 认领该任务;',
  '3) 依次 task_update 三次,note 分别为「数到 1」「数到 2」「数到 3」(revision 每次用工具返回的最新值);',
  '4) 到此为止:不要 task_report,也不要继续数。你这个会话马上会被终止,进度留在任务里即可。',
  '只使用任务工具。',
].join('\n')

/** B continues from A's stopping point; the id arrives after A ran. */
const bInstruction = (taskId: string): string => [
  '你在参与一个跨会话接力演示。上一个会话认领了任务后数到 3 就被终止了,任务已回到待办。请严格用任务工具:',
  `1) task_claim 认领任务 ${taskId}(认领会注入上下文包,其中已有「数到 1」「数到 2」「数到 3」三行);`,
  '2) 不要重复已数的数:从 4 开始,依次 task_update,note 为「数到 4」「数到 5」……直到「数到 10」(revision 每次用工具返回的最新值);',
  '3) task_report 以 outcome=review 提交,completion note 按顺序列出 1 到 10,并注明 1 到 3 沿自上一个会话的进度、4 到 10 由你完成。',
  '只使用任务工具。',
].join('\n')

/**
 * Count the progress lines whose note is exactly 「数到 N」 (a pure counting
 * step). Continuation means each number has exactly one pure step; a session
 * may still mention earlier numbers in commentary, which proves it read the
 * pack but must not count as a redo.
 */
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
    await ctx.plugin(TaskReaper),
  ]
  void fibers
}

const suite = process.env.DEEPSEEK_API_KEY === undefined ? describe.skip : describe

suite('real-model cross-session continuation', () => {
  it('session A counts to 3, dies mid-hold, and session B continues 4 → 10 to review', { timeout: 300_000 }, async () => {
    await boot()

    // A: create, claim, count to 3, stop without submitting.
    const a = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('cont-a'), agentOptions: route })
    const aIdle = a.agent.whenIdle()
    a.agent.followup(createUserMessage({ content: [{ type: 'text', text: aInstruction }], source: { kind: 'user' } }))
    await aIdle

    let task = ctx.tasks.list({})[0]
    if (task === undefined) throw new Error('session A did not create the task')
    expect(task.record.status).toBe('active')
    expect(task.record.holder).toBe(a.agent.session.id as never)
    const aRevision = task.record.revision

    // A dies mid-hold; the reaper releases the dead hold back to todo.
    await a.dispose()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && ctx.tasks.get(task.record.id)?.record.status !== 'todo') {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    task = ctx.tasks.get(task.record.id)!
    expect(task.record.status).toBe('todo')
    expect(task.record.holder).toBeUndefined()
    expect([...countedNumbers(task.record.contextPack).keys()].sort((x, y) => x - y)).toEqual([1, 2, 3])

    // B: a fresh session continues from the pack, without repeating A's numbers.
    const b = await ctx.agentLoop.createAgent(ctx, { sessionId: SessionId('cont-b'), agentOptions: route })
    const bIdle = b.agent.whenIdle()
    b.agent.followup(createUserMessage({ content: [{ type: 'text', text: bInstruction(task.record.id) }], source: { kind: 'user' } }))
    await bIdle

    expect(b.agent.session.events.some(event => event.type === 'task/context-injected')).toBe(true)
    task = ctx.tasks.list({})[0]!
    expect(task.record.status).toBe('review')
    expect(task.record.revision).toBeGreaterThan(aRevision)

    // Continuation, not a redo: every number counted exactly once across both sessions.
    const counts = countedNumbers(task.record.contextPack)
    for (let n = 1; n <= 10; n++) expect(counts.get(n), `数到 ${n}`).toBe(1)

    // The human actor closes the relay.
    const approved = await ctx.tasks.mutate(task.record.id, task.record.revision, { operation: 'approve' }, { kind: 'human' })
    if ('code' in approved) throw new Error(approved.code)
    task = ctx.tasks.get(task.record.id)!
    expect(task.record.status).toBe('done')
    expect(task.record.holder).toBeUndefined()

    console.log('relay task after the live continuation:', JSON.stringify({
      id: task.record.id,
      status: task.record.status,
      revision: task.record.revision,
      contextPack: task.record.contextPack,
    }, null, 2))
  })
})
