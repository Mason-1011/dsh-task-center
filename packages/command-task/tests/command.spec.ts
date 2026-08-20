/**
 * Keyless command tests over the real dsh command registry and the real task
 * seam: the human round trip (create → model work → approve/reject), the panel
 * grouping, prefix resolution, the closed status guards, shelving visibility
 * (idle days, stale banner), and the `command/run`↔`command/done` lifecycle
 * pairing in the dispatching session.
 * @module dsh-task-center-command-task/tests/command
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as llmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from 'dsh-task-center-task'
import type { TaskActor, TaskView } from 'dsh-task-center-task'
import * as CommandTask from '../src/index.ts'

const DAY_MS = 86_400_000

/** Boot the agent spine, the command registry, the seam, and command-task. */
async function boot(staleDays = 3): Promise<{ ctx: Context; fiber: Fiber; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(llmDeepseek, {})
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
  const fiber = await ctx.plugin(CommandTask, { staleDays })
  const agent = ctx.agentLoop.create(SessionId('cmd-panel'), {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  return { ctx, fiber, agent }
}

const signal = new AbortController().signal

/** Dispatch one typed line; commands never reach the model. */
async function dispatch(ctx: Context, agent: Agent, line: string): Promise<CommandExecution> {
  const execution = await ctx.commands.execute(agent, line, [], signal)
  if (execution === undefined) throw new Error(`${line} did not resolve to the task command`)
  return execution
}

/** Success result text, failing loud on an error result. */
function textOf(execution: CommandExecution): string {
  if (execution.result.kind === 'error') throw new Error(`command failed: ${execution.result.text}`)
  return execution.result.text ?? ''
}

const modelSession = Session.create(SessionId('s-model'))
const modelActor: TaskActor = { kind: 'model', sessionId: modelSession.id }

/** Walk one task to review as the model session would: claim, progress, submit. */
async function submitAsModel(ctx: Context, view: TaskView): Promise<TaskView> {
  const claimed = await ctx.tasks.claim(view.record.id, modelSession, modelActor)
  if ('code' in claimed) throw new Error(claimed.code)
  const progressed = await ctx.tasks.mutate(view.record.id, claimed.record.revision, { operation: 'progress', note: 'counted twice' }, modelActor, modelSession)
  if ('code' in progressed) throw new Error(progressed.code)
  const submitted = await ctx.tasks.mutate(view.record.id, progressed.record.revision, { operation: 'submit', completionNote: 'criterion met' }, modelActor, modelSession)
  if ('code' in submitted) throw new Error(submitted.code)
  return submitted
}

describe('command-task', () => {
  it('creates via the human actor and the model claim injects the pack', async () => {
    const { ctx, agent } = await boot()
    const created = await dispatch(ctx, agent, '/task create 统计 hello 次数 :: 给出次数与数法')
    expect(textOf(created)).toContain('已创建')

    const tasks = ctx.tasks.list({})
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.record.status).toBe('todo')
    // The human path writes domain events only: no receipt in any session.
    expect(agent.session.events.filter(event => event.type === 'task/change')).toHaveLength(0)

    await ctx.tasks.claim(tasks[0]!.record.id, modelSession, modelActor)
    expect(modelSession.events.some(event => event.type === 'task/context-injected')).toBe(true)
  })

  it('approves submitted work to done with paired lifecycle events', async () => {
    const { ctx, agent } = await boot()
    await dispatch(ctx, agent, '/task create ship :: it works')
    const submitted = await submitAsModel(ctx, ctx.tasks.list({})[0]!)

    const approved = await dispatch(ctx, agent, `/task approve ${submitted.record.id.slice(0, 8)}`)
    expect(textOf(approved)).toContain('已验收')
    expect(ctx.tasks.list({})[0]!.record.status).toBe('done')

    // The dispatching session carries the paired command lifecycle, args omitted.
    const runs = agent.session.events.filter(event => event.type === 'command/run')
    const dones = agent.session.events.filter(event => event.type === 'command/done')
    expect(runs).toHaveLength(2)
    expect(dones).toHaveLength(2)
    const firstRun = runs[0] as unknown as { commandId: string }
    const firstDone = dones[0] as unknown as { commandId: string }
    expect(firstRun.commandId).toBe(firstDone.commandId)
    expect('args' in runs[0]!).toBe(false)
  })

  it('rejects back to active with the reason folded into the pack', async () => {
    const { ctx, agent } = await boot()
    await dispatch(ctx, agent, '/task create fix :: no regressions')
    const submitted = await submitAsModel(ctx, ctx.tasks.list({})[0]!)

    const rejected = await dispatch(ctx, agent, `/task reject ${submitted.record.id.slice(0, 8)} 数法没有说明边界情况`)
    expect(textOf(rejected)).toContain('已打回')
    const task = ctx.tasks.list({})[0]!
    expect(task.record.status).toBe('active')
    expect(task.record.contextPack).toContain('REJECTED: 数法没有说明边界情况')

    // The model reworks and re-submits; then rejection without a reason fails its guard.
    const resubmitted = await ctx.tasks.mutate(task.record.id, task.record.revision, { operation: 'submit', completionNote: 'reworked, edge cases stated' }, modelActor, modelSession)
    if ('code' in resubmitted) throw new Error(resubmitted.code)
    const noReason = await dispatch(ctx, agent, `/task reject ${submitted.record.id.slice(0, 8)}`)
    expect(noReason.result).toMatchObject({ kind: 'error' })
    expect((noReason.result as { text: string }).text).toContain('理由')
  })

  it('decomposes via create under, shows children, and withdraws on refused links', async () => {
    const { ctx, agent } = await boot()
    await dispatch(ctx, agent, '/task create 发布报告 :: 全部章节就绪')
    const parent = ctx.tasks.list({})[0]!

    const spawned = await dispatch(ctx, agent, `/task create 写第一节 :: 有数据支撑 under ${parent.record.id.slice(0, 8)}`)
    expect(textOf(spawned)).toContain('挂接为')
    const children = ctx.tasks.children(parent.record.id)
    expect(children).toHaveLength(1)
    expect(children[0]!.record.objective).toBe('写第一节')

    const detail = await dispatch(ctx, agent, `/task show ${parent.record.id.slice(0, 8)}`)
    expect(textOf(detail)).toContain('子任务 (1)')
    expect(textOf(detail)).toContain(children[0]!.record.id.slice(0, 8))
    // The panel line counts the link.
    const panel = await dispatch(ctx, agent, '/task')
    expect(textOf(panel)).toContain('⊕1')

    // An unresolvable parent prefix refuses and leaves no orphan task behind.
    const refused = await dispatch(ctx, agent, '/task create 无家可归 :: x :: under zzzz')
    expect(refused.result.kind).toBe('error')
    expect(ctx.tasks.list({ includeArchived: true, limit: 100 }).filter(view => view.record.objective === '无家可归' && !view.archived)).toHaveLength(0)
  })

  it('manages projects and groups the panel by them', async () => {
    const { ctx, agent } = await boot()
    const empty = await dispatch(ctx, agent, '/task project')
    expect(textOf(empty)).toContain('还没有项目')

    const created = await dispatch(ctx, agent, '/task project create 发布季度报告')
    expect(textOf(created)).toContain('已建项目 发布季度报告')
    await dispatch(ctx, agent, '/task project create 日常维护')

    // create … in 归入项目;无项目任务落进收尾分组。
    await dispatch(ctx, agent, '/task create 数据核对 :: 数字全对 in 发布')
    await dispatch(ctx, agent, '/task create 写摘要 :: 三句话 in 日常')
    await dispatch(ctx, agent, '/task create 整理桌面 :: 文件归位')

    const panel = await dispatch(ctx, agent, '/task')
    const text = textOf(panel)
    expect(text).toContain('📅 发布季度报告 (1)')
    expect(text).toContain('📅 日常维护 (1)')
    expect(text).toContain('🗑 无项目 (1)')
    // Projects come before the unassigned bucket.
    expect(text.indexOf('📅 发布季度报告')).toBeLessThan(text.indexOf('🗑 无项目'))

    const listing = await dispatch(ctx, agent, '/task project')
    expect(textOf(listing)).toContain('发布季度报告')
    expect(textOf(listing)).toContain('1 个任务')

    const scoped = await dispatch(ctx, agent, '/task project 日常')
    expect(textOf(scoped)).toContain('写摘要')
    expect(textOf(scoped)).not.toContain('数据核对')

    const detail = await dispatch(ctx, agent, `/task show ${ctx.tasks.list({})[0]!.record.id.slice(0, 8)}`)
    expect(textOf(detail)).toContain('项目: 发布季度报告')

    const renamed = await dispatch(ctx, agent, '/task project rename 日常 家务')
    expect(textOf(renamed)).toContain('已重命名 日常维护 → 家务')
    // Archived projects stop receiving tasks but keep their group readable.
    const archived = await dispatch(ctx, agent, '/task project archive 家务')
    expect(textOf(archived)).toContain('已归档项目 家务')
    const refused = await dispatch(ctx, agent, '/task create 再来一件 :: x in 家务')
    expect(refused.result.kind).toBe('error')
    const stillThere = await dispatch(ctx, agent, '/task')
    expect(textOf(stillThere)).toContain('家务 · 已归档 (1)')
  })

  it('marks idle days, pins the stalest open task, and stays quiet when fresh', async () => {
    const { ctx, agent } = await boot()
    try {
      // Backdate through the fake clock at the commit layer: the ledger's
      // last-touch instants are the only idle input.
      const present = Date.now()
      vi.useFakeTimers()
      vi.setSystemTime(present - 4.5 * DAY_MS)
      await dispatch(ctx, agent, '/task project create 迁移')
      await dispatch(ctx, agent, '/task create 旧账 :: 数字全对 in 迁移')
      await dispatch(ctx, agent, '/task create 长线 :: 全链路通 in 迁移')
      vi.setSystemTime(present - 2.5 * DAY_MS)
      await dispatch(ctx, agent, '/task create 新事 :: 三句话')
      vi.setSystemTime(present)
      const views = ctx.tasks.list({})
      const parent = views.find(view => view.record.objective === '长线')!
      // A fresh child under the four-day-old parent: delegation is activity.
      await dispatch(ctx, agent, `/task create 子活 :: 一步 under ${parent.record.id.slice(0, 8)}`)
      const finished = await submitAsModel(ctx, views.find(view => view.record.objective === '新事')!)
      await dispatch(ctx, agent, `/task approve ${finished.record.id.slice(0, 8)}`)

      const panel = textOf(await dispatch(ctx, agent, '/task'))
      // The stale banner rides above every group; the done task never carries
      // idle, and the parent under live delegation stays unmarked.
      expect(panel).toContain('⚠ 搁置最久(闲置 4 天)')
      expect(panel).toContain('待办: 旧账 · 闲置 4 天')
      expect(panel.indexOf('⚠ 搁置最久')).toBeLessThan(panel.indexOf('📅 迁移'))
      expect(panel).toContain('📅 迁移 (2) · 闲置 4 天')
      expect(panel).not.toContain('长线 · 闲置')
      expect(panel).not.toContain('已完成: 新事 · 闲置')
      // The project listing carries the same per-project idle.
      const listing = textOf(await dispatch(ctx, agent, '/task project'))
      expect(listing).toContain('迁移 [')
      expect(listing).toContain('2 个任务 · 闲置 4 天')

      // Below the banner threshold the ⚠ disappears; a whole idle day still
      // marks the line, sub-day idleness stays silent.
      vi.setSystemTime(present - 2.6 * DAY_MS)
      const fresh = textOf(await dispatch(ctx, agent, '/task'))
      expect(fresh).not.toContain('⚠ 搁置最久')
      expect(fresh).toContain('旧账 · 闲置 1 天')
      expect(fresh).not.toContain('长线 · 闲置')
      expect(fresh).not.toContain('新事 · 闲置')
    } finally {
      vi.useRealTimers()
      await ctx.fiber.dispose()
    }
  })

  it('reads the live holder session as activity: a working holder never shows idle', async () => {
    const { ctx, agent } = await boot()
    try {
      const present = Date.now()
      vi.useFakeTimers()
      vi.setSystemTime(present - 4.5 * DAY_MS)
      await dispatch(ctx, agent, '/task create 在干 :: 一条线')
      await dispatch(ctx, agent, '/task create 死线 :: 另一条线')
      const views = ctx.tasks.list({})
      // One holder live in this process, one that died (never entered here).
      const live = ctx.sessions.create(SessionId('s-live'))
      const worked = views.find(view => view.record.objective === '在干')!
      const claimed = await ctx.tasks.claim(worked.record.id, live, { kind: 'model', sessionId: live.id })
      if ('code' in claimed) throw new Error(claimed.code)
      const deadSession = Session.create(SessionId('s-dead'))
      const dead = views.find(view => view.record.objective === '死线')!
      const deadClaimed = await ctx.tasks.claim(dead.record.id, deadSession, { kind: 'model', sessionId: deadSession.id })
      if ('code' in deadClaimed) throw new Error(deadClaimed.code)
      // Back to the present: the live holder says something an hour ago.
      vi.setSystemTime(present - 3_600_000)
      live.append('user/message', createUserMessage({ content: [{ type: 'text', text: '还在干' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      vi.setSystemTime(present)

      const panel = textOf(await dispatch(ctx, agent, '/task'))
      // The working holder keeps its line fresh; the dead one is 4 days idle
      // and carries the banner — same ledger age, different liveness.
      expect(panel).not.toContain('在干 · 闲置')
      expect(panel).toContain('死线 · 闲置 4 天')
      expect(panel).toContain('⚠ 搁置最久(闲置 4 天)')
      expect(panel).toContain('@s-dead: 死线 · 闲置 4 天')
      expect(panel).toContain('@s-live: 在干\n')

      // The project listing joins the same way.
      await dispatch(ctx, agent, '/task project create 阵地')
      await dispatch(ctx, agent, '/task create 阵地活 :: x in 阵地')
      const held = ctx.tasks.list({}).find(view => view.record.objective === '阵地活')!
      const heldClaimed = await ctx.tasks.claim(held.record.id, live, { kind: 'model', sessionId: live.id })
      if ('code' in heldClaimed) throw new Error(heldClaimed.code)
      const listing = textOf(await dispatch(ctx, agent, '/task project'))
      expect(listing).toContain('阵地 [')
      expect(listing).toContain('1 个任务')
      expect(listing).not.toContain('1 个任务 · 闲置')
    } finally {
      vi.useRealTimers()
      await ctx.fiber.dispose()
    }
  })

  it('fails loud on a non-positive staleDays config', async () => {
    await expect(boot(0)).rejects.toThrow('staleDays')
  })

  it('keeps the stale banner through a patrol: observations never unshelve', async () => {
    const { ctx, agent } = await boot()
    try {
      const present = Date.now()
      vi.useFakeTimers()
      vi.setSystemTime(present - 4.5 * DAY_MS)
      await dispatch(ctx, agent, '/task create 旧账 :: 数字全对')
      vi.setSystemTime(present)
      const view = ctx.tasks.list({}).find(task => task.record.objective === '旧账')!

      // The patrol session is a stranger to the task; its observation lands in
      // the pack but the idle clock keeps running.
      const patrolled = await ctx.tasks.mutate(view.record.id, view.record.revision, {
        operation: 'patrol', note: 'still parked', next: 'restart from the store split',
      }, { kind: 'model', sessionId: SessionId('s-patrol') })
      if ('code' in patrolled) throw new Error(patrolled.code)
      expect(patrolled.record.workedAt).toBe(view.record.workedAt)

      const panel = textOf(await dispatch(ctx, agent, '/task'))
      expect(panel).toContain('⚠ 搁置最久(闲置 4 天)')
      expect(panel).toContain('待办: 旧账 · 闲置 4 天')
      // The observation itself is visible where it belongs: the pack.
      const shown = textOf(await dispatch(ctx, agent, `/task show ${view.record.id.slice(0, 8)}`))
      expect(shown).toContain('PATROL: still parked (next: restart from the store split)')
    } finally {
      vi.useRealTimers()
      await ctx.fiber.dispose()
    }
  })

  it('panels blocked work first and filters by status', async () => {
    const { ctx, agent } = await boot()
    expect(textOf(await dispatch(ctx, agent, '/task'))).toBe('任务队列为空')

    await dispatch(ctx, agent, '/task create one :: a1')
    await dispatch(ctx, agent, '/task create two :: a2')
    const views = ctx.tasks.list({})
    await submitAsModel(ctx, views[0]!)
    const claimed = await ctx.tasks.claim(views[1]!.record.id, modelSession, modelActor)
    if ('code' in claimed) throw new Error(claimed.code)
    const blocked = await ctx.tasks.mutate(views[1]!.record.id, claimed.record.revision, { operation: 'block', reason: { code: 'credential', message: 'missing key' } }, modelActor, modelSession)
    if ('code' in blocked) throw new Error(blocked.code)

    const panel = textOf(await dispatch(ctx, agent, '/task'))
    const blockedAt = panel.indexOf('阻塞 (1)')
    const reviewAt = panel.indexOf('待验收 (1)')
    expect(blockedAt).toBeGreaterThanOrEqual(0)
    expect(reviewAt).toBeGreaterThan(blockedAt)

    expect(textOf(await dispatch(ctx, agent, '/task list review'))).toContain('待验收')
    const bad = await dispatch(ctx, agent, '/task list queued')
    expect(bad.result).toMatchObject({ kind: 'error' })
  })

  it('shows one task by unique prefix and guards the transition', async () => {
    const { ctx, agent } = await boot()
    await dispatch(ctx, agent, '/task create unique :: yes')
    const view = ctx.tasks.list({})[0]!

    const shown = textOf(await dispatch(ctx, agent, `/task show ${view.record.id.slice(0, 6)}`))
    expect(shown).toContain(view.record.id)
    expect(shown).toContain('目标: unique')
    expect(shown).toContain('上下文包')

    const missing = await dispatch(ctx, agent, '/task show deadbeef')
    expect(missing.result).toMatchObject({ kind: 'error' })
    expect((missing.result as { text: string }).text).toContain('没有以 deadbeef 开头的任务')

    const early = await dispatch(ctx, agent, `/task approve ${view.record.id.slice(0, 8)}`)
    expect(early.result).toMatchObject({ kind: 'error' })
    expect((early.result as { text: string }).text).toContain('只有待验收')

    const unknown = await dispatch(ctx, agent, '/task frobnicate')
    expect(unknown.result).toMatchObject({ kind: 'error' })
    expect((unknown.result as { text: string }).text).toContain('未知子命令')
  })

  it('reports an ambiguous prefix instead of picking a candidate', async () => {
    const { ctx, agent } = await boot()
    // Pigeonhole: 100 random uuids over 16 first hex chars guarantee a shared one.
    for (let index = 0; index < 100; index++) {
      await dispatch(ctx, agent, `/task create task-${index} :: a${index}`)
    }
    const counts = new Map<string, number>()
    for (const view of ctx.tasks.list({})) {
      const first = view.record.id.slice(0, 1)
      counts.set(first, (counts.get(first) ?? 0) + 1)
    }
    const shared = [...counts.entries()].find(([, count]) => count >= 2)
    if (shared === undefined) throw new Error('no shared first hex char among 100 uuids')

    const ambiguous = await dispatch(ctx, agent, `/task show ${shared[0]}`)
    expect(ambiguous.result).toMatchObject({ kind: 'error' })
    expect((ambiguous.result as { text: string }).text).toContain('匹配多个任务')
  })

  it('refuses approval of withdrawn (archived) tasks', async () => {
    const { ctx, agent } = await boot()
    const handle = await ctx.tasks.create({ objective: 'gone', acceptance: 'x' }, { kind: 'human' })
    if ('code' in handle) throw new Error(handle.code)
    await handle.dispose()

    const approved = await dispatch(ctx, agent, `/task approve ${handle.task.record.id.slice(0, 8)}`)
    expect(approved.result).toMatchObject({ kind: 'error' })
    expect((approved.result as { text: string }).text).toContain('已归档')
  })

  it('sets and clears wake rules, with seam validation behind the syntax', async () => {
    const { ctx, agent } = await boot()
    await dispatch(ctx, agent, '/task create wake me :: eventually')
    const prefix = ctx.tasks.list({})[0]!.record.id.slice(0, 8)

    const set = await dispatch(ctx, agent, `/task wake ${prefix} every 300`)
    expect(textOf(set)).toContain('每 300 秒')
    let rule = ctx.tasks.list({})[0]!.record.wakeRule
    expect(rule?.kind).toBe('every')

    expect(textOf(await dispatch(ctx, agent, `/task show ${prefix}`))).toContain('定时唤醒: 每 300 秒')

    // The seam rejects a too-frequent interval; the command surfaces the code.
    const tooSmall = await dispatch(ctx, agent, `/task wake ${prefix} every 60`)
    expect(tooSmall.result).toMatchObject({ kind: 'error' })
    expect((tooSmall.result as { text: string }).text).toContain('TASK_WAKE_INVALID_RULE')

    const after = await dispatch(ctx, agent, `/task wake ${prefix} after 300`)
    expect(textOf(after)).toContain('300 秒后')
    rule = ctx.tasks.list({})[0]!.record.wakeRule
    expect(rule).toEqual({ kind: 'after', afterSeconds: 300 })

    const badKind = await dispatch(ctx, agent, `/task wake ${prefix} soon 5`)
    expect(badKind.result).toMatchObject({ kind: 'error' })
    expect((badKind.result as { text: string }).text).toContain('未知唤醒类型')

    const cleared = await dispatch(ctx, agent, `/task nowake ${prefix}`)
    expect(textOf(cleared)).toContain('已取消')
    expect(ctx.tasks.list({})[0]!.record.wakeRule).toBeUndefined()

    const none = await dispatch(ctx, agent, `/task nowake ${prefix}`)
    expect(none.result).toMatchObject({ kind: 'error' })
  })

  it('releases a held task back to todo for a fresh session', async () => {
    const { ctx, agent } = await boot()
    await dispatch(ctx, agent, '/task create stuck :: eventually')
    const view = ctx.tasks.list({})[0]!
    const claimed = await ctx.tasks.claim(view.record.id, modelSession, modelActor)
    if ('code' in claimed) throw new Error(claimed.code)

    const released = await dispatch(ctx, agent, `/task release ${view.record.id.slice(0, 8)}`)
    expect(textOf(released)).toContain('已释放')
    const task = ctx.tasks.list({})[0]!
    expect(task.record.status).toBe('todo')
    expect(task.record.holder).toBeUndefined()

    const none = await dispatch(ctx, agent, `/task release ${view.record.id.slice(0, 8)}`)
    expect(none.result).toMatchObject({ kind: 'error' })
    expect((none.result as { text: string }).text).toContain('没有持有会话')

    // The freed task is claimable again — the cross-session continuation path.
    const reclaimed = await ctx.tasks.claim(view.record.id, Session.create(SessionId('s-fresh')), { kind: 'model', sessionId: SessionId('s-fresh') })
    if ('code' in reclaimed) throw new Error(reclaimed.code)
    expect(reclaimed.record.status).toBe('active')
  })

  it('disposes its registration with the plugin fiber', async () => {
    const { ctx, fiber, agent } = await boot()
    expect(ctx.commands.find(agent, 'task')).toBeDefined()
    await fiber.dispose()
    expect(ctx.commands.find(agent, 'task')).toBeUndefined()
  })

  it('manages candidates: list, promote with acceptance, ignore stays terminal', async () => {
    const { ctx, agent } = await boot()
    const empty = await dispatch(ctx, agent, '/task candidates')
    expect(textOf(empty)).toContain('还没有候选')

    // The extractor births a candidate (source actor), as task-source will.
    const born = await ctx.tasks.candidateCreate({
      objective: '支持暗色模式',
      note: 'goal 未完结,blocker: 颜色令牌未定',
      origin: { sessionId: SessionId('s-goal'), tier: 'goal', key: 'g-1' },
    }, { kind: 'source' })
    if ('code' in born) throw new Error(born.code)
    await ctx.tasks.candidateCreate({
      objective: '首屏优化',
      origin: { sessionId: SessionId('s-goal'), tier: 'goal', key: 'g-2' },
    }, { kind: 'source' })

    const listed = await dispatch(ctx, agent, '/task candidates')
    expect(textOf(listed)).toContain('2 条待确认')
    expect(textOf(listed)).toContain('支持暗色模式')
    expect(textOf(listed)).toContain('来源 goal · 会话 s-goal')

    // Missing acceptance refuses; humans write what the extractor cannot.
    const bare = await dispatch(ctx, agent, `/task promote ${born.record.id.slice(0, 8)}`)
    expect(bare.result).toMatchObject({ kind: 'error' })

    const promoted = await dispatch(ctx, agent, `/task promote ${born.record.id.slice(0, 8)} 切换后全部界面生效`)
    expect(textOf(promoted)).toContain('已晋升为任务')
    const task = ctx.tasks.list({})[0]!
    expect(task.record.objective).toBe('支持暗色模式')
    expect(task.record.acceptance).toBe('切换后全部界面生效')
    const promotedOrigin = task.record.origin
    expect(promotedOrigin !== undefined && 'candidateId' in promotedOrigin && promotedOrigin.candidateId === born.record.id).toBe(true)

    const again = await dispatch(ctx, agent, `/task promote ${born.record.id.slice(0, 8)} :: 再来一次`)
    expect(again.result).toMatchObject({ kind: 'error' })

    const second = ctx.tasks.candidates().find(view => view.record.origin.key === 'g-2')!
    const ignored = await dispatch(ctx, agent, `/task ignore ${second.record.id.slice(0, 8)}`)
    expect(textOf(ignored)).toContain('已忽略')
    expect(ctx.tasks.candidates().find(view => view.record.origin.key === 'g-2')!.record.status).toBe('ignored')
  })
})
