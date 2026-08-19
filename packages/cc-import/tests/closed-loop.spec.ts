/**
 * The closed loop this package exists for: cc-import materializes the
 * fixtures as real sessions under a temp root, then a fresh extractor boot
 * (the full production composition + task-source) sweeps that root — the plan
 * fixture births a plan-tier candidate model-free, the chat fixture rides one
 * summarizer session (mocked route) into a summary-tier candidate, and the
 * edge fixture stays silent. All judgment belongs to the extractor's gates;
 * none of it lives here.
 * @module @task-center/cc-import/tests/closed-loop
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionStore } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import * as TaskLocal from '@task-center/task-local'
import * as TaskSource from '@task-center/task-source'
import type { Config } from '@task-center/task-source'
import { parseCcSession } from '../src/parse.ts'
import { mapCcSession } from '../src/map.ts'
import { ccSessionId, materializeSessions } from '../src/materialize.ts'
import type { MaterializeInput } from '../src/materialize.ts'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** Extractor config over the mocked route; fast polls so ticks land in time. */
function sourceConfig(route: string): Config {
  return {
    pollSeconds: 0.05,
    idleHours: 3,
    agent: { provider: route, model: 'm' },
    summariesPerTick: 3,
    transcriptEvents: 10,
  }
}

/** Adapter that answers every request with one fixed assistant text. */
class VerdictAdapter extends LlmAdapter {
  readonly inputs: string[] = []

  constructor(private readonly answer: string) {
    super()
  }

  providerInfo(provider: string) {
    return { id: provider, name: `verdict ${provider}` }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages.find(message => message.role === 'user')?.content
      .find(block => block.type === 'text')
    if (text !== undefined && text.type === 'text') this.inputs.push(text.text)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const TASK_VERDICT = '{"objective": "首屏加载时间降到 1 秒以内", "acceptance": "本地刷新后 Lighthouse 性能分 ≥ 90", "note": "用户自己搁置的意图"}'

describe('cc-import closed loop', () => {
  it('materialized sessions birth candidates through the extractor alone', { timeout: 20_000 }, async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'cc-import-loop-sessions-'))
    const marksRoot = await mkdtemp(join(tmpdir(), 'cc-import-loop-marks-'))
    roots.push(sessionsRoot, marksRoot)

    const inputs: MaterializeInput[] = []
    for (const name of ['plan-session.jsonl', 'chat-session.jsonl', 'edge.jsonl']) {
      const session = await parseCcSession(resolve(import.meta.dirname, 'fixtures', name))
      inputs.push({
        id: ccSessionId(session.sessionUuid),
        cwd: session.cwd,
        createdAt: session.createdAt,
        events: mapCcSession(session).events,
      })
    }
    // 'none' so the extractor boot (also 'none') accepts the same root encoding.
    // All three materialize — the edge session births nothing, not by being
    // skipped here but by the extractor's own gates finding no signal in it.
    const report = await materializeSessions(inputs, { root: sessionsRoot, compression: 'none' })
    expect(report.created).toHaveLength(3)
    expect(report.skipped).toEqual([])
    const planId = ccSessionId('11111111-aaaa-4bbb-8ccc-000000000001')
    const chatId = ccSessionId('22222222-aaaa-4bbb-8ccc-000000000002')
    const edgeId = ccSessionId('33333333-aaaa-4bbb-8ccc-000000000003')

    const ctx = new Context()
    const fibers = [
      await ctx.plugin(Storage),
      await ctx.plugin(StorageJson, { root: marksRoot }),
      await ctx.plugin(StorageDomain, { backend: 'json', routes: {} }),
      await ctx.plugin(LlmRuntime),
      await ctx.plugin(SessionStore),
      await ctx.plugin(SystemPrompt, {}),
      await ctx.plugin(ToolRuntime, {}),
      await ctx.plugin(AgentRegistry),
      await ctx.plugin(AgentLoop, { agents: [] }),
      await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none', writeBatchMaxDelayMs: 1 }),
      await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 }),
      await ctx.plugin(TaskLocal),
    ]
    try {
      const adapter = new VerdictAdapter(TASK_VERDICT)
      ctx.llm.registerAdapter(['summary-route'], adapter)
      await ctx.plugin(TaskSource, sourceConfig('summary-route'))

      // Plan tier births model-free during the sweep; the idle chat fixture
      // runs one summarizer session on a tick after the sweep queues it.
      await until(() => ctx.tasks.candidates().length === 2)
      const origins = new Set(ctx.tasks.candidates().map(view => `${view.record.origin.sessionId}:${view.record.origin.tier}`))
      expect(origins).toEqual(new Set([`${planId}:plan`, `${chatId}:summary`]))
      const planCandidate = ctx.tasks.candidates().find(view => view.record.origin.sessionId === planId)
      expect(planCandidate?.record.objective).toBe('构建提速')

      // Exactly one model run: the plan tier never calls, the edge session is
      // neither structural nor human and never reaches the summarizer.
      const prompts = adapter.inputs.filter(text => text.includes('[task-source]'))
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain('用户: 以后有空把首屏优化一下')
      expect(adapter.inputs.some(text => text.includes('接续上一段上下文的中途会话'))).toBe(false)
      expect(ctx.tasks.candidates().some(view => view.record.origin.sessionId === edgeId)).toBe(false)

      // Let the durable mark writes settle before teardown releases the domain.
      await new Promise(resolve => setTimeout(resolve, 200))
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    }
  })
})

/** Poll until the predicate holds, failing loud past the deadline. */
async function until(predicate: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met before the deadline')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
