/**
 * `command-task`: the human face of the task seam — one `/task` slash command
 * with panel / detail / create / approve / reject subcommands. Handlers run as
 * the human actor: approve and reject are legal only here, and the human path
 * writes domain events only (no session receipts), per the authority matrix.
 * Spec: docs/design/03-plugins.md (command-task), 05-seam-spec.md §1.
 * @module @task-center/command-task
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import { effectiveIdle, lastSessionActivity } from '@task-center/task'
import type { CandidateView, HolderActivity, ProjectView, TaskError, TaskId, TaskStatus, TaskView, WakeRule } from '@task-center/task'

/** Cordis plugin name. */
export const name = 'command-task'

/** The task seam, the command registry, and the session store must be present. */
export const inject = ['tasks', 'sessions', 'commands']

// Re-exported for existing importers; the implementation moved to the seam.
export { idleDays } from '@task-center/task'

/** Deployment knobs for the human face (no hardcoded tunables). */
export interface Config {
  /** Idle days at which the panel pins a ⚠ banner over the most-stale open task. Required. */
  readonly staleDays: number
}

const USAGE = [
  '用法:',
  '  /task                        — 全景面板:按项目分组,组内阻塞置顶;未完结任务标闲置天数,最久搁置置顶标 ⚠',
  '  /task list <status>          — 按状态过滤(todo|active|blocked|review|done)',
  '  /task show <id前缀>          — 单任务详情,含子任务与上下文包尾部',
  '  /task create <objective> :: <acceptance> [under <id前缀>] [in <项目名或前缀>]',
  '                               — 人类建任务,交给会话认领;under 指定父任务即分解,in 归入项目',
  '  /task project                — 项目列表(含计数)',
  '  /task project create <名>    — 建项目',
  '  /task project rename <名或前缀> <新名>',
  '  /task project archive <名或前缀> — 归档项目(已有任务保留可读,不再接收新任务)',
  '  /task project <名或前缀>     — 该项目的任务面板',
  '  /task wake <id前缀> after <秒> | at <ISO时刻> | every <秒>',
  '                               — 定时唤醒:到点起新会话做该任务',
  '  /task nowake <id前缀>        — 取消定时唤醒',
  '  /task release <id前缀>       — 释放持有(在办/阻塞 → 待办),死会话卡住时人工接管用',
  '  /task candidates             — 待确认候选:从闲置会话的 goal/计划/todo 自动抽取的未完任务',
  '  /task promote <候选前缀> [新目标 ::] <验收标准>',
  '                               — 候选晋升为任务;验收必填,:: 前段可覆写目标',
  '  /task ignore <候选前缀>      — 忽略候选(终态,同来源不再提示)',
  '  /task approve <id前缀>       — 验收通过(review → done)',
  '  /task reject <id前缀> <理由> — 打回(review → active),理由必填',
].join('\n')

/** Panel group order: blocked work is what needs a human eye first. */
const PANEL_ORDER: readonly TaskStatus[] = ['blocked', 'review', 'active', 'todo', 'done']

const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  todo: '待办',
  active: '在办',
  blocked: '阻塞',
  review: '待验收',
  done: '已完成',
}

const encoder = new TextEncoder()

/** Only unfinished work can be shelved: done and archived tasks are not idle. */
function isOpen(view: TaskView): boolean {
  return !view.archived && view.record.status !== 'done'
}

/** Idle suffix from precomputed effective idle, shown once it crosses a whole day. */
function idleSuffix(view: TaskView, days: number): string {
  return !isOpen(view) || days < 1 ? '' : ` · 闲置 ${days} 天`
}

/** One line of the panel for one task view. */
function lineOf(view: TaskView, idle: number): string {
  const holder = view.record.holder === undefined ? '' : ` @${view.record.holder}`
  const pack = view.record.contextPack === '' ? '' : ` · pack ${encoder.encode(view.record.contextPack).length}B`
  const wake = view.record.wakeRule === undefined ? '' : ' · ⏰'
  const spawn = view.record.subtasks.length === 0 ? '' : ` · ⊕${view.record.subtasks.length}`
  return `- [${view.record.id.slice(0, 8)}] r${view.record.revision} ${STATUS_LABEL[view.record.status]}${holder}: ${view.record.objective}${idleSuffix(view, idle)}${pack}${wake}${spawn}`
}

/**
 * Live holder-session activity for the display idle join: a holder session at
 * work keeps its task line alive with zero ledger writes; sessions not live
 * in this process fall back to the ledger's `workedAt`.
 */
function holderActivityOf(ctx: Context): HolderActivity {
  return sessionId => {
    const session = ctx.sessions.get(sessionId)
    return session === undefined ? undefined : lastSessionActivity(session.events)
  }
}

/** Every live or archived task, so prefix matching never misses over the cap. */
function allTasks(ctx: Context): TaskView[] {
  return ctx.tasks.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })
}

/** Resolve one project by name or id prefix; ambiguity lists candidates. */
function resolveProject(ctx: Context, key: string): { view: ProjectView } | { error: string } {
  const matches = ctx.tasks.projects().filter(view =>
    view.record.id.startsWith(key) || view.record.name.startsWith(key))
  if (matches.length === 1) return { view: matches[0]! }
  if (matches.length === 0) return { error: `没有以 ${key} 开头的项目名或 id` }
  return { error: `前缀 ${key} 匹配多个项目:\n${matches.map(p => `- ${p.record.name} [${p.record.id.slice(0, 8)}]${p.record.archived ? ' · 已归档' : ''}`).join('\n')}` }
}

/** Resolve one id prefix to a unique task, or an error naming the candidates. */
function resolve(list: readonly TaskView[], prefix: string): { view: TaskView } | { error: string } {
  const matches = list.filter(view => view.record.id.startsWith(prefix))
  if (matches.length === 1) return { view: matches[0]! }
  if (matches.length === 0) return { error: `没有以 ${prefix} 开头的任务` }
  // The picker listing drops the idle marker: without the ledger context it
  // would show raw own-task idleness, misleading under live delegation.
  return { error: `前缀 ${prefix} 匹配多个任务:\n${matches.map(view => lineOf(view, 0)).join('\n')}` }
}

/** One seam error as a human-readable command error. */
function failure(error: TaskError): CommandResult {
  return { kind: 'error', text: `${error.code}: ${error.message}` }
}

/** One project section: status subgroups in PANEL_ORDER under its header. */
function projectSection(marker: string, name: string, views: TaskView[], idler: (view: TaskView) => number, status?: TaskStatus): string {
  const headerIdle = Math.max(0, ...views.filter(isOpen).map(idler))
  const header = `${marker} ${name} (${views.length})${headerIdle < 1 ? '' : ` · 闲置 ${headerIdle} 天`}`
  if (status !== undefined) return `${header}\n${views.map(view => lineOf(view, idler(view))).join('\n')}`
  const groups = new Map<TaskStatus, TaskView[]>()
  for (const view of views) {
    const bucket = groups.get(view.record.status) ?? []
    bucket.push(view)
    groups.set(view.record.status, bucket)
  }
  const sections = PANEL_ORDER
    .filter(state => groups.has(state))
    .map(state => {
      const bucket = groups.get(state)!
      return `  ${STATUS_LABEL[state]} (${bucket.length})\n${bucket.map(view => lineOf(view, idler(view))).join('\n')}`
    })
  return [header, ...sections].join('\n')
}

/** The panel, grouped by project first and status inside each group. */
function panel(ctx: Context, config: Config, now: Date, status?: TaskStatus, projectId?: ProjectView['record']['id']): CommandResult {
  const views = ctx.tasks.list({
    ...status === undefined ? {} : { status },
    ...projectId === undefined ? {} : { projectId },
  })
  if (views.length === 0) {
    const scope = projectId === undefined ? '' : '该项目下'
    return { kind: 'success', text: status === undefined ? `任务队列${scope}为空` : `${STATUS_LABEL[status]}${scope}为空` }
  }
  const holderActivity = holderActivityOf(ctx)
  const idler = (view: TaskView): number => effectiveIdle(ctx.tasks, view, now, holderActivity)
  const sections: string[] = []
  // The stalest open task is pinned above every group once it crosses the
  // configured threshold — the "forgot to pick this back up" line.
  const stalest = views.filter(isOpen)
    .reduce<TaskView | undefined>((worst, view) => worst === undefined || idler(view) > idler(worst) ? view : worst, undefined)
  if (stalest !== undefined && idler(stalest) >= config.staleDays) {
    sections.push(`⚠ 搁置最久(闲置 ${idler(stalest)} 天)\n${lineOf(stalest, idler(stalest))}`)
  }
  // Group by project in creation order; tasks of archived projects stay in
  // their group (readable), and unassigned tasks land in the trailing bucket.
  const byProject = new Map<ProjectView['record']['id'], TaskView[]>()
  const unassigned: TaskView[] = []
  for (const view of views) {
    const id = view.record.projectId
    if (id === undefined) unassigned.push(view)
    else byProject.set(id, [...(byProject.get(id) ?? []), view])
  }
  for (const project of ctx.tasks.projects()) {
    const bucket = byProject.get(project.record.id)
    if (bucket === undefined) continue
    const label = project.record.archived ? `${project.record.name} · 已归档` : project.record.name
    sections.push(projectSection('📅', label, bucket, idler, status))
  }
  if (unassigned.length > 0) sections.push(projectSection('🗑', '无项目', unassigned, idler, status))
  return { kind: 'success', text: sections.join('\n\n') }
}

/** Human-readable wake rule. */
function describeWake(rule: WakeRule): string {
  if (rule.kind === 'after') return `${rule.afterSeconds} 秒后`
  if (rule.kind === 'at') return `定点 ${rule.scheduledAt}`
  return `每 ${rule.everySeconds} 秒(锚点 ${rule.anchorAt})`
}

/** Detail view of one task, its live children, and the context-pack tail. */
function show(ctx: Context, view: TaskView, now: Date): CommandResult {
  const holderActivity = holderActivityOf(ctx)
  const record = view.record
  const pack = record.contextPack === '' ? '(尚无记录)' : record.contextPack.split('\n').slice(-8).join('\n')
  const children = ctx.tasks.children(record.id).filter(child => !child.archived)
  const projectName = record.projectId === undefined ? undefined : ctx.tasks.project(record.projectId)?.record.name
  return {
    kind: 'success',
    text: [
      `${record.id} · r${record.revision} · ${STATUS_LABEL[record.status]}${view.archived ? ' · 已归档' : ''}`,
      `目标: ${record.objective}`,
      `验收: ${record.acceptance}`,
      ...projectName === undefined ? [] : [`项目: ${projectName}`],
      record.holder === undefined ? '持有会话: 无' : `持有会话: ${record.holder}`,
      ...record.blockedReason === undefined ? [] : [`阻塞: ${record.blockedReason.code} — ${record.blockedReason.message}`],
      ...record.wakeRule === undefined ? [] : [`定时唤醒: ${describeWake(record.wakeRule)}`],
      ...children.length === 0 ? [] : [`子任务 (${children.length}):\n${children.map(child => lineOf(child, effectiveIdle(ctx.tasks, child, now, holderActivity))).join('\n')}`],
      `上下文包(尾部 8 行):\n${pack}`,
    ].join('\n'),
  }
}

/** Parse the human actor's typed line and run one subcommand. */
async function run(ctx: Context, config: Config, rawInput: string): Promise<CommandResult> {
  const now = new Date()
  const input = rawInput.trim()
  if (input === '') return panel(ctx, config, now)
  const head = input.split(/\s+/, 1)[0]!
  const tail = input.slice(head.length).trim()
  const sub = head.toLowerCase()

  if (sub === 'list') {
    if (tail === '') return panel(ctx, config, now)
    if (!(tail in STATUS_LABEL)) return { kind: 'error', text: `未知状态 ${tail},可用:todo|active|blocked|review|done` }
    return panel(ctx, config, now, tail as TaskStatus)
  }

  if (sub === 'show') {
    if (tail === '') return { kind: 'error', text: USAGE }
    const found = resolve(allTasks(ctx), tail)
    return 'error' in found ? { kind: 'error', text: found.error } : show(ctx, found.view, now)
  }

  if (sub === 'create') {
    // Optional trailing `under <parent>` and `in <project>` qualifiers, either order-insensitive strip.
    const inMatch = /^(.*)\s+in\s+(\S+)$/.exec(tail)
    const withoutIn = inMatch === null ? tail : inMatch[1]!
    const projectKey = inMatch?.[2]
    const spawn = /^(.*)\s+under\s+(\S+)$/.exec(withoutIn)
    const body = spawn === null ? withoutIn : spawn[1]!
    const parentPrefix = spawn?.[2]
    const separator = body.indexOf('::')
    if (separator === -1) return { kind: 'error', text: 'create 需要 <objective> :: <acceptance> 两段,以 :: 分隔' }
    const objective = body.slice(0, separator).trim()
    const acceptance = body.slice(separator + 2).trim()
    if (objective === '' || acceptance === '') return { kind: 'error', text: 'objective 与 acceptance 都不能为空' }
    // Resolve the project first: a bad key archives nothing because nothing exists yet.
    let project: ProjectView | undefined
    if (projectKey !== undefined) {
      const found = resolveProject(ctx, projectKey)
      if ('error' in found) return { kind: 'error', text: found.error }
      if (found.view.record.archived) {
        return { kind: 'error', text: `项目 ${found.view.record.name} 已归档,不再接收新任务` }
      }
      project = found.view
    }
    const created = await ctx.tasks.create({
      objective, acceptance,
      ...project === undefined ? {} : { projectId: project.record.id },
    }, { kind: 'human' })
    if ('code' in created) return failure(created)
    const childId = created.task.record.id
    if (parentPrefix === undefined) {
      return {
        kind: 'success',
        text: [
          `已创建 [${childId.slice(0, 8)}] ${objective}`,
          ...project === undefined ? [] : [`归入项目 ${project.record.name}`],
        ].join('\n'),
      }
    }
    const found = resolve(allTasks(ctx), parentPrefix)
    if ('error' in found) {
      await ctx.tasks.mutate(childId, 1, { operation: 'abandon' }, { kind: 'human' })
      return { kind: 'error', text: found.error }
    }
    const linked = await ctx.tasks.mutate(found.view.record.id, found.view.record.revision, {
      operation: 'subtask-add', childId,
    }, { kind: 'human' })
    if ('code' in linked) {
      await ctx.tasks.mutate(childId, 1, { operation: 'abandon' }, { kind: 'human' })
      return failure(linked)
    }
    return {
      kind: 'success',
      text: [
        `已创建 [${childId.slice(0, 8)}] ${objective}`,
        `挂接为 [${found.view.record.id.slice(0, 8)}] 的子任务`,
        ...project === undefined ? [] : [`归入项目 ${project.record.name}`],
      ].join('\n'),
    }
  }

  if (sub === 'candidates') {
    const candidates = ctx.tasks.candidates()
    if (candidates.length === 0) {
      return { kind: 'success', text: '还没有候选;闲置会话里未完结的 goal 会自动出现在这里' }
    }
    const label: Readonly<Record<CandidateView['record']['status'], string>> = {
      pending: '待确认', promoted: '已晋升', ignored: '已忽略', superseded: '已失效',
    }
    const lines = candidates.flatMap(view => {
      const { record } = view
      const source = `${record.origin.tier} · 会话 ${record.origin.sessionId.slice(0, 8)}`
      return [
        `- [${record.id.slice(0, 8)}] r${record.revision} ${label[record.status]}: ${record.objective} · 来源 ${source}`,
        ...record.note === '' ? [] : [`    ${record.note}`],
        ...record.promotedTaskId === undefined ? [] : [`    已成为任务 [${record.promotedTaskId.slice(0, 8)}]`],
      ]
    })
    const pending = candidates.filter(view => view.record.status === 'pending').length
    return { kind: 'success', text: [`候选(${pending} 条待确认 / 共 ${candidates.length} 条):`, ...lines].join('\n') }
  }

  if (sub === 'promote' || sub === 'ignore') {
    const prefix = tail.split(/\s+/, 1)[0] ?? ''
    if (prefix === '') return { kind: 'error', text: USAGE }
    const matches = ctx.tasks.candidates().filter(view => view.record.id.startsWith(prefix))
    if (matches.length === 0) return { kind: 'error', text: `没有以 ${prefix} 开头的候选` }
    if (matches.length > 1) {
      return { kind: 'error', text: `前缀 ${prefix} 匹配多个候选:\n${matches.map(view => `- [${view.record.id.slice(0, 8)}] ${view.record.objective}`).join('\n')}` }
    }
    const { record } = matches[0]!
    if (sub === 'ignore') {
      const ignored = await ctx.tasks.candidateIgnore(record.id, record.revision, { kind: 'human' })
      return 'code' in ignored
        ? failure(ignored)
        : { kind: 'success', text: `已忽略候选 [${record.id.slice(0, 8)}] ${record.objective}` }
    }
    const body = tail.slice(prefix.length)
    // `::` splits an optional objective override from the acceptance; without
    // it the whole body is the acceptance and the candidate's objective stands.
    const separator = body.indexOf('::')
    const objective = separator === -1 ? '' : body.slice(0, separator).trim()
    const acceptance = separator === -1 ? body.trim() : body.slice(separator + 2).trim()
    if (acceptance === '') return { kind: 'error', text: '验收标准不能为空 —— 候选抽不出验收,这一段由人补' }
    const promoted = await ctx.tasks.candidatePromote(record.id, record.revision, {
      acceptance,
      ...objective === '' ? {} : { objective },
    }, { kind: 'human' })
    if ('code' in promoted) return failure(promoted)
    return {
      kind: 'success',
      text: [
        `候选 [${record.id.slice(0, 8)}] 已晋升为任务 [${promoted.task.record.id.slice(0, 8)}] ${promoted.task.record.objective}`,
        `验收: ${promoted.task.record.acceptance}`,
      ].join('\n'),
    }
  }

  if (sub === 'approve' || sub === 'reject') {
    const prefix = tail.split(/\s+/, 1)[0] ?? ''
    if (prefix === '') return { kind: 'error', text: USAGE }
    const found = resolve(allTasks(ctx), prefix)
    if ('error' in found) return { kind: 'error', text: found.error }
    const { record } = found.view
    if (found.view.archived) {
      return { kind: 'error', text: `[${record.id.slice(0, 8)}] 已归档,不能验收或打回` }
    }
    if (record.status !== 'review') {
      return { kind: 'error', text: `[${record.id.slice(0, 8)} 当前是「${STATUS_LABEL[record.status]}」,只有待验收任务能${sub === 'approve' ? '验收' : '打回'}` }
    }
    if (sub === 'approve') {
      const approved = await ctx.tasks.mutate(record.id, record.revision, { operation: 'approve' }, { kind: 'human' })
      return 'code' in approved
        ? failure(approved)
        : { kind: 'success', text: `已验收 [${record.id.slice(0, 8)}] ${record.objective}` }
    }
    const reason = tail.slice(prefix.length).trim()
    if (reason === '') return { kind: 'error', text: '打回必须附理由(理由写入任务上下文包,模型据此返工)' }
    const rejected = await ctx.tasks.mutate(record.id, record.revision, { operation: 'reject', reason }, { kind: 'human' })
    return 'code' in rejected
      ? failure(rejected)
      : { kind: 'success', text: `已打回 [${record.id.slice(0, 8)}]:${reason}` }
  }

  if (sub === 'wake' || sub === 'nowake') {
    const prefix = tail.split(/\s+/, 1)[0] ?? ''
    if (prefix === '') return { kind: 'error', text: USAGE }
    const found = resolve(allTasks(ctx), prefix)
    if ('error' in found) return { kind: 'error', text: found.error }
    const { record } = found.view
    if (sub === 'nowake') {
      if (record.wakeRule === undefined) return { kind: 'error', text: `[${record.id.slice(0, 8)}] 没有定时唤醒规则` }
      const cleared = await ctx.tasks.mutate(record.id, record.revision, { operation: 'wake-clear' }, { kind: 'human' })
      return 'code' in cleared
        ? failure(cleared)
        : { kind: 'success', text: `已取消 [${record.id.slice(0, 8)}] 的定时唤醒` }
    }
    const [kind, arg] = tail.slice(prefix.length).trim().split(/\s+/, 2)
    if (kind === undefined || arg === undefined || arg === '') {
      return { kind: 'error', text: 'wake 需要 after <秒> / at <ISO时刻> / every <秒> 三选一' }
    }
    if (kind !== 'after' && kind !== 'at' && kind !== 'every') {
      return { kind: 'error', text: `未知唤醒类型 ${kind},可用:after | at | every` }
    }
    const rule: WakeRule = kind === 'after'
      ? { kind: 'after', afterSeconds: Number(arg) }
      : kind === 'at'
        ? { kind: 'at', scheduledAt: arg }
        : { kind: 'every', everySeconds: Number(arg), anchorAt: new Date().toISOString() }
    const set = await ctx.tasks.mutate(record.id, record.revision, { operation: 'wake-set', rule }, { kind: 'human' })
    return 'code' in set
      ? failure(set)
      : { kind: 'success', text: `已设定 [${record.id.slice(0, 8)}] 定时唤醒:${describeWake(rule)}` }
  }

  if (sub === 'release') {
    const prefix = tail.split(/\s+/, 1)[0] ?? ''
    if (prefix === '') return { kind: 'error', text: USAGE }
    const found = resolve(allTasks(ctx), prefix)
    if ('error' in found) return { kind: 'error', text: found.error }
    const { record } = found.view
    if (found.view.archived) return { kind: 'error', text: `[${record.id.slice(0, 8)}] 已归档,无需释放` }
    if (record.holder === undefined) return { kind: 'error', text: `[${record.id.slice(0, 8)}] 没有持有会话` }
    const released = await ctx.tasks.mutate(record.id, record.revision, { operation: 'release' }, { kind: 'human' })
    return 'code' in released
      ? failure(released)
      : { kind: 'success', text: `已释放 [${record.id.slice(0, 8)}],回到待办可认领` }
  }

  if (sub === 'project') {
    if (tail === '') {
      const projects = ctx.tasks.projects()
      if (projects.length === 0) return { kind: 'success', text: '还没有项目;/task project create <名> 建一个' }
      const counts = new Map<string, number>()
      const idles = new Map<string, number>()
      const holderActivity = holderActivityOf(ctx)
      for (const view of ctx.tasks.list({})) {
        const id = view.record.projectId
        if (id === undefined) continue
        counts.set(id, (counts.get(id) ?? 0) + 1)
        if (isOpen(view)) idles.set(id, Math.max(idles.get(id) ?? 0, effectiveIdle(ctx.tasks, view, now, holderActivity)))
      }
      return {
        kind: 'success',
        text: projects.map(view => {
          const idle = idles.get(view.record.id) ?? 0
          return `- ${view.record.name} [${view.record.id.slice(0, 8)}] · ${counts.get(view.record.id) ?? 0} 个任务${view.record.archived ? ' · 已归档' : ''}${idle < 1 ? '' : ` · 闲置 ${idle} 天`}`
        }).join('\n'),
      }
    }
    const verb = tail.split(/\s+/, 1)[0]!.toLowerCase()
    const rest = tail.slice(verb.length).trim()
    if (verb === 'create') {
      if (rest === '') return { kind: 'error', text: 'project create 需要非空项目名' }
      const created = await ctx.tasks.projectCreate(rest, { kind: 'human' })
      return 'code' in created
        ? failure(created)
        : { kind: 'success', text: `已建项目 ${created.project.record.name} [${created.project.record.id.slice(0, 8)}]` }
    }
    if (verb === 'rename' || verb === 'archive') {
      const key = rest.split(/\s+/, 1)[0] ?? ''
      if (key === '') return { kind: 'error', text: USAGE }
      const found = resolveProject(ctx, key)
      if ('error' in found) return { kind: 'error', text: found.error }
      const { record } = found.view
      if (verb === 'archive') {
        if (record.archived) return { kind: 'error', text: `项目 ${record.name} 已归档` }
        const archived = await ctx.tasks.projectMutate(record.id, record.revision, { operation: 'project-archive' }, { kind: 'human' })
        return 'code' in archived
          ? failure(archived)
          : { kind: 'success', text: `已归档项目 ${record.name};其任务保留可读,新任务不再归入` }
      }
      const newName = rest.slice(key.length).trim()
      if (newName === '') return { kind: 'error', text: 'project rename 需要 <名或前缀> <新名> 两段' }
      const renamed = await ctx.tasks.projectMutate(record.id, record.revision, { operation: 'project-rename', name: newName }, { kind: 'human' })
      return 'code' in renamed
        ? failure(renamed)
        : { kind: 'success', text: `已重命名 ${record.name} → ${newName}` }
    }
    // Anything else is a project key: show that project's own panel.
    const found = resolveProject(ctx, tail)
    if ('error' in found) return { kind: 'error', text: found.error }
    return panel(ctx, config, now, undefined, found.view.record.id)
  }

  return { kind: 'error', text: `未知子命令 ${sub}\n${USAGE}` }
}

/**
 * Register the `/task` command. `recordInput: false` because every payload the
 * human types (objective, acceptance, reject reason) lands in the task domain
 * event; `command/done` carries the human-readable outcome.
 * @param ctx - Plugin context.
 * @param config - The stale-banner threshold in days.
 */
export function apply(ctx: Context, config: Config): void {
  if (!Number.isInteger(config.staleDays) || config.staleDays < 1) {
    throw new Error(`command-task config staleDays must be a positive integer of days, got ${String(config.staleDays)}`)
  }
  const definition: CommandDefinition = {
    name: 'task',
    description: '任务面板:全景 / 详情 / 建任务 / 验收 / 打回',
    recordInput: false,
    handler: ({ rawInput }) => run(ctx, config, rawInput),
  }
  ctx.commands.register(definition)
}
