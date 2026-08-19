/**
 * Parser and mapper units over the fixtures: the drop list is honored, the
 * event log comes back contiguous with surfaceOp on exactly the three surface
 * types, the two structural renames land, TodoWrite's pair is suppressed, and
 * turns stay balanced. The final two layers — what the extractor's own folds
 * will see in the mapped log — are asserted directly against task-source.
 * @module @task-center/cc-import/tests/parse
 */

import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { parseCcSession } from '../src/parse.ts'
import { mapCcSession } from '../src/map.ts'
import { asFoldable, predictSession, summarizePredictions } from '../src/predict.ts'
import { foldApprovedPlan, foldTodos } from '@task-center/task-source'
import type { CcSession } from '../src/parse.ts'

const FIXTURES = resolve(import.meta.dirname, 'fixtures')
const planFile = `${FIXTURES}/plan-session.jsonl`
const chatFile = `${FIXTURES}/chat-session.jsonl`
const edgeFile = `${FIXTURES}/edge.jsonl`

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

describe('parseCcSession', () => {
  it('keeps the plan session to ops and facts', async () => {
    const session = await parseCcSession(planFile)
    expect(session.sessionUuid).toBe('11111111-aaaa-4bbb-8ccc-000000000001')
    expect(session.cwd).toBe('D:\\Projects\\demo')
    expect(session.createdAt).toBe(Date.parse('2026-08-15T10:00:00.000Z'))
    expect(session.counts).toEqual({ lines: 11, dropped: 1, humanPrompts: 1, toolUses: 4 })
    expect(session.ops.map(op => op.kind)).toEqual([
      'human', 'assistant', 'tool-result', 'assistant', 'tool-result',
      'assistant', 'tool-result', 'assistant', 'tool-result', 'assistant',
    ])
    expect(session.ops[0]).toMatchObject({ kind: 'human', text: '帮我把构建提速' })
    expect(session.warnings).toEqual([])
  })

  it('keeps the chat session to one human prompt and one answer', async () => {
    const session = await parseCcSession(chatFile)
    expect(session.counts).toEqual({ lines: 3, dropped: 1, humanPrompts: 1, toolUses: 0 })
    expect(session.cwd).toBe('D:\\Projects\\chat')
    expect(session.ops.map(op => op.kind)).toEqual(['human', 'assistant'])
  })

  it('drops every noise shape the edge fixture packs', async () => {
    const session = await parseCcSession(edgeFile)
    expect(session.counts.lines).toBe(15)
    expect(session.counts.dropped).toBe(11)
    expect(session.counts.humanPrompts).toBe(0)
    expect(session.counts.toolUses).toBe(1)
    expect(session.warnings).toContain('1 unparseable line(s)')
    expect(session.cwd).toBe('D:\\Projects\\edge')
    expect(session.ops.map(op => op.kind)).toEqual([
      'assistant', 'assistant', 'tool-result', 'tool-result', 'assistant',
    ])
    expect(session.ops[2]).toMatchObject({ kind: 'tool-result', callId: 'call_exit1', isError: true })
    expect(session.ops[3]).toMatchObject({ kind: 'tool-result', callId: 'call_x1' })
  })
})

describe('mapCcSession', () => {
  it('maps the plan session to a contiguous balanced log', async () => {
    const { events, warnings } = mapCcSession(await parseCcSession(planFile))
    expect(warnings).toEqual([])
    expect(events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result',
      'assistant/message', 'tool/call', 'tool/result', 'todo/write',
      'assistant/message', 'tool/call', 'tool/result', 'assistant/message', 'turn/end',
    ])
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index))
    for (const event of events) {
      expect('surfaceOp' in event && event.surfaceOp === 'append').toBe(SURFACE_TYPES.has(event.type))
    }
    expect(events[3]!.data).toMatchObject({ name: 'EnterPlanMode', turn: 1, step: 1 })
    expect(events[6]!.data).toMatchObject({ name: 'exit_plan_mode' })
    expect(JSON.parse((events[6]!.data as { arguments: string }).arguments)).toEqual({
      plan: '# 构建提速\n1. 开缓存\n2. 并行化',
      planFilePath: 'D:\\Projects\\demo\\.claude\\plans\\p1.md',
    })
    const resultExit = events[7]!.data as { message: { content: [{ toolCallId: string }] }, error?: unknown }
    expect(resultExit.message.content[0]!.toolCallId).toBe('call_exit1')
    expect(resultExit.error).toBeUndefined()
    expect(events[8]!.data).toEqual({
      todos: [
        { content: '开缓存', status: 'in_progress' },
        { content: '并行化', status: 'pending' },
      ],
    })
    expect(events.at(-1)!.data).toEqual({ turn: 1, reason: { kind: 'completed' } })
    // What the extractor's own folds will see in this log.
    const plan = foldApprovedPlan(asFoldable(events))
    expect(plan).toMatchObject({ title: '构建提速', todos: 'unfinished', activityAfterApproval: true })
    const todos = foldTodos(asFoldable(events))
    expect(todos).toMatchObject({ anchorSeq: 1, anchorText: '帮我把构建提速' })
    expect(todos?.unfinished.map(item => item.content)).toEqual(['开缓存', '并行化'])
  })

  it('maps the chat session to one turn', async () => {
    const { events } = mapCcSession(await parseCcSession(chatFile))
    expect(events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'assistant/message', 'turn/end',
    ])
    const message = events[1]!.data as unknown as { content: [{ text: string }], source: { kind: string } }
    expect(message.content[0]!.text).toBe('以后有空把首屏优化一下')
    expect(message.source.kind).toBe('user')
  })

  it('carries a rejected plan as an errored result and leaves nothing structural', async () => {
    const { events, warnings } = mapCcSession(await parseCcSession(edgeFile))
    expect(events.map(event => event.type)).toEqual([
      'turn/start', 'assistant/message', 'assistant/message', 'tool/call',
      'tool/result', 'assistant/message', 'turn/end',
    ])
    const result = events[4]!.data as {
      message: { content: [{ isError?: boolean }] }
      error?: { name: string; code: string }
    }
    expect(result.message.content[0]!.isError).toBe(true)
    expect(result.error).toEqual({ name: 'ToolError', code: 'TOOL_ERROR' })
    expect(warnings.join('\n')).toContain('orphan tool result call_x1 dropped')
    expect(foldApprovedPlan(asFoldable(events))).toBeUndefined()
    expect(foldTodos(asFoldable(events))).toBeUndefined()
  })

  it('gives assistant messages provider-valid content with tool-call blocks', async () => {
    const { events } = mapCcSession(await parseCcSession(planFile))
    const first = events[2]!.data as {
      message: {
        content: Array<{ type: string; name?: string }>
        source: { kind: string; provider: string; model: string }
      }
    }
    expect(first.message.content).toEqual([
      { type: 'tool-call', id: 'call_enter1', name: 'EnterPlanMode', arguments: '{}' },
    ])
    expect(first.message.source).toEqual({ kind: 'model', provider: 'claude-code', model: 'glm-5.3' })
  })

  it('renames only foldable plans — arrays flatten, other shapes keep the CC name', () => {
    const session: CcSession = {
      sessionUuid: 'shape-test',
      cwd: undefined,
      createdAt: 1,
      counts: { lines: 0, dropped: 0, humanPrompts: 0, toolUses: 0 },
      warnings: [],
      ops: [{
        kind: 'assistant',
        uuid: 'a1',
        time: 1,
        model: 'glm-5.3',
        textBlocks: [],
        toolUses: [
          { id: 'p1', name: 'ExitPlanMode', input: { plan: [{ type: 'text', text: '# 数组计划' }] } },
          { id: 'p2', name: 'ExitPlanMode', input: { plan: 42 } },
        ],
        usage: undefined,
      }],
    }
    const { events } = mapCcSession(session)
    const calls = events.filter(event => event.type === 'tool/call')
      .map(event => event.data as { name: string; arguments: string })
    expect(calls.map(call => call.name)).toEqual(['exit_plan_mode', 'ExitPlanMode'])
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ plan: '# 数组计划' })
    expect(JSON.parse(calls[1]!.arguments)).toEqual({ plan: 42 })
    // The unfolded one is not an approval signal for the extractor's fold.
    expect(foldApprovedPlan(asFoldable(events))).toBeUndefined()
  })
})

describe('predictTier', () => {
  it('predicts the plan fixture births on the plan tier', async () => {
    const session = await parseCcSession(planFile)
    const prediction = predictSession(session, mapCcSession(session).events)
    expect(prediction.prediction).toMatchObject({ tier: 'plan', title: '构建提速', willBirth: true })
    expect(prediction.humanPrompts).toBe(1)
  })

  it('predicts the chat fixture waits for the summarizer, the edge fixture births nothing', async () => {
    const chat = await parseCcSession(chatFile)
    expect(predictSession(chat, mapCcSession(chat).events).prediction).toMatchObject({ tier: 'summary', humanLines: 1 })
    const edge = await parseCcSession(edgeFile)
    expect(predictSession(edge, mapCcSession(edge).events).prediction).toEqual({ tier: 'none', reason: expect.any(String) })
  })

  it('folds a whole run into report totals', async () => {
    const predictions = await Promise.all([planFile, chatFile, edgeFile].map(async file => {
      const session = await parseCcSession(file)
      return predictSession(session, mapCcSession(session).events)
    }))
    expect(summarizePredictions(predictions)).toEqual({
      sessions: 3, planBirths: 1, todoBirths: 0, summaryQueue: 1, noBirth: 1,
    })
  })
})
