/**
 * Op sequence → dsh `SessionEvent[]`: the mapping table. Identity for tool
 * names except two structural renames — `ExitPlanMode` → `exit_plan_mode`
 * (the plan tier's approved-plan evidence) and `TodoWrite` → a `todo/write`
 * whole-list snapshot (its call/result pair is suppressed). Assistant content
 * carries text + tool-call blocks so the session stays provider-valid under a
 * future resume; turns are synthesized one per human prompt.
 * @module @task-center/cc-import/map
 */

import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CcOp, CcSession, CcToolUseOp } from './parse.ts'

/** CC's todo tool; converted to `todo/write` events, pair suppressed. */
export const CC_TODO_TOOL = 'TodoWrite'

/** CC's plan-approval tool; renamed so the plan tier folds it. */
export const CC_PLAN_TOOL = 'ExitPlanMode'

/** The name dsh's plan tier pairs on. */
const DSH_PLAN_TOOL = 'exit_plan_mode'

/** Provider tag for materialized assistant messages. */
const PROVIDER = 'claude-code'

/** Model fallback when a line recorded none. */
const UNKNOWN_MODEL = 'unknown'

/** dsh's TodoItem statuses — CC shares the vocabulary. */
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/** Map output: the contiguous event log plus mapper-level notes. */
export interface MappedSession {
  readonly events: SessionEvent[]
  readonly warnings: readonly string[]
}

interface TodoLike {
  readonly content?: unknown
  readonly status?: unknown
}

/** Map one parsed CC session to its dsh event log. */
export function mapCcSession(session: CcSession): MappedSession {
  const events: SessionEvent[] = []
  const warnings: string[] = []
  let turn = 0
  let step = 0
  let turnOpen = false
  /** Call sites by id — results inherit turn/step; TodoWrite ids mark suppression. */
  const callSites = new Map<string, { turn: number; step: number; suppressed: boolean }>()
  /** Per-uuid disambiguation for result message ids. */
  const idUses = new Map<string, number>()

  const push = (event: Omit<SessionEvent, 'seq'>): void => {
    events.push({ ...event, seq: events.length } as SessionEvent)
  }

  const openTurn = (time: number): void => {
    if (turnOpen) return
    turn++
    step = 0
    turnOpen = true
    push({ type: 'turn/start', time, data: { turn } } as Omit<SessionEvent, 'seq'>)
  }

  const closeTurn = (time: number): void => {
    if (!turnOpen) return
    turnOpen = false
    push({ type: 'turn/end', time, data: { turn, reason: { kind: 'completed' } } } as Omit<SessionEvent, 'seq'>)
  }

  const nextResultId = (uuid: string): string => {
    const uses = idUses.get(uuid) ?? 0
    idUses.set(uuid, uses + 1)
    return uses === 0 ? uuid : `${uuid}-${uses}`
  }

  const emitToolCalls = (op: { time: number }, uses: readonly CcToolUseOp[]): void => {
    for (const use of uses) {
      if (use.name === CC_TODO_TOOL) {
        callSites.set(use.id, { turn, step, suppressed: true })
        continue
      }
      callSites.set(use.id, { turn, step, suppressed: false })
      const view = toolUseView(use)
      push({
        type: 'tool/call',
        time: op.time,
        data: {
          turn,
          step,
          callId: CallId(use.id),
          name: view.name,
          arguments: view.arguments,
        },
      } as Omit<SessionEvent, 'seq'>)
    }
  }

  for (const op of session.ops) {
    if (op.kind === 'human') {
      closeTurn(op.time)
      openTurn(op.time)
      push({
        type: 'user/message',
        time: op.time,
        surfaceOp: 'append',
        data: {
          id: MessageId(op.uuid),
          role: 'user',
          content: [{ type: 'text', text: op.text }],
          source: { kind: 'user' },
        },
      } as Omit<SessionEvent, 'seq'>)
      continue
    }

    if (op.kind === 'assistant') {
      openTurn(op.time)
      step++
      const callUses = op.toolUses.filter(use => use.name !== CC_TODO_TOOL)
      const todoUses = op.toolUses.filter(use => use.name === CC_TODO_TOOL)
      if (op.textBlocks.length > 0 || callUses.length > 0) {
        push({
          type: 'assistant/message',
          time: op.time,
          surfaceOp: 'append',
          data: {
            turn,
            step,
            message: {
              id: MessageId(op.uuid),
              role: 'assistant',
              content: [
                ...op.textBlocks.map(text => ({ type: 'text' as const, text })),
                ...callUses.map(use => {
                  const view = toolUseView(use)
                  return {
                    type: 'tool-call' as const,
                    id: CallId(use.id),
                    name: view.name,
                    arguments: view.arguments,
                  }
                }),
              ],
              source: { kind: 'model', provider: PROVIDER, model: op.model ?? UNKNOWN_MODEL },
            },
            ...op.usage === undefined ? {} : { usage: op.usage },
          },
        } as Omit<SessionEvent, 'seq'>)
      }
      emitToolCalls(op, op.toolUses)
      for (const use of todoUses) {
        const todos = normalizeTodos(use.input, warnings)
        if (todos.length > 0) {
          push({ type: 'todo/write', time: op.time, data: { todos } } as Omit<SessionEvent, 'seq'>)
        }
      }
      continue
    }

    // tool-result: inherit the call's turn/step; suppressed calls and orphans skip.
    const site = callSites.get(op.callId)
    if (site === undefined) {
      warnings.push(`orphan tool result ${op.callId} dropped`)
      continue
    }
    if (site.suppressed) continue
    push({
      type: 'tool/result',
      time: op.time,
      surfaceOp: 'append',
      data: {
        turn: site.turn,
        step: site.step,
        message: {
          id: MessageId(nextResultId(op.uuid)),
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: CallId(op.callId),
            content: [{ type: 'text', text: op.text }],
            ...(op.isError ? { isError: true } : {}),
          }],
          source: { kind: 'tool', callId: CallId(op.callId) },
        },
        ...op.isError ? { error: { name: 'ToolError', code: 'TOOL_ERROR' } } : {},
      },
    } as Omit<SessionEvent, 'seq'>)
  }

  const lastTime = session.ops.at(-1)?.time ?? session.createdAt ?? 0
  closeTurn(lastTime)
  return { events, warnings }
}

/**
 * One tool use's wire view: name + JSON arguments. The plan rename only
 * happens when the arguments carry a plan the plan tier can fold — a string
 * (content-block arrays flattened); anything else keeps the CC name so it
 * never reads as an approval signal and cannot crash the fold.
 */
function toolUseView(use: CcToolUseOp): { name: string; arguments: string } {
  if (use.name === CC_PLAN_TOOL) {
    const plan = planText(use.input)
    if (plan !== undefined) {
      const rest = { ...(use.input as Record<string, unknown> | null | undefined) ?? {} }
      delete rest['plan']
      return { name: DSH_PLAN_TOOL, arguments: JSON.stringify({ ...rest, plan }) }
    }
  }
  return { name: use.name, arguments: JSON.stringify(use.input ?? {}) }
}

/** Flatten a CC plan argument to foldable text: string as-is, text blocks joined. */
function planText(input: unknown): string | undefined {
  const plan = (input as { plan?: unknown } | null | undefined)?.plan
  if (typeof plan === 'string') return plan
  if (Array.isArray(plan)) {
    const text = plan
      .filter(item => typeof (item as { text?: unknown })?.text === 'string')
      .map(item => (item as { text: string }).text)
      .join('\n')
    return text === '' ? undefined : text
  }
  return undefined
}

/** CC TodoWrite input → dsh todo items; unreadable entries are skipped loud. */
function normalizeTodos(input: unknown, warnings: string[]): { content: string; status: 'pending' | 'in_progress' | 'completed' }[] {
  const todos = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(todos)) return []
  const mapped: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  let skipped = 0
  for (const item of todos as TodoLike[]) {
    const content = typeof item?.content === 'string' ? item.content : ''
    const status = typeof item?.status === 'string' && TODO_STATUSES.has(item.status)
      ? item.status as 'pending' | 'in_progress' | 'completed'
      : undefined
    if (status === undefined || content === '') {
      skipped++
      continue
    }
    mapped.push({ content, status })
  }
  if (skipped > 0) warnings.push(`${skipped} unreadable todo item(s) skipped`)
  return mapped
}
