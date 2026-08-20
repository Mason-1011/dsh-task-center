/**
 * `tool-task`: the model face of the task seam. Registers the seven task tools
 * and one system-prompt discipline section, globally like tool-goal.
 * @module dsh-task-center-tool-task
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerTaskTools } from './tools.ts'

export { registerTaskTools } from './tools.ts'
export {
  internalError,
  LIST_OUTPUT_SCHEMA,
  PROJECTS_OUTPUT_SCHEMA,
  PROJECT_SCHEMA,
  renderValue,
  TASK_OUTPUT_SCHEMA,
  TASK_SCHEMA,
  taskToolProject,
  taskToolTask,
  toolError,
} from './view.ts'
export type {
  TaskToolError, TaskToolErrorCode, TaskToolListValue, TaskToolProject, TaskToolProjectListValue, TaskToolTask, TaskToolValue,
} from './view.ts'

/** Cordis plugin name. */
export const name = 'tool-task'

/** The task seam, the tool registry, and the prompt registry must be present. */
export const inject = ['tasks', 'tools', 'systemPrompt']

/** Task discipline, written for the model that must live by it. */
const TASK_DISCIPLINE = [
  '## Task discipline',
  '',
  'Tasks are durable work items tracked across sessions — they outlive this chat.',
  '',
  '- Before working a claimed task, read its `contextPack`: it is the accumulated log of every previous session on that task.',
  '- `task_claim` registers this session as the holder. Only the holding session may `task_update`, `task_report`, or submit; claim fails while another live session holds the task.',
  '- `task_report` with outcome `review` submits work for a human decision. The completion note must state, criterion by criterion, how the result satisfies `acceptance`.',
  '- `task_report` with outcome `blocked` parks the task. The reason must say exactly what is missing — a credential, a review, an external event — not that the work is merely hard.',
  '- Approving and rejecting submitted work is human-only. When a task you hold is rejected, its `contextPack` carries the rejection reason; resume from there.',
  '- `task_patrol` records an observation without working the task: no claim, no status change, and the idle clock keeps running. Use it when asked to take stock of tasks you do not hold.',
].join('\n')

/**
 * Register the task discipline section and the seven tools.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:task', order: 116, text: TASK_DISCIPLINE })
  registerTaskTools(ctx)
}
