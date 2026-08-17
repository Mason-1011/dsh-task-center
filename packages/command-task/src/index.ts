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
import type { TaskError, TaskStatus, TaskView, WakeRule } from '@task-center/task'

/** Cordis plugin name. */
export const name = 'command-task'

/** The task seam and the command registry must be present. */
export const inject = ['tasks', 'commands']

const USAGE = [
  '用法:',
  '  /task                        — 全景面板:阻塞置顶、待验收、在办、待办',
  '  /task list <status>          — 按状态过滤(todo|active|blocked|review|done)',
  '  /task show <id前缀>          — 单任务详情,含上下文包尾部',
  '  /task create <objective> :: <acceptance>',
  '                               — 人类建任务,交给会话认领',
  '  /task wake <id前缀> after <秒> | at <ISO时刻> | every <秒>',
  '                               — 定时唤醒:到点起新会话做该任务',
  '  /task nowake <id前缀>        — 取消定时唤醒',
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

/** One line of the panel for one task view. */
function lineOf(view: TaskView): string {
  const holder = view.record.holder === undefined ? '' : ` @${view.record.holder}`
  const pack = view.record.contextPack === '' ? '' : ` · pack ${encoder.encode(view.record.contextPack).length}B`
  const wake = view.record.wakeRule === undefined ? '' : ' · ⏰'
  return `- [${view.record.id.slice(0, 8)}] r${view.record.revision} ${STATUS_LABEL[view.record.status]}${holder}: ${view.record.objective}${pack}${wake}`
}

/** Every live or archived task, so prefix matching never misses over the cap. */
function allTasks(ctx: Context): TaskView[] {
  return ctx.tasks.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })
}

/** Resolve one id prefix to a unique task, or an error naming the candidates. */
function resolve(list: readonly TaskView[], prefix: string): { view: TaskView } | { error: string } {
  const matches = list.filter(view => view.record.id.startsWith(prefix))
  if (matches.length === 1) return { view: matches[0]! }
  if (matches.length === 0) return { error: `没有以 ${prefix} 开头的任务` }
  return { error: `前缀 ${prefix} 匹配多个任务:\n${matches.map(lineOf).join('\n')}` }
}

/** One seam error as a human-readable command error. */
function failure(error: TaskError): CommandResult {
  return { kind: 'error', text: `${error.code}: ${error.message}` }
}

/** The panel, grouped by status in PANEL_ORDER with counts. */
function panel(ctx: Context, status?: TaskStatus): CommandResult {
  const views = ctx.tasks.list(status === undefined ? {} : { status })
  if (views.length === 0) {
    return { kind: 'success', text: status === undefined ? '任务队列为空' : `${STATUS_LABEL[status]}队列为空` }
  }
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
      return `${STATUS_LABEL[state]} (${bucket.length})\n${bucket.map(lineOf).join('\n')}`
    })
  return { kind: 'success', text: sections.join('\n\n') }
}

/** Human-readable wake rule. */
function describeWake(rule: WakeRule): string {
  if (rule.kind === 'after') return `${rule.afterSeconds} 秒后`
  if (rule.kind === 'at') return `定点 ${rule.scheduledAt}`
  return `每 ${rule.everySeconds} 秒(锚点 ${rule.anchorAt})`
}

/** Detail view of one task, ending with the context-pack tail. */
function show(view: TaskView): CommandResult {
  const record = view.record
  const pack = record.contextPack === '' ? '(尚无记录)' : record.contextPack.split('\n').slice(-8).join('\n')
  return {
    kind: 'success',
    text: [
      `${record.id} · r${record.revision} · ${STATUS_LABEL[record.status]}${view.archived ? ' · 已归档' : ''}`,
      `目标: ${record.objective}`,
      `验收: ${record.acceptance}`,
      record.holder === undefined ? '持有会话: 无' : `持有会话: ${record.holder}`,
      ...record.blockedReason === undefined ? [] : [`阻塞: ${record.blockedReason.code} — ${record.blockedReason.message}`],
      ...record.wakeRule === undefined ? [] : [`定时唤醒: ${describeWake(record.wakeRule)}`],
      `上下文包(尾部 8 行):\n${pack}`,
    ].join('\n'),
  }
}

/** Parse the human actor's typed line and run one subcommand. */
async function run(ctx: Context, rawInput: string): Promise<CommandResult> {
  const input = rawInput.trim()
  if (input === '') return panel(ctx)
  const head = input.split(/\s+/, 1)[0]!
  const tail = input.slice(head.length).trim()
  const sub = head.toLowerCase()

  if (sub === 'list') {
    if (tail === '') return panel(ctx)
    if (!(tail in STATUS_LABEL)) return { kind: 'error', text: `未知状态 ${tail},可用:todo|active|blocked|review|done` }
    return panel(ctx, tail as TaskStatus)
  }

  if (sub === 'show') {
    if (tail === '') return { kind: 'error', text: USAGE }
    const found = resolve(allTasks(ctx), tail)
    return 'error' in found ? { kind: 'error', text: found.error } : show(found.view)
  }

  if (sub === 'create') {
    const separator = tail.indexOf('::')
    if (separator === -1) return { kind: 'error', text: 'create 需要 <objective> :: <acceptance> 两段,以 :: 分隔' }
    const objective = tail.slice(0, separator).trim()
    const acceptance = tail.slice(separator + 2).trim()
    if (objective === '' || acceptance === '') return { kind: 'error', text: 'objective 与 acceptance 都不能为空' }
    const created = await ctx.tasks.create({ objective, acceptance }, { kind: 'human' })
    return 'code' in created
      ? failure(created)
      : { kind: 'success', text: `已创建 [${created.task.record.id.slice(0, 8)}] ${objective}` }
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

  return { kind: 'error', text: `未知子命令 ${sub}\n${USAGE}` }
}

/**
 * Register the `/task` command. `recordInput: false` because every payload the
 * human types (objective, acceptance, reject reason) lands in the task domain
 * event; `command/done` carries the human-readable outcome.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  const definition: CommandDefinition = {
    name: 'task',
    description: '任务面板:全景 / 详情 / 建任务 / 验收 / 打回',
    recordInput: false,
    handler: ({ rawInput }) => run(ctx, rawInput),
  }
  ctx.commands.register(definition)
}
