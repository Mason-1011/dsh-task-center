/**
 * Shared REAL-composition boot: the shipped cordis.yml loads through the
 * actual Loader + Include path (workspace sources supplied via the loader's
 * import hook, per the harness's loader-composition test shape) — never a
 * hand-assembled ctx.plugin chain.
 * @module @task-center/shell/tests/boot
 */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as llmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { TaskService } from '@task-center/task'
import * as TaskLocal from '@task-center/task-local'
import * as TaskQuota from '@task-center/task-quota'
import * as TaskReaper from '@task-center/task-reaper'
import * as TaskWake from '@task-center/task-wake'
import * as ToolTask from '@task-center/tool-task'
import * as CommandTask from '@task-center/command-task'
import * as Shell from '../src/index.ts'

const yml = resolve(dirname(fileURLToPath(import.meta.url)), '../cordis.yml')

/** Every package the shipped composition names, resolved to its workspace source. */
const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', LlmRuntime],
  ['@deepseek-ai/dsh-llm-deepseek', llmDeepseek],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', ToolRuntime],
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ['@deepseek-ai/dsh-commands', CommandRuntime],
  ['@deepseek-ai/dsh-storage', Storage],
  ['@deepseek-ai/dsh-storage-json', StorageJson],
  ['@deepseek-ai/dsh-storage-domain', StorageDomain],
  ['@task-center/task', TaskService],
  ['@task-center/task-local', TaskLocal],
  ['@task-center/tool-task', ToolTask],
  ['@task-center/command-task', CommandTask],
  ['@task-center/task-wake', TaskWake],
  ['@task-center/task-quota', TaskQuota],
  ['@task-center/task-reaper', TaskReaper],
  ['@task-center/shell', Shell],
])

/**
 * Boot one composition file on one data root through the real Loader.
 * @param root - Storage root for the ledger.
 * @param composition - Absolute path to the composition yml to include.
 * @returns the booted context.
 */
export async function bootComposition(root: string, composition: string): Promise<Context> {
  process.env['TASK_CENTER_ROOT'] = root
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(composition).href } })
  await ctx.loader.await()
  return ctx
}

/**
 * Boot the shipped composition on one data root through the real Loader.
 * @param root - Storage root for the ledger.
 * @returns the booted context.
 */
export function bootCenter(root: string): Promise<Context> {
  return bootComposition(root, yml)
}

/** One interactive agent over the booted center, for command dispatch. */
export function agentOf(ctx: Context): Agent {
  return ctx.agentLoop.create(SessionId('spec-shell'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
}
