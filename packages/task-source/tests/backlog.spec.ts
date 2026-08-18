/**
 * REAL-composition backlog tests over the full persistence stack: sessions
 * authored under a live JSONL write path, then a fresh extractor boot sweeping
 * the stored history — structural tiers birth model-free, chat-only history
 * flows through the summarizer behind the idle gate, machinery sessions are
 * never sources, a failing route backs off without covering ground (and
 * recovers when it works again), and a restart over the same roots re-reads
 * nothing the durable marks already covered.
 * @module @task-center/task-source/tests/backlog
 */

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GoalId } from '@deepseek-ai/dsh-goal'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import * as TaskLocal from '@task-center/task-local'
import { extractSession, isMachinerySession } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import * as TaskSource from '../src/index.ts'

const HOUR = 3_600_000

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

/** Extractor config over the named route; fast polls so ticks land inside tests. */
function sourceConfig(route: string, overrides: Partial<Config> = {}): Config {
  return {
    pollSeconds: 0.05,
    idleHours: 3,
    agent: { provider: route, model: 'm' },
    summariesPerTick: 3,
    transcriptEvents: 10,
    ...overrides,
  }
}

/** Event types on the ordered surface — seeds must mark how they entered it. */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** One event of any type with a fabricated seq, handed the payload verbatim. */
function eventOf<K extends SessionEvent['type']>(type: K, data: SessionEvent<K>['data'], time: number): SessionEvent<K> {
  // The distributive mapped SessionEvent<K> defeats the generic assignability
  // check, so one cast assembles the four-field shape.
  return {
    type, seq: -1, time, data,
    ...SURFACE_TYPES.has(type) ? { surfaceOp: 'append' as const } : {},
  } as SessionEvent<K>
}

/** Renumber a mixed event list into a contiguous log. */
function renumber(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((event, index) => ({ ...event, seq: index }))
}

/** A user/message event from the human. */
function userMessage(text: string, time: number): SessionEvent<'user/message'> {
  return eventOf('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), time)
}

/** An assistant/message event — one model activity record. */
function assistantMessage(text: string, time: number): SessionEvent<'assistant/message'> {
  return eventOf('assistant/message', {
    turn: 1, step: 1,
    message: {
      id: MessageId(`a-${time}`),
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'mock', model: 'mock-model' },
    },
  }, time)
}

/** One goal/create change. */
function goalCreate(objective: string, time: number): SessionEvent<'goal/change'> {
  return eventOf('goal/change', {
    kind: 'goal/change', version: 1, operation: 'create',
    goal: { id: GoalId('g-1'), revision: 1, objective, phase: 'active', maxGoalRounds: 5 },
    roundsStarted: 0, createdAt: time, updatedAt: time,
  }, time)
}

/** One plugin mount handle for reverse-order teardown. */
interface Fiber {
  dispose(): Promise<void>
}

/** Author context: the session store plus a live JSONL write path, nothing else. */
async function bootAuthor(root: string): Promise<{ ctx: Context; fibers: Fiber[] }> {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(SessionStore),
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', writeBatchMaxDelayMs: 1 }),
  ]
  return { ctx, fibers }
}

/** Extractor context: the full production stack — storage, persistence, spine, ledger. */
async function bootExtractor(sessionsRoot: string, marksRoot: string, persona?: string): Promise<{ ctx: Context; fibers: Fiber[] }> {
  const ctx = new Context()
  const fibers = [
    await ctx.plugin(Storage),
    await ctx.plugin(StorageJson, { root: marksRoot }),
    await ctx.plugin(StorageDomain, { backend: 'json', routes: {} }),
    await ctx.plugin(LlmRuntime),
    await ctx.plugin(SessionStore),
    await ctx.plugin(SystemPrompt, persona === undefined ? {} : { persona }),
    await ctx.plugin(ToolRuntime, {}),
    await ctx.plugin(AgentRegistry),
    await ctx.plugin(AgentLoop, { agents: [] }),
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot, compression: 'none', writeBatchMaxDelayMs: 1 }),
    await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 }),
    await ctx.plugin(TaskLocal),
  ]
  return { ctx, fibers }
}

/** Tear a booted stack down in reverse mount order (files and domains release). */
async function shutdown(fibers: Fiber[]): Promise<void> {
  for (const fiber of fibers.reverse()) await fiber.dispose()
}

/** Store one session's history under the author context, then release it. */
async function storeSession(author: { ctx: Context }, id: string, events: readonly SessionEvent[], meta?: { cwd?: string }): Promise<void> {
  author.ctx.sessions.create(SessionId(id), { seed: events, ...meta === undefined ? {} : { meta } })
  // The write path batches; give it a beat before anything reads the files.
  await new Promise(resolve => setTimeout(resolve, 100))
}

/** Poll until the predicate holds, failing loud past the deadline. */
async function until(predicate: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met before the deadline')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Adapter that answers every request with one fixed assistant text. */
class VerdictAdapter extends LlmAdapter {
  /** Every user text this route has seen, probes included. */
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

/** Route whose sessions never complete until `failing` turns off. */
class FlakyAdapter extends LlmAdapter {
  failing = true
  readonly inputs: string[] = []

  providerInfo(provider: string) {
    return { id: provider, name: `flaky ${provider}` }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = options.messages.find(message => message.role === 'user')?.content
      .find(block => block.type === 'text')
    if (text !== undefined && text.type === 'text') this.inputs.push(text.text)
    if (this.failing) throw new Error('route not configured')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: TASK_VERDICT }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: TASK_VERDICT } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

describe('machinery guard', () => {
  it('names exactly the prefixes this family mints', () => {
    for (const id of ['summary-s-1-5', 'wake-abcd12-123', 'patrol-2026-08-18-1']) {
      expect(isMachinerySession(SessionId(id))).toBe(true)
    }
    for (const id of ['s-summary', 'wakeup-1', 's-patrol-followup', 's-1']) {
      expect(isMachinerySession(SessionId(id))).toBe(false)
    }
  })

  it('yields nothing from a machinery session, whatever its transcript', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(TaskService, { contextPackByteLimit: 2000, listDefaultLimit: 20 })
    const events = renumber([
      userMessage('帮我支持暗色模式', 1_000),
      goalCreate('支持暗色模式', 2_000),
    ])
    for (const id of ['summary-s-9-9', 'wake-abcd12-9', 'patrol-2026-09-09-9']) {
      const session = { id: SessionId(id), events }
      expect(await extractSession(ctx, session, 10)).toBeUndefined()
    }
    expect(ctx.tasks.candidates()).toHaveLength(0)
    await fiber.dispose()
  })
})

describe('fresh-install history sweep', () => {
  it('recovers the backlog: structural births now, idle chat summarizes, fresh chat and machinery wait', { timeout: 8_000 }, async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'task-source-sessions-'))
    const marksRoot = await mkdtemp(join(tmpdir(), 'task-source-marks-'))
    roots.push(sessionsRoot, marksRoot)
    const now = Date.now()
    const author = await bootAuthor(sessionsRoot)
    await storeSession(author, 's-goal', renumber([goalCreate('支持暗色模式', now - 4 * HOUR)]))
    await storeSession(author, 's-chat-old', renumber([
      userMessage('以后有空把首屏优化一下,现在先不管', now - 4 * HOUR),
      assistantMessage('好的,先记下这件事。', now - 4 * HOUR + 1),
    ]))
    await storeSession(author, 's-chat-fresh', renumber([
      userMessage('帮我调研一下缓存方案', now),
      assistantMessage('好的,回头说。', now + 1),
    ]))
    // A summarizer session of an earlier era, stored like any other: its
    // transcript is this family's own prompt and must never be a source.
    await storeSession(author, 'summary-s-gone-7', renumber([userMessage('机器会话自身的正文', now - 4 * HOUR)]))
    await shutdown(author.fibers)

    const extractor = await bootExtractor(sessionsRoot, marksRoot)
    const adapter = new VerdictAdapter(TASK_VERDICT)
    extractor.ctx.llm.registerAdapter(['summary-route'], adapter)
    await extractor.ctx.plugin(TaskSource, sourceConfig('summary-route'))

    // The goal tier births model-free during the sweep; the idle chat-only
    // history runs through the summarizer on a tick after the sweep queues it.
    await until(() => extractor.ctx.tasks.candidates().length === 2)
    const origins = new Set(extractor.ctx.tasks.candidates().map(view => `${view.record.origin.sessionId}:${view.record.origin.tier}`))
    expect(origins).toEqual(new Set(['s-goal:goal', 's-chat-old:summary']))
    // Exactly one model run: the fresh chat is not idle, the machinery
    // session is never a source, and the standing goal rides the dedup list.
    const prompts = adapter.inputs.filter(text => text.includes('[task-source]'))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('用户: 以后有空把首屏优化一下')
    expect(prompts[0]).toContain('支持暗色模式')
    expect(adapter.inputs.some(text => text.includes('机器会话自身的正文'))).toBe(false)
    // Let the durable mark writes settle before teardown releases the domain.
    await new Promise(resolve => setTimeout(resolve, 200))
    await shutdown(extractor.fibers)
  })

  it('re-reads no covered ground after a restart over the same roots', { timeout: 8_000 }, async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'task-source-sessions-'))
    const marksRoot = await mkdtemp(join(tmpdir(), 'task-source-marks-'))
    roots.push(sessionsRoot, marksRoot)
    const now = Date.now()
    const author = await bootAuthor(sessionsRoot)
    await storeSession(author, 's-goal', renumber([goalCreate('支持暗色模式', now - 4 * HOUR)]))
    await storeSession(author, 's-chat-old', renumber([
      userMessage('以后有空把首屏优化一下,现在先不管', now - 4 * HOUR),
      assistantMessage('好的,先记下这件事。', now - 4 * HOUR + 1),
    ]))
    await shutdown(author.fibers)

    const first = await bootExtractor(sessionsRoot, marksRoot)
    const firstAdapter = new VerdictAdapter(TASK_VERDICT)
    first.ctx.llm.registerAdapter(['summary-route'], firstAdapter)
    await first.ctx.plugin(TaskSource, sourceConfig('summary-route'))
    await until(() => first.ctx.tasks.candidates().length === 2)
    await new Promise(resolve => setTimeout(resolve, 200))
    await shutdown(first.fibers)
    expect(firstAdapter.inputs.filter(text => text.includes('[task-source]'))).toHaveLength(1)

    // A fresh boot over the same sessions and the same marks: the sweep
    // re-reads nothing covered — no model run, no re-birth, no supersede. The
    // durable ledger carries both candidates across.
    const second = await bootExtractor(sessionsRoot, marksRoot)
    const secondAdapter = new VerdictAdapter(TASK_VERDICT)
    second.ctx.llm.registerAdapter(['summary-route'], secondAdapter)
    await second.ctx.plugin(TaskSource, sourceConfig('summary-route'))
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(secondAdapter.inputs.filter(text => text.includes('[task-source]'))).toHaveLength(0)
    expect(second.ctx.tasks.candidates()).toHaveLength(2)
    await shutdown(second.fibers)
  })

  it('backs off a failing route without covering ground, then flows when the route works', { timeout: 12_000 }, async () => {
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'task-source-sessions-'))
    const marksRoot = await mkdtemp(join(tmpdir(), 'task-source-marks-'))
    roots.push(sessionsRoot, marksRoot)
    const now = Date.now()
    const author = await bootAuthor(sessionsRoot)
    await storeSession(author, 's-chat-old', renumber([
      userMessage('以后有空把首屏优化一下,现在先不管', now - 4 * HOUR),
      assistantMessage('好的,先记下这件事。', now - 4 * HOUR + 1),
    ]))
    await shutdown(author.fibers)

    const extractor = await bootExtractor(sessionsRoot, marksRoot)
    const adapter = new FlakyAdapter()
    extractor.ctx.llm.registerAdapter(['summary-route'], adapter)
    await extractor.ctx.plugin(TaskSource, sourceConfig('summary-route'))

    // An unconfigured route retries with exponential holds: roughly one
    // attempt per doubling window, never one per tick — and the session stays
    // uncovered the whole time.
    await new Promise(resolve => setTimeout(resolve, 400))
    const attempts = () => adapter.inputs.filter(text => text.includes('[task-source]')).length
    const observed = attempts()
    expect(observed).toBeGreaterThanOrEqual(1)
    expect(observed).toBeLessThanOrEqual(4)

    // The route starts working: the still-uncovered session summarizes, and
    // the mark advances only now.
    adapter.failing = false
    await until(() => extractor.ctx.tasks.candidates().length === 1)
    expect(attempts()).toBe(observed + 1)
    await new Promise(resolve => setTimeout(resolve, 200))
    await shutdown(extractor.fibers)
  })

  it('anchors the summarizer session to the source session\'s cwd when the persona renders {{cwd}}', { timeout: 8_000 }, async () => {
    // Deployment assemblies render {{cwd}} in the persona section; a machinery
    // session minted without a cwd fails its first turn before any model call,
    // so the summarizer never judges anything. The machinery session must carry
    // the summarized conversation's own working directory.
    /** Adapter that also captures every text the route saw, prompts included. */
    class CapturingAdapter extends VerdictAdapter {
      readonly seenTexts: string[] = []

      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (options.system !== undefined) this.seenTexts.push(options.system)
        for (const message of options.messages) {
          for (const block of message.content) {
            if (block.type === 'text') this.seenTexts.push(block.text)
          }
        }
        yield* super.stream(options)
      }
    }

    const sessionsRoot = await mkdtemp(join(tmpdir(), 'task-source-sessions-'))
    const marksRoot = await mkdtemp(join(tmpdir(), 'task-source-marks-'))
    roots.push(sessionsRoot, marksRoot)
    const now = Date.now()
    const author = await bootAuthor(sessionsRoot)
    await storeSession(author, 's-chat-old', renumber([
      userMessage('以后有空把首屏优化一下,现在先不管', now - 4 * HOUR),
      assistantMessage('好的,先记下这件事。', now - 4 * HOUR + 1),
    ]), { cwd: sessionsRoot })
    await shutdown(author.fibers)

    const extractor = await bootExtractor(sessionsRoot, marksRoot, '你在 {{cwd}} 里工作。')
    const adapter = new CapturingAdapter(TASK_VERDICT)
    extractor.ctx.llm.registerAdapter(['summary-route'], adapter)
    await extractor.ctx.plugin(TaskSource, sourceConfig('summary-route'))

    // The summarizer completes: the persona rendered, the verdict birthed a
    // candidate — before the cwd anchor, this run failed and backed off forever.
    await until(() => extractor.ctx.tasks.candidates().length === 1)
    const persona = adapter.seenTexts.find(text => text.includes('你在') && text.includes('里工作'))
    expect(persona).toContain(sessionsRoot)
    await new Promise(resolve => setTimeout(resolve, 200))
    await shutdown(extractor.fibers)
  })

  it('re-summarizes after a restart with a fresh machinery session despite a stored failed attempt', { timeout: 12_000 }, async () => {
    // A failed summarizer run persists its machinery session. A deterministic
    // machinery id reused after a restart collides whenever the stored
    // artifact's cwd differs from the retry's anchor (persistence rejects the
    // same id at a different cwd), and the thrown create silently drops the
    // queued backlog. Every attempt therefore mints a fresh id.
    const machineryIds = (ctx: Context): string[] => {
      const ids: string[] = []
      ctx.on('session/created', session => {
        if (isMachinerySession(session.id)) ids.push(session.id)
      })
      return ids
    }
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'task-source-sessions-'))
    const marksRoot = await mkdtemp(join(tmpdir(), 'task-source-marks-'))
    roots.push(sessionsRoot, marksRoot)
    const now = Date.now()
    const author = await bootAuthor(sessionsRoot)
    await storeSession(author, 's-chat-old', renumber([
      userMessage('以后有空把首屏优化一下,现在先不管', now - 4 * HOUR),
      assistantMessage('好的,先记下这件事。', now - 4 * HOUR + 1),
    ]))
    await shutdown(author.fibers)

    // Phase one: the route fails, and the attempt leaves a stored machinery log.
    const first = await bootExtractor(sessionsRoot, marksRoot)
    const firstIds = machineryIds(first.ctx)
    const flaky = new FlakyAdapter()
    first.ctx.llm.registerAdapter(['summary-route'], flaky)
    await first.ctx.plugin(TaskSource, sourceConfig('summary-route'))
    await until(() => flaky.inputs.some(text => text.includes('[task-source]')))
    expect(firstIds.length).toBeGreaterThanOrEqual(1)
    await new Promise(resolve => setTimeout(resolve, 200))
    await shutdown(first.fibers)

    // Phase two: a fresh process over the same roots, route working. The
    // still-uncovered session summarizes on a machinery id no stored artifact
    // owns, and the candidate is born.
    const second = await bootExtractor(sessionsRoot, marksRoot)
    const secondIds = machineryIds(second.ctx)
    const adapter = new VerdictAdapter(TASK_VERDICT)
    second.ctx.llm.registerAdapter(['summary-route'], adapter)
    await second.ctx.plugin(TaskSource, sourceConfig('summary-route'))
    await until(() => second.ctx.tasks.candidates().length === 1)
    expect(secondIds.some(id => firstIds.includes(id))).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 200))
    await shutdown(second.fibers)
  })
})
