/**
 * `task-shell`: the interactive face of the mission control — one durable
 * agent session behind a line-based REPL. Slash lines dispatch through the
 * command registry (never reaching the model), everything else is one user
 * turn; assistant text and tool calls echo live off the session event stream.
 * The plugin composes the center even without a TTY (tests, pipes): the REPL
 * attaches only to a real terminal.
 * @module @task-center/shell
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createInterface } from 'node:readline'

/** Cordis plugin name. */
export const name = 'task-shell'

/** The command registry and the agent factory must be present. */
export const inject = ['commands', 'agentLoop']

/** Deployment knobs: the model route of the interactive session. */
export interface Config {
  /** Both fields required, mirroring task-wake's route config. */
  readonly agent: { readonly provider: string; readonly model: string }
}

/** Line source and sink of one REPL run; injectable for tests. */
export interface ReplIo {
  /** Yields one input line at a time; ends (or `/exit`) terminates the loop. */
  readonly lines: AsyncIterable<string>
  /** Write one output line (a trailing newline is added). */
  write(line: string): void
  /** Re-display the input marker after a handled line. */
  prompt(): void
}

/** The production terminal REPL over stdin/stdout. */
function terminalIo(): ReplIo {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return {
    lines: rl,
    write: line => { process.stdout.write(`${line}\n`) },
    prompt: () => { rl.prompt(true) },
  }
}

/** Text blocks of one assistant message, concatenated; empty when it had none. */
function assistantText(event: SessionEvent): string {
  if (event.type !== 'assistant/message') return ''
  const blocks = event.data.message.content
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Run the REPL until `/exit` or end of input. Slash lines go to the command
 * registry; plain lines become one user turn on the interactive agent, with
 * assistant text and tool calls echoed live from the session event stream.
 * @param ctx - Context carrying `commands` and the booted center.
 * @param agent - The interactive agent session.
 * @param io - Line source and sink.
 * @returns when the loop ends; never rejects on malformed input.
 */
export async function runRepl(ctx: Context, agent: Agent, io: ReplIo): Promise<void> {
  const signal = new AbortController().signal
  let spoke = false
  const echo = (session: Session, event: SessionEvent): void => {
    if (session.id !== agent.session.id) return
    if (event.type === 'tool/call') {
      io.write(`→ ${event.data.name}`)
      return
    }
    const text = assistantText(event)
    if (text !== '') {
      io.write(text)
      spoke = true
      return
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      io.write(`⚠ 模型请求失败:${event.data.reason.error.message}`)
    }
  }
  const off = ctx.on('session/event', echo)
  try {
    for await (const raw of io.lines) {
      const line = raw.trim()
      if (line === '') {
        io.prompt()
        continue
      }
      if (line === '/exit' || line === '/quit') break
      if (line.startsWith('/')) {
        const execution = await ctx.commands.execute(agent, line, [], signal)
        if (execution === undefined) {
          io.write(`未知命令:${line}。/task 查看任务面板,/exit 退出。`)
        } else if (execution.result.kind === 'error') {
          io.write(`⚠ ${execution.result.text}`)
        } else {
          io.write(execution.result.text ?? '')
        }
        io.prompt()
        continue
      }
      spoke = false
      const idle = agent.whenIdle()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: line }], source: { kind: 'user' } }))
      await idle
      if (!spoke) io.write('(本回合无文本输出)')
      io.prompt()
    }
  } finally {
    off()
  }
}

/**
 * Create the interactive agent and attach the terminal REPL when one exists.
 * @param ctx - Plugin context.
 * @param config - Interactive session model route.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.agent.provider.trim() === '' || config.agent.model.trim() === '') {
    throw new Error('task-shell: agent.provider and agent.model must name the interactive session\'s route')
  }
  const agent = ctx.agentLoop.create(SessionId('shell'), config.agent, { cwd: process.cwd() })
  if (process.stdin.isTTY !== true) return
  void runRepl(ctx, agent, terminalIo()).then(async () => {
    await ctx.fiber.dispose()
    process.exit(0)
  })
}
