/**
 * Real-model summarizer e2e: two long-idle chat-only sessions — one holding a
 * shelved intent, one a fully answered question — are judged by a DeepSeek
 * summarizer session on the boot sweep. The intent births a summary-tier
 * candidate with a filled acceptance draft; the answered question records a
 * none. Self-skips without DEEPSEEK_API_KEY, matching the harness e2e key
 * policy.
 * @module @task-center/task-source/tests/summary-e2e
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import * as llmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import * as TaskLocal from '@task-center/task-local'
import * as TaskSource from '../src/index.ts'

const root = await mkdtemp(join(tmpdir(), 'task-source-'))
const ctx = new Context()
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A two-message conversation seeded far enough back to be idle at boot. */
function conversation(id: string, userText: string, answerText: string): SessionEvent[] {
  const time = Date.now() - 4 * 3_600_000
  return [
    {
      type: 'user/message' as const, seq: 0, time, surfaceOp: 'append' as const,
      data: createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } }),
    },
    {
      type: 'assistant/message' as const, seq: 1, time: time + 1, surfaceOp: 'append' as const,
      data: {
        turn: 1, step: 1,
        message: {
          id: MessageId(`a-${id}`),
          role: 'assistant',
          content: [{ type: 'text', text: answerText }],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        },
      },
    },
  ]
}

const suite = process.env.DEEPSEEK_API_KEY === undefined ? describe.skip : describe

suite('real-model summary extraction', () => {
  it('judges a shelved intent into a candidate and an answered question into none', { timeout: 300_000 }, async () => {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(llmDeepseek, {})
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json', routes: {} })
    await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
    await ctx.plugin(TaskLocal)

    ctx.sessions.create(SessionId('s-intent'), {
      seed: conversation('s-intent', '以后有空把这个项目的 README 翻译成英文版,现在先不管它', '好的,这件事先搁着。'),
    })
    ctx.sessions.create(SessionId('s-answered'), {
      seed: conversation('s-answered', 'JavaScript 里 == 和 === 有什么区别?', '== 会做类型转换后比较,=== 类型和值都要求相同;日常代码一律用 ===。'),
    })

    // The boot sweep awaits both summarizer runs inside mount.
    await ctx.plugin(TaskSource, {
      pollSeconds: 3600,
      idleHours: 3,
      agent: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      summariesPerTick: 2,
      transcriptEvents: 10,
    })

    const bySession = new Map(ctx.tasks.candidates().map(view => [view.record.origin.sessionId, view]))
    const intent = bySession.get(SessionId('s-intent'))
    expect(intent).toBeDefined()
    expect(intent!.record.status).toBe('pending')
    expect(intent!.record.origin.tier).toBe('summary')
    expect(intent!.record.objective.trim()).not.toBe('')
    expect(intent!.record.acceptance.trim()).not.toBe('')

    // The answered question must not birth a candidate — 宁缺毋滥.
    expect(bySession.has(SessionId('s-answered'))).toBe(false)

    console.log('summary candidates:', JSON.stringify(ctx.tasks.candidates().map(view => ({
      sessionId: view.record.origin.sessionId,
      objective: view.record.objective,
      acceptance: view.record.acceptance,
    })), null, 2))
  })
})
