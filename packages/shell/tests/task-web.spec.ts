/**
 * Web-board host contract over the real Loader composition (tests/boot.ts +
 * task-web.cordis.yml): the `task-board` RPC service's payload shapes,
 * subtree-aware idle semantics, the human action round trips through
 * compare-and-set, error-code passthrough, and — before any client exists —
 * the SRC signature layer the api-gateway parses from method source
 * (unique plain identifiers, JSON-safe results with omitted optional keys).
 * @module dsh-task-center-shell/tests/task-web
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TaskId } from 'dsh-task-center-task'
import type { TaskActor, TaskView } from 'dsh-task-center-task'
import type { BoardPayload } from 'dsh-task-center-task-web'
import { bootComposition } from './boot.ts'

const DAY_MS = 86_400_000
const yml = resolve(dirname(fileURLToPath(import.meta.url)), 'task-web.cordis.yml')

const modelSession = Session.create(SessionId('s-model'))
const modelActor: TaskActor = { kind: 'model', sessionId: modelSession.id }

/** Walk one task to review as the model session would: claim, progress, submit. */
async function submitAsModel(ctx: Context, view: TaskView): Promise<TaskView> {
  const claimed = await ctx.tasks.claim(view.record.id, modelSession, modelActor)
  if ('code' in claimed) throw new Error(claimed.code)
  const progressed = await ctx.tasks.mutate(view.record.id, claimed.record.revision, { operation: 'progress', note: 'halfway' }, modelActor, modelSession)
  if ('code' in progressed) throw new Error(progressed.code)
  const submitted = await ctx.tasks.mutate(view.record.id, progressed.record.revision, { operation: 'submit', completionNote: 'criterion met' }, modelActor, modelSession)
  if ('code' in submitted) throw new Error(submitted.code)
  return submitted
}

/** Fail loud on any `undefined` anywhere in a wire payload (the gateway rejects it). */
function assertNoUndefined(node: unknown, path = '$'): void {
  if (node === undefined) throw new Error(`undefined at ${path}`)
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`))
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) assertNoUndefined(value, `${path}.${key}`)
  }
}

let root: string
let ctx: Context

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'task-web-'))
  ctx = await bootComposition(root, yml)
})

afterAll(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('task-web host', () => {
  it('exposes the task-board SRC surface: namespace, methods, plain-identifier signatures', () => {
    const board = ctx['task-board']
    expect(board).toBeDefined()
    expect(board.typertRemote.namespace).toBe('task-board')
    const markers = remoteMethods(board)
    expect(markers.map(marker => marker.method).sort()).toEqual(['act', 'board', 'create', 'ignore', 'promote', 'sessions', 'show'])
    for (const marker of markers) {
      expect(marker.invocation).toEqual({ kind: 'direct' })
      expect(marker.exportName).toBeUndefined()
    }
    // The api-gateway derives wire fields from the method source: parameters
    // must be unique plain identifiers (no destructuring, defaults, rest).
    // Mirror its parse locally so a signature slip fails here, not in the browser.
    for (const marker of markers) {
      const implementation = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(board), marker.method)?.value
      if (typeof implementation !== 'function') throw new Error(`no prototype method ${marker.method}`)
      const source = Function.prototype.toString.call(implementation as () => void)
      const open = source.indexOf('(')
      const close = source.indexOf(')', open + 1)
      const body = source.slice(open + 1, close).trim()
      const names = new Set<string>()
      for (const part of body.length === 0 ? [] : body.split(',').map(part => part.trim())) {
        expect(part, `${marker.method} parameter of ${source}`).toMatch(/^[$A-Z_a-z][$\w]*$/u)
        expect(names.has(part), `${marker.method} repeats parameter ${part}`).toBe(false)
        names.add(part)
      }
    }
  })

  it('snapshots the board with omitted optional keys and no stale banner when fresh', async () => {
    const handle = await ctx.tasks.create({ objective: '第一件', acceptance: '有验收' }, { kind: 'human' })
    if ('code' in handle) throw new Error(handle.code)

    const payload: BoardPayload = ctx['task-board'].board()
    assertNoUndefined(payload)
    expect(payload.staleDays).toBe(3)
    expect(Number.isNaN(Date.parse(payload.now))).toBe(false)
    expect(payload.tasks).toHaveLength(1)
    const card = payload.tasks[0]!
    expect(card).toMatchObject({ objective: '第一件', status: 'todo', archived: false, subtaskCount: 0 })
    // Optional facts are omitted keys, not null/undefined.
    expect(Object.keys(card).includes('holder')).toBe(false)
    expect(Object.keys(card).includes('projectId')).toBe(false)
    expect('stalest' in payload).toBe(false)
  })

  it('folds subtree-aware idle: 4.5 days floored to 4, a fresh child unshelves the parent', async () => {
    try {
      const present = Date.now()
      vi.useFakeTimers()
      vi.setSystemTime(present - 4.5 * DAY_MS)
      const stale = await ctx.tasks.create({ objective: '旧账', acceptance: '数字全对' }, { kind: 'human' })
      if ('code' in stale) throw new Error(stale.code)
      const parent = await ctx.tasks.create({ objective: '长线', acceptance: '全链路通' }, { kind: 'human' })
      if ('code' in parent) throw new Error(parent.code)
      vi.setSystemTime(present)
      // The child lands now: under live delegation the parent is not shelved.
      const child = await ctx.tasks.create({ objective: '子活', acceptance: '一步' }, { kind: 'human' })
      if ('code' in child) throw new Error(child.code)
      const linked = await ctx.tasks.mutate(parent.task.record.id, parent.task.record.revision, { operation: 'subtask-add', childId: child.task.record.id }, { kind: 'human' })
      if ('code' in linked) throw new Error(linked.code)

      const payload = ctx['task-board'].board()
      assertNoUndefined(payload)
      const cards = new Map(payload.tasks.map(card => [card.objective, card]))
      expect(cards.get('旧账')!.idleDays).toBe(4)
      expect(cards.get('长线')!.idleDays).toBe(0)
      // The banner pins the stalest open task once it crosses staleDays.
      expect(payload.stalest?.objective).toBe('旧账')
      expect(payload.stalest?.idleDays).toBe(4)
      // The linked parent counts its child on the wire.
      expect(cards.get('长线')!.subtaskCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('approves submitted work through act, bumping the revision to done', async () => {
    const handle = await ctx.tasks.create({ objective: '交付', acceptance: '跑通' }, { kind: 'human' })
    if ('code' in handle) throw new Error(handle.code)
    const submitted = await submitAsModel(ctx, handle.task)

    const approved = await ctx['task-board'].act(submitted.record.id, submitted.record.revision, 'approve', undefined)
    expect(approved).toEqual({ ok: true, revision: submitted.record.revision + 1, status: 'done' })
    const done = ctx.tasks.get(submitted.record.id)
    expect(done?.record.status).toBe('done')
    assertNoUndefined(approved)
  })

  it('carries an acceptance birth onto the board and back to the claimable backlog on reject', async () => {
    const born = await ctx.tasks.acceptanceCreate({
      objective: '贪吃蛇做好了',
      completionNote: '目标已在来源会话标记完成,其后无人回应',
      sessionId: SessionId('s-board-done'),
      goalId: 'g-1',
    }, { kind: 'source' })
    if ('code' in born) throw new Error(born.code)

    const payload: BoardPayload = ctx['task-board'].board()
    assertNoUndefined(payload)
    expect(payload.tasks.find(task => task.id === born.record.id)).toMatchObject({ objective: '贪吃蛇做好了', status: 'review' })

    const rejected = await ctx['task-board'].act(born.record.id, born.record.revision, 'reject', '样式不对')
    expect(rejected).toMatchObject({ ok: true, status: 'todo' })
    assertNoUndefined(rejected)
  })

  it('surfaces compare-and-set races as TASK_STALE_REVISION instead of throwing', async () => {
    const handle = await ctx.tasks.create({ objective: '竞态', acceptance: 'x' }, { kind: 'human' })
    if ('code' in handle) throw new Error(handle.code)
    const submitted = await submitAsModel(ctx, handle.task)

    const stale = await ctx['task-board'].act(submitted.record.id, submitted.record.revision - 1, 'approve', undefined)
    expect(stale).toEqual({ ok: false, code: 'TASK_STALE_REVISION', message: expect.any(String) })
    // The seam never moved: the honest revision still applies.
    const retried = await ctx['task-board'].act(submitted.record.id, submitted.record.revision, 'approve', undefined)
    expect(retried).toMatchObject({ ok: true, status: 'done' })
  })

  it('guards reasons, actions, and creation inputs with stable codes', async () => {
    const handle = await ctx.tasks.create({ objective: '守卫', acceptance: 'x' }, { kind: 'human' })
    if ('code' in handle) throw new Error(handle.code)
    const submitted = await submitAsModel(ctx, handle.task)

    const noReason = await ctx['task-board'].act(submitted.record.id, submitted.record.revision, 'reject', '   ')
    expect(noReason).toMatchObject({ ok: false, code: 'TASK_INVALID_REASON' })
    const blankReason = await ctx['task-board'].act(submitted.record.id, submitted.record.revision, 'block', undefined)
    expect(blankReason).toMatchObject({ ok: false, code: 'TASK_INVALID_REASON' })
    const unknown = await ctx['task-board'].act(submitted.record.id, submitted.record.revision, 'frobnicate', undefined)
    expect(unknown).toMatchObject({ ok: false, code: 'BOARD_INVALID_ACTION' })

    const emptyObjective = await ctx['task-board'].create('  ', '验收', undefined)
    expect(emptyObjective).toMatchObject({ ok: false, code: 'TASK_INVALID_OBJECTIVE' })
    const emptyAcceptance = await ctx['task-board'].create('目标', '', undefined)
    expect(emptyAcceptance).toMatchObject({ ok: false, code: 'TASK_INVALID_ACCEPTANCE' })
    const ghostProject = await ctx['task-board'].create('目标', '验收', '00000000-0000-0000-0000-000000000000')
    expect(ghostProject).toMatchObject({ ok: false, code: 'PROJECT_NOT_FOUND' })
  })

  it('releases held work back to todo and abandons cold work, both through act', async () => {
    const held = await ctx.tasks.create({ objective: '卡住', acceptance: 'x' }, { kind: 'human' })
    if ('code' in held) throw new Error(held.code)
    const claimed = await ctx.tasks.claim(held.task.record.id, modelSession, modelActor)
    if ('code' in claimed) throw new Error(claimed.code)
    const released = await ctx['task-board'].act(held.task.record.id, claimed.record.revision, 'release', undefined)
    expect(released).toMatchObject({ ok: true, status: 'todo' })
    expect(ctx.tasks.get(held.task.record.id)?.record.holder).toBeUndefined()

    const cold = await ctx.tasks.create({ objective: '放弃我', acceptance: 'x' }, { kind: 'human' })
    if ('code' in cold) throw new Error(cold.code)
    const abandoned = await ctx['task-board'].act(cold.task.record.id, cold.task.record.revision, 'abandon', undefined)
    expect(abandoned).toMatchObject({ ok: true, status: 'todo' })
    expect(ctx.tasks.get(cold.task.record.id)?.archived).toBe(true)
  })

  it('blocks active work with a human reason folded from the typed text', async () => {
    const handle = await ctx.tasks.create({ objective: '需阻塞', acceptance: 'x' }, { kind: 'human' })
    if ('code' in handle) throw new Error(handle.code)
    const claimed = await ctx.tasks.claim(handle.task.record.id, modelSession, modelActor)
    if ('code' in claimed) throw new Error(claimed.code)

    const blocked = await ctx['task-board'].act(handle.task.record.id, claimed.record.revision, 'block', '等外部凭据')
    expect(blocked).toMatchObject({ ok: true, status: 'blocked' })
    const view = ctx.tasks.get(handle.task.record.id)
    expect(view?.record.blockedReason).toEqual({ code: 'human-blocked', message: '等外部凭据' })
    // The blocked reason crosses the board snapshot as omitted-when-absent keys.
    const payload = ctx['task-board'].board()
    const card = payload.tasks.find(task => task.id === handle.task.record.id)
    expect(card).toMatchObject({ blockedCode: 'human-blocked', blockedMessage: '等外部凭据' })
  })

  it('carries an armed wake rule onto the card as label + next time, omitted when none', async () => {
    const handle = await ctx.tasks.create({ objective: '定时件', acceptance: 'x' }, { kind: 'human' })
    if ('code' in handle) throw new Error(handle.code)
    // No rule armed: the wake key stays absent.
    expect(ctx['task-board'].board().tasks.find(task => task.id === handle.task.record.id)?.wake).toBeUndefined()

    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString()
    const armed = await ctx.tasks.mutate(
      handle.task.record.id, handle.task.record.revision,
      { operation: 'wake-set', rule: { kind: 'at', scheduledAt } }, { kind: 'human' },
    )
    if ('code' in armed) throw new Error(armed.code)
    assertNoUndefined(armed)
    const card = ctx['task-board'].board().tasks.find(task => task.id === handle.task.record.id)
    expect(card?.wake).toEqual({ label: `定点 ${scheduledAt}`, nextAt: scheduledAt })
  })

  it('shows detail: children rows, project name, and the context-pack tail capped at 8 lines', async () => {
    const project = await ctx.tasks.projectCreate('看板项目', { kind: 'human' })
    if ('code' in project) throw new Error(project.code)
    const parentHandle = await ctx.tasks.create({ objective: '父任务', acceptance: 'x', projectId: project.project.record.id }, { kind: 'human' })
    if ('code' in parentHandle) throw new Error(parentHandle.code)
    const childHandle = await ctx.tasks.create({ objective: '子任务', acceptance: 'y' }, { kind: 'human' })
    if ('code' in childHandle) throw new Error(childHandle.code)
    const linked = await ctx.tasks.mutate(parentHandle.task.record.id, parentHandle.task.record.revision, { operation: 'subtask-add', childId: childHandle.task.record.id }, { kind: 'human' })
    if ('code' in linked) throw new Error(linked.code)

    // Fill the pack past the tail cap: claim, then ten progress notes.
    const claimed = await ctx.tasks.claim(parentHandle.task.record.id, modelSession, modelActor)
    if ('code' in claimed) throw new Error(claimed.code)
    let revision = claimed.record.revision
    for (let index = 1; index <= 10; index++) {
      const moved = await ctx.tasks.mutate(parentHandle.task.record.id, revision, { operation: 'progress', note: `第 ${index} 步` }, modelActor, modelSession)
      if ('code' in moved) throw new Error(moved.code)
      revision = moved.record.revision
    }

    const shown = ctx['task-board'].show(parentHandle.task.record.id)
    assertNoUndefined(shown)
    expect(shown.ok).toBe(true)
    if (!shown.ok) throw new Error(shown.code)
    expect(shown.projectName).toBe('看板项目')
    expect(shown.children).toHaveLength(1)
    expect(shown.children[0]).toMatchObject({ objective: '子任务', status: 'todo' })
    const tail = shown.packTail.split('\n')
    expect(tail).toHaveLength(8)
    expect(tail[tail.length - 1]).toContain('第 10 步')
    expect(shown.packTail).not.toContain('第 2 步\n')

    const missing = ctx['task-board'].show('ffffffff-ffff-ffff-ffff-ffffffffffff')
    expect(missing).toMatchObject({ ok: false, code: 'TASK_NOT_FOUND' })
  })

  it('creates tasks with and without a project, returning the new identity', async () => {
    const project = await ctx.tasks.projectCreate('建单项目', { kind: 'human' })
    if ('code' in project) throw new Error(project.code)
    const created = await ctx['task-board'].create('看板建的单', '一次通过', project.project.record.id)
    expect(created).toMatchObject({ ok: true })
    if (!created.ok) throw new Error(created.code)
    const view = ctx.tasks.get(TaskId(created.id))
    expect(view?.record.objective).toBe('看板建的单')
    expect(view?.record.projectId).toBe(project.project.record.id)

    const loose = await ctx['task-board'].create('无项目单', '自由生长', undefined)
    expect(loose).toMatchObject({ ok: true })
    if (!loose.ok) throw new Error(loose.code)
    const looseView = ctx.tasks.get(TaskId(loose.id))
    expect(looseView?.record.projectId).toBeUndefined()
  })

  it('counts live tasks per project chip and flags archived projects', async () => {
    const project = await ctx.tasks.projectCreate('计数项目', { kind: 'human' })
    if ('code' in project) throw new Error(project.code)
    await ctx.tasks.create({ objective: '计数一', acceptance: 'x', projectId: project.project.record.id }, { kind: 'human' })
    await ctx.tasks.create({ objective: '计数二', acceptance: 'x', projectId: project.project.record.id }, { kind: 'human' })

    const payload = ctx['task-board'].board()
    const chip = payload.projects.find(entry => entry.name === '计数项目')
    expect(chip).toMatchObject({ archived: false, taskCount: 2 })

    const archived = await ctx.tasks.projectMutate(project.project.record.id, project.project.record.revision, { operation: 'project-archive' }, { kind: 'human' })
    if ('code' in archived) throw new Error(archived.code)
    // Archiving the project keeps its tasks live and countable; only the flag flips.
    const after = ctx['task-board'].board().projects.find(entry => entry.name === '计数项目')
    expect(after).toMatchObject({ archived: true, taskCount: 2 })
  })

  it('columns pending candidates oldest-first and only pending', async () => {
    const born = await ctx.tasks.candidateCreate({
      objective: '候选甲',
      note: 'goal 阻塞中(token): 颜色令牌未定',
      origin: { sessionId: SessionId('s-board-1'), tier: 'goal', key: 'g-a' },
    }, { kind: 'source' })
    if ('code' in born) throw new Error(born.code)
    const second = await ctx.tasks.candidateCreate({
      objective: '候选乙',
      origin: { sessionId: SessionId('s-board-2'), tier: 'goal', key: 'g-b' },
    }, { kind: 'source' })
    if ('code' in second) throw new Error(second.code)
    const ignored = await ctx.tasks.candidateIgnore(second.record.id, second.record.revision, { kind: 'human' })
    if ('code' in ignored) throw new Error(ignored.code)

    const payload: BoardPayload = ctx['task-board'].board()
    assertNoUndefined(payload)
    // The column shows the pending inbox only; the ignored verdict leaves it.
    expect(payload.candidates.map(card => card.objective)).toEqual(['候选甲'])
    const card = payload.candidates[0]!
    expect(card).toMatchObject({
      status: 'pending', note: 'goal 阻塞中(token): 颜色令牌未定',
      tier: 'goal', sessionId: 's-board-1',
    })
  })

  it('promotes with the human-written acceptance and ignores terminally, both over RPC', async () => {
    const born = await ctx.tasks.candidateCreate({
      objective: '支持暗色模式',
      note: 'goal 未完结',
      origin: { sessionId: SessionId('s-board-3'), tier: 'goal', key: 'g-c' },
    }, { kind: 'source' })
    if ('code' in born) throw new Error(born.code)

    // The acceptance is the human's half of the contract; empty never lands.
    const bare = await ctx['task-board'].promote(born.record.id, born.record.revision, '  ', undefined)
    expect(bare).toMatchObject({ ok: false, code: 'CANDIDATE_INVALID_ACCEPTANCE' })

    const promoted = await ctx['task-board'].promote(
      born.record.id, born.record.revision, '切换后全部界面生效', '完整暗色支持',
    )
    assertNoUndefined(promoted)
    expect(promoted).toMatchObject({ ok: true })
    if (!promoted.ok) throw new Error(promoted.code)
    const task = ctx.tasks.get(TaskId(promoted.taskId))
    expect(task?.record).toMatchObject({ objective: '完整暗色支持', acceptance: '切换后全部界面生效' })
    const promotedOrigin = task?.record.origin
    expect(promotedOrigin !== undefined && 'candidateId' in promotedOrigin && promotedOrigin.candidateId === born.record.id).toBe(true)
    // Promoted work leaves the 待确认 column.
    expect(ctx['task-board'].board().candidates.find(card => card.id === born.record.id)).toBeUndefined()
    // A stale revision surfaces the compare-and-set code, like act.
    const stale = await ctx['task-board'].promote(born.record.id, born.record.revision, '再来', undefined)
    expect(stale).toMatchObject({ ok: false, code: 'TASK_STALE_REVISION' })

    const other = await ctx.tasks.candidateCreate({
      objective: '首屏优化',
      origin: { sessionId: SessionId('s-board-4'), tier: 'goal', key: 'g-d' },
    }, { kind: 'source' })
    if ('code' in other) throw new Error(other.code)
    const ignored = await ctx['task-board'].ignore(other.record.id, other.record.revision)
    assertNoUndefined(ignored)
    expect(ignored).toEqual({ ok: true })
    expect(ctx['task-board'].board().candidates.find(card => card.id === other.record.id)).toBeUndefined()
  })
})
