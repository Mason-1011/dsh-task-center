/**
 * Claude Code transcript parser: one `.jsonl` session file reduced to the
 * intermediate op sequence the mapper consumes. Shape-level only — every
 * naming decision (TodoWrite conversion, ExitPlanMode rename, tool identity)
 * lives in map.ts. Streaming line-by-line: real transcripts reach 40+ MB.
 * @module @task-center/cc-import/parse
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename } from 'node:path'
import { isAbsolute as isPosixAbsolute } from 'node:path/posix'
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32'

/** Prompt-text prefixes the CC harness synthesizes — never a person typing. */
const SYNTHETIC_PROMPT_PREFIXES = [
  '[Request interrupted',
  '<task-notification',
  '</task-notification',
  '<command-name',
  '<command-message',
  '<local-command-stdout',
  '<system-reminder',
  '[warn]',
] as const

/** One `tool_use` item from an assistant message, kept verbatim. */
export interface CcToolUseOp {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/** Token usage as dsh records it. */
export interface CcUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** One conversation op in file order; mapping to SessionEvents happens later. */
export type CcOp =
  | { readonly kind: 'human'; readonly uuid: string; readonly time: number; readonly text: string }
  | {
    readonly kind: 'assistant'
    readonly uuid: string
    readonly time: number
    readonly model: string | undefined
    readonly textBlocks: readonly string[]
    readonly toolUses: readonly CcToolUseOp[]
    readonly usage: CcUsage | undefined
  }
  | {
    readonly kind: 'tool-result'
    readonly uuid: string
    readonly time: number
    readonly callId: string
    readonly text: string
    readonly isError: boolean
  }

/** One parsed transcript: identity facts plus the op sequence. */
export interface CcSession {
  readonly sessionUuid: string
  readonly cwd: string | undefined
  readonly createdAt: number | undefined
  readonly ops: readonly CcOp[]
  readonly counts: {
    readonly lines: number
    readonly dropped: number
    readonly humanPrompts: number
    readonly toolUses: number
  }
  readonly warnings: readonly string[]
}

/** One transcript line, loosely typed: only the fields the parser reads. */
interface CcLine {
  readonly type?: unknown
  readonly sessionId?: unknown
  readonly uuid?: unknown
  readonly timestamp?: unknown
  readonly isSidechain?: unknown
  readonly isMeta?: unknown
  readonly isCompactSummary?: unknown
  readonly cwd?: unknown
  readonly message?: {
    readonly model?: unknown
    readonly usage?: { readonly input_tokens?: unknown; readonly output_tokens?: unknown }
    readonly content?: unknown
  }
}

/** A content item with a discriminant, from either side of the conversation. */
interface ContentItem {
  readonly type?: unknown
  readonly text?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly input?: unknown
  readonly content?: unknown
  readonly tool_use_id?: unknown
  readonly is_error?: unknown
}

function isTextItem(item: ContentItem): item is { type: 'text'; text: string } {
  return item.type === 'text' && typeof item.text === 'string'
}

/** Flatten a CC content payload to its text: strings pass, arrays keep text items. */
function flattenText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as ContentItem[])
    .filter(isTextItem)
    .map(item => item.text)
    .filter(text => text !== '')
    .join('\n')
}

/** Human text, or undefined when empty/synthetic. */
function humanText(content: unknown): string | undefined {
  const text = flattenText(content).trim()
  if (text === '') return undefined
  return SYNTHETIC_PROMPT_PREFIXES.some(prefix => text.startsWith(prefix)) ? undefined : text
}

function asUsage(line: CcLine): CcUsage | undefined {
  const usage = line.message?.usage
  if (usage === undefined) return undefined
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') return undefined
  return { inputTokens, outputTokens }
}

/**
 * Parse one CC transcript file to its op sequence.
 * @param file - Path to the `.jsonl` transcript; the file name is the session uuid.
 */
export async function parseCcSession(file: string): Promise<CcSession> {
  const ops: CcOp[] = []
  const warnings: string[] = []
  let dropped = 0
  let humanPrompts = 0
  let toolUses = 0
  let lines = 0
  let unparseable = 0
  let cwd: string | undefined
  let createdAt: number | undefined
  let sessionId: string | undefined
  let lastTime = 0

  const readline = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const raw of readline) {
    if (raw.trim() === '') continue
    lines++
    let line: CcLine
    try {
      line = JSON.parse(raw) as CcLine
    } catch {
      unparseable++
      dropped++
      continue
    }
    if (sessionId === undefined && typeof line.sessionId === 'string' && line.sessionId !== '') {
      sessionId = line.sessionId
    }
    const time = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN
    const stamped = Number.isNaN(time) ? lastTime : time
    if (!Number.isNaN(time) && createdAt === undefined) createdAt = stamped
    lastTime = stamped
    if ((line.type === 'user' || line.type === 'assistant') && typeof line.cwd === 'string' && cwd === undefined) {
      // Transcripts sync across OSes: a Windows drive path is absolute where it
      // was recorded even though the host posix path module says otherwise.
      const absolute = isWindowsAbsolute(line.cwd) || isPosixAbsolute(line.cwd)
      cwd = absolute ? line.cwd : undefined
      if (!absolute) warnings.push(`non-absolute cwd ${line.cwd} ignored`)
    }
    if (line.type !== 'user' && line.type !== 'assistant') {
      dropped++
      continue
    }
    if (line.isSidechain === true || line.isMeta === true || line.isCompactSummary === true) {
      dropped++
      continue
    }
    const uuid = typeof line.uuid === 'string' ? line.uuid : `line-${lines}`
    const content = line.message?.content

    if (line.type === 'user') {
      const items = Array.isArray(content) ? (content as ContentItem[]) : undefined
      if (items !== undefined && items.some(item => item.type === 'tool_result')) {
        // A machine line: results for earlier calls. Text riding alongside is
        // harness bookkeeping, not a human prompt.
        for (const item of items) {
          if (item.type !== 'tool_result') continue
          if (typeof item.tool_use_id !== 'string' || item.tool_use_id === '') continue
          ops.push({
            kind: 'tool-result',
            uuid,
            time: stamped,
            callId: item.tool_use_id,
            text: flattenText(item.content).trim(),
            isError: item.is_error === true,
          })
        }
        continue
      }
      const text = humanText(content)
      if (text === undefined) {
        dropped++
        continue
      }
      ops.push({ kind: 'human', uuid, time: stamped, text })
      humanPrompts++
      continue
    }

    // assistant: text blocks + tool_use items; thinking/server_tool_use/
    // intra-message tool_result/fallback blocks are not mapped.
    const items = Array.isArray(content) ? (content as ContentItem[]) : []
    const textBlocks = items.filter(isTextItem).map(item => item.text).filter(text => text !== '')
    const uses: CcToolUseOp[] = []
    for (const item of items) {
      if (item.type !== 'tool_use') continue
      if (typeof item.id !== 'string' || typeof item.name !== 'string') continue
      uses.push({ id: item.id, name: item.name, input: item.input })
    }
    if (textBlocks.length === 0 && uses.length === 0) {
      dropped++
      continue
    }
    ops.push({
      kind: 'assistant',
      uuid,
      time: stamped,
      model: typeof line.message?.model === 'string' ? line.message.model : undefined,
      textBlocks,
      toolUses: uses,
      usage: asUsage(line),
    })
    toolUses += uses.length
  }

  if (unparseable > 0) warnings.push(`${unparseable} unparseable line(s)`)
  return {
    // Every envelope line carries sessionId; the file name is only a fallback.
    sessionUuid: sessionId ?? basename(file).replace(/\.jsonl$/, ''),
    cwd,
    createdAt,
    ops,
    counts: { lines, dropped, humanPrompts, toolUses },
    warnings,
  }
}
