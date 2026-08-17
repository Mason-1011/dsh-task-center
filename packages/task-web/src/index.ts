/**
 * `task-web`: host half of the native web kanban. One Typert Remote service
 * (`task-board/*` endpoints over the web client's /api channel) that exposes
 * the task seam to the browser — board snapshot, task detail, human actions,
 * and creation. Every action runs as the human actor through compare-and-set,
 * exactly like `/task`; domain errors cross the wire as `{ok:false,code}`
 * envelopes instead of throwing.
 * @module @task-center/task-web
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ProjectId, TaskId, effectiveIdle } from '@task-center/task'
import type { TaskMutation, TaskView } from '@task-center/task'
import type { ActResult, BoardPayload, CreateResult, ShowResult, TaskCard } from './wire.ts'

export type * from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    'task-board': TaskBoardService
  }
}

/** Deployment knobs for the kanban host (no hardcoded tunables). */
export interface Config {
  /** Idle days at which the board pins a ⚠ banner over the most-stale open task. Required. */
  readonly staleDays: number
}

/** Actions the board offers, mapped one-to-one onto seam mutations. */
const ACTIONS: Readonly<Record<string, (reason: string) => Exclude<TaskMutation, { operation: 'create' }>>> = {
  approve: () => ({ operation: 'approve' }),
  reject: reason => ({ operation: 'reject', reason }),
  block: reason => ({ operation: 'block', reason: { code: 'human-blocked', message: reason } }),
  release: () => ({ operation: 'release' }),
  abandon: () => ({ operation: 'abandon' }),
}

/**
 * The kanban RPC service. SRC mode: every `@Remote` method uses unique plain
 * identifier parameters (the gateway parses the parameter list from source) and
 * returns JSON-safe values — optional facts are omitted keys, never undefined.
 */
export class TaskBoardService extends TypertRemoteService {
  /** The board is a pure projection over the task seam. */
  static inject = ['tasks']

  constructor(ctx: Context, config: Config) {
    super(ctx, 'task-board')
    if (!Number.isInteger(config.staleDays) || config.staleDays < 1) {
      throw new Error(`task-web config staleDays must be a positive integer of days, got ${String(config.staleDays)}`)
    }
    this.staleDays = config.staleDays
  }

  /** Idle days at which the ⚠ banner appears; validated at construction. */
  private readonly staleDays: number

  /** One task view as one wire card; optional facts are omitted, not nulled. */
  private card(view: TaskView, now: Date): TaskCard {
    const record = view.record
    return {
      id: record.id,
      revision: record.revision,
      objective: record.objective,
      acceptance: record.acceptance,
      status: record.status,
      archived: view.archived,
      idleDays: effectiveIdle(this.ctx.tasks, view, now),
      subtaskCount: record.subtasks.length,
      ...record.holder === undefined ? {} : { holder: record.holder },
      ...record.projectId === undefined ? {} : { projectId: record.projectId },
      ...record.blockedReason === undefined
        ? {}
        : { blockedCode: record.blockedReason.code, blockedMessage: record.blockedReason.message },
      ...record.wakeRule === undefined ? {} : { hasWake: true },
    }
  }

  /**
   * Full board snapshot: projects with live counts, every task (archived
   * included — the client dims them), and the stalest open task once its
   * effective idle crosses {@link TaskBoardService.staleDays}.
   */
  @Remote('board')
  board(): BoardPayload {
    const now = new Date()
    const views = this.ctx.tasks.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })
    const tasks = views.map(view => this.card(view, now))
    const counts = new Map<string, number>()
    for (const view of views) {
      if (view.archived) continue
      const id = view.record.projectId
      if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const projects = this.ctx.tasks.projects().map(view => ({
      id: view.record.id,
      name: view.record.name,
      archived: view.record.archived,
      taskCount: counts.get(view.record.id) ?? 0,
    }))
    let worst: TaskView | undefined
    let worstIdle = -1
    for (const view of views) {
      if (view.archived || view.record.status === 'done') continue
      const idle = effectiveIdle(this.ctx.tasks, view, now)
      if (idle > worstIdle) {
        worstIdle = idle
        worst = view
      }
    }
    return {
      staleDays: this.staleDays,
      now: now.toISOString(),
      projects,
      tasks,
      ...worst !== undefined && worstIdle >= this.staleDays ? { stalest: this.card(worst, now) } : {},
    }
  }

  /**
   * Detail view of one task: its card, owning project name, child rows, and
   * the context-pack tail (last 8 lines).
   */
  @Remote('show')
  show(taskId: string): ShowResult {
    const view = this.ctx.tasks.get(TaskId(taskId))
    if (view === undefined) return { ok: false, code: 'TASK_NOT_FOUND', message: '没有这个任务' }
    const now = new Date()
    const project = view.record.projectId === undefined
      ? undefined
      : this.ctx.tasks.project(view.record.projectId)
    const children = this.ctx.tasks.children(view.record.id).map(child => ({
      id: child.record.id,
      revision: child.record.revision,
      objective: child.record.objective,
      status: child.record.status,
      archived: child.archived,
      idleDays: effectiveIdle(this.ctx.tasks, child, now),
    }))
    const packTail = view.record.contextPack === ''
      ? ''
      : view.record.contextPack.split('\n').slice(-8).join('\n')
    return {
      ok: true,
      task: this.card(view, now),
      ...project === undefined ? {} : { projectName: project.record.name },
      children,
      packTail,
    }
  }

  /**
   * One human action through compare-and-set. `TASK_STALE_REVISION` crosses
   * the wire verbatim — the client answers it by refetching the board.
   */
  @Remote('act')
  async act(taskId: string, expectedRevision: number, action: string, reason: string | undefined): Promise<ActResult> {
    const trimmed = (reason ?? '').trim()
    const build = ACTIONS[action]
    if (build === undefined) {
      return { ok: false, code: 'BOARD_INVALID_ACTION', message: `未知动作 ${String(action)}` }
    }
    if ((action === 'reject' || action === 'block') && trimmed === '') {
      return { ok: false, code: 'TASK_INVALID_REASON', message: `${action === 'reject' ? '打回' : '阻塞'}必须附理由` }
    }
    const result = await this.ctx.tasks.mutate(TaskId(taskId), expectedRevision, build(trimmed), { kind: 'human' })
    if ('code' in result) return { ok: false, code: result.code, message: result.message }
    return { ok: true, revision: result.record.revision, status: result.record.status }
  }

  /**
   * Create one task as the human actor (objective + acceptance, optional
   * project). Empty strings never reach the seam.
   */
  @Remote('create')
  async create(objective: string, acceptance: string, projectId: string | undefined): Promise<CreateResult> {
    const trimmedObjective = (objective ?? '').trim()
    const trimmedAcceptance = (acceptance ?? '').trim()
    if (trimmedObjective === '') return { ok: false, code: 'TASK_INVALID_OBJECTIVE', message: '目标不能为空' }
    if (trimmedAcceptance === '') return { ok: false, code: 'TASK_INVALID_ACCEPTANCE', message: '验收标准不能为空' }
    const created = await this.ctx.tasks.create({
      objective: trimmedObjective,
      acceptance: trimmedAcceptance,
      ...projectId === undefined || projectId === '' ? {} : { projectId: ProjectId(projectId) },
    }, { kind: 'human' })
    if ('code' in created) return { ok: false, code: created.code, message: created.message }
    return { ok: true, id: created.task.record.id, revision: created.task.record.revision }
  }
}

export default TaskBoardService
