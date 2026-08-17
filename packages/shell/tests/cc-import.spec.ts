/**
 * Claude Code transcript → task-ledger importer (dev tool, not an assertion
 * suite). Local conversation logs are the workload: every TaskCreate call in
 * a transcript becomes one task (objective = subject, acceptance =
 * description), every TaskUpdate drives the lifecycle (in_progress → claim,
 * completed → submit for review), and every mutation commits under a fake
 * clock pinned to the log line's own timestamp — so idle days, the stale
 * banner and the review queue reflect the REAL timeline of past work.
 *
 * Only main-chain tool calls count (sidechain = subagent noise). Sessions
 * without task-tool calls are listed as skipped, not invented. Re-runs dedupe
 * on (project, objective).
 *
 * Opt-in: runs only with CC_IMPORT_ROOT set (the ledger's storage root, e.g.
 * ~/.dsh/storages to share with the dsh profiles); plain `pnpm test` skips it.
 * CC_LOG_HOME overrides the transcript directory (default ~/.claude/projects).
 * @module @task-center/shell/tests/cc-import
 */

import { describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectId, TaskActor, TaskView } from '@task-center/task'
import { bootComposition } from './boot.ts'

const ROOT = process.env['CC_IMPORT_ROOT']
const LOG_HOME = process.env['CC_LOG_HOME'] ?? join(homedir(), '.claude', 'projects')
const YML = resolve(dirname(fileURLToPath(import.meta.url)), 'cc-import.cordis.yml')

/** One transcript line, loosely typed: only the fields the importer reads. */
interface CcLine {
  timestamp?: string
  isSidechain?: boolean
  type?: string
  message?: { content?: unknown }
}

interface ToolUse {
  type: 'tool_use'
  id: string
  name: string
  input?: Record<string, unknown>
}

interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: unknown
}

/** A TaskCreate call still waiting for its `Task #N created` result. */
interface CreateOp {
  kind: 'create'
  toolUseId: string
  ccId: string | undefined
  subject: string
  description: string
  at: string
}

interface UpdateOp {
  kind: 'update'
  ccId: string
  status: string
  at: string
}

type CcOp = CreateOp | UpdateOp

/** One transcript file reduced to its task-tool timeline. */
interface SessionLog {
  sessionUuid: string
  project: string
  ops: CcOp[]
}

function asItems(content: unknown): (ToolUse | ToolResult)[] | undefined {
  if (!Array.isArray(content)) return undefined
  return content.filter((item): item is ToolUse | ToolResult =>
    typeof item === 'object' && item !== null && 'type' in item)
}

/** Reduce one transcript to create/update ops with their log timestamps. */
function parseSession(file: string): SessionLog | undefined {
  const pending = new Map<string, CreateOp>()
  const creates: CreateOp[] = []
  const updates: UpdateOp[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue
    let entry: CcLine
    try {
      entry = JSON.parse(line) as CcLine
    } catch {
      continue
    }
    if (entry.isSidechain === true || entry.timestamp === undefined) continue
    if (entry.type === 'assistant') {
      for (const item of asItems(entry.message?.content) ?? []) {
        if (!('name' in item)) continue
        if (item.name === 'TaskCreate') {
          const subject = String(item.input?.['subject'] ?? '').trim()
          if (subject === '') continue
          const op: CreateOp = {
            kind: 'create',
            toolUseId: item.id,
            ccId: undefined,
            subject,
            description: String(item.input?.['description'] ?? '').trim(),
            at: entry.timestamp,
          }
          pending.set(item.id, op)
          creates.push(op)
        } else if (item.name === 'TaskUpdate') {
          const ccId = String(item.input?.['taskId'] ?? '')
          const status = String(item.input?.['status'] ?? '')
          if (ccId !== '' && status !== '') updates.push({ kind: 'update', ccId, status, at: entry.timestamp })
        }
      }
    } else if (entry.type === 'user') {
      for (const item of asItems(entry.message?.content) ?? []) {
        if (!('tool_use_id' in item)) continue
        const op = pending.get(item.tool_use_id)
        if (op === undefined) continue
        const text = typeof item.content === 'string'
          ? item.content
          : Array.isArray(item.content)
            ? item.content.map(String).join(' ')
            : ''
        const found = /Task #(\d+)/.exec(text)
        if (found !== null) op.ccId = found[1]!
        pending.delete(item.tool_use_id)
      }
    }
  }
  const ops: CcOp[] = [...creates.filter(op => op.ccId !== undefined), ...updates]
  ops.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  return { sessionUuid: basename(file).replace(/\.jsonl$/, ''), project: basename(dirname(file)), ops }
}

/** Dispatch one slash line and return its result text, failing loud on errors. */
async function dispatch(ctx: Context, agent: Agent, line: string): Promise<string> {
  const execution = await ctx.commands.execute(agent, line, new AbortController().signal)
  if (execution === undefined) throw new Error(`${line} did not resolve to a command`)
  if (execution.result.kind === 'error') throw new Error(`${line} failed: ${execution.result.text}`)
  return execution.result.text ?? ''
}

describe.skipIf(ROOT === undefined)('cc-transcript import', () => {
  it('replays TaskCreate/TaskUpdate into the ledger on the original timeline', { timeout: 120_000 }, async () => {
    const files = existsSync(LOG_HOME)
      ? readdirSync(LOG_HOME).flatMap(dir => {
          const project = join(LOG_HOME, dir)
          if (!existsSync(project)) return []
          return readdirSync(project).filter(f => f.endsWith('.jsonl')).map(f => join(project, f))
        })
      : []
    const sessions = files
      .map(parseSession)
      .filter((s): s is SessionLog => s !== undefined && s.ops.some(op => op.kind === 'create'))
      .sort((a, b) => Date.parse(a.ops[0]!.at) - Date.parse(b.ops[0]!.at))

    const ctx = await bootComposition(ROOT!, YML)
    try {
      const agent = ctx.agentLoop.create(SessionId('cc-import'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
      const projectIds = new Map<string, ProjectId>(ctx.tasks.projects().map(view => [view.record.name, view.record.id]))
      const known = new Set(ctx.tasks.list({ includeArchived: true, limit: Number.MAX_SAFE_INTEGER })
        .map(view => `${view.record.projectId ?? '-'}|${view.record.objective}`))

      let created = 0
      let events = 0
      let skippedDuplicates = 0
      let rejectedTransitions = 0
      const finalStatus = new Map<string, number>()

      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        for (const session of sessions) {
          const actor: TaskActor = { kind: 'model', sessionId: SessionId(session.sessionUuid) }
          let projectId = projectIds.get(session.project)
          if (projectId === undefined) {
            const handle = await ctx.tasks.projectCreate(session.project, { kind: 'human' })
            if ('code' in handle) throw new Error(`project create failed: ${handle.code}`)
            projectId = handle.project.record.id
            projectIds.set(session.project, projectId)
          }
          /** Latest view per CC task id, for compare-and-set mutations. */
          const byCc = new Map<string, TaskView>()
          for (const op of session.ops) {
            vi.setSystemTime(new Date(op.at))
            if (op.kind === 'create') {
              if (known.has(`${projectId}|${op.subject}`)) { skippedDuplicates++; continue }
              known.add(`${projectId}|${op.subject}`)
              const handle = await ctx.tasks.create({
                objective: op.subject,
                acceptance: op.description === '' ? op.subject : op.description,
                projectId,
              }, actor)
              if ('code' in handle) { rejectedTransitions++; continue }
              byCc.set(op.ccId!, handle.task)
              created++
            } else {
              const view = byCc.get(op.ccId)
              if (view === undefined) continue
              const mutation = op.status === 'in_progress'
                ? { operation: 'claim' as const }
                : op.status === 'completed'
                  ? { operation: 'submit' as const, completionNote: `CC 标记完成:${view.record.objective}` }
                  : undefined
              if (mutation === undefined) continue
              const settled = await ctx.tasks.mutate(view.record.id, view.record.revision, mutation, actor)
              if ('code' in settled) { rejectedTransitions++; continue }
              byCc.set(op.ccId, settled)
              events++
            }
          }
          for (const view of byCc.values()) {
            finalStatus.set(view.record.status, (finalStatus.get(view.record.status) ?? 0) + 1)
          }
        }
      } finally {
        vi.useRealTimers()
      }

      console.log(`\n=== CC 导入摘要 ===`)
      console.log(`会话文件 ${files.length},含任务工具 ${sessions.length},跳过 ${files.length - sessions.length}`)
      console.log(`任务 ${created}(重复跳过 ${skippedDuplicates}),状态事件 ${events},被拒转换 ${rejectedTransitions}`)
      console.log(`终态分布 ${[...finalStatus].map(([s, n]) => `${s}:${n}`).join(' ') || '(空)'}\n`)
      console.log(`=== /task ===\n${await dispatch(ctx, agent, '/task')}`)
      console.log(`\n=== /task project ===\n${await dispatch(ctx, agent, '/task project')}`)

      expect(created).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
