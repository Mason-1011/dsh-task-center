/**
 * Model-facing task projection: the canonical value shape of every task tool,
 * its JSON Schema, and the closed tool-error union. Wake rules are not
 * model-visible yet — no tool sets them until task-wake ships.
 * @module @task-center/tool-task/src/view
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { TaskError, TaskErrorCode, TaskView } from '@task-center/task'

/** One task as the model sees it: identity, discipline fields, and the pack. */
export interface TaskToolTask {
  readonly id: string
  readonly revision: number
  readonly status: 'todo' | 'active' | 'blocked' | 'review' | 'done'
  readonly objective: string
  readonly acceptance: string
  readonly workspaceIds: string[]
  readonly holder: string | null
  readonly blockedReason?: { code: string; message: string }
  readonly contextPack: string
}

/** Closed tool-error union; codes are the stable model-facing discriminants. */
export type TaskToolErrorCode =
  | 'invalid_objective'
  | 'invalid_acceptance'
  | 'not_found'
  | 'already_claimed'
  | 'not_claimed'
  | 'stale_revision'
  | 'invalid_note'
  | 'invalid_reason'
  | 'invalid_filter'
  | 'invalid_transition'
  | 'forbidden'
  | 'internal_error'

/** One tool error value. */
export interface TaskToolError {
  readonly code: TaskToolErrorCode
  readonly message: string
}

/** Success value of the single-task tools. */
export type TaskToolValue = TaskToolTask | TaskToolError

/** Success value of task_query. */
export type TaskToolListValue = readonly TaskToolTask[] | TaskToolError

/** Map one seam error to its model-facing code. */
const TOOL_CODES: Readonly<Record<TaskErrorCode, TaskToolErrorCode>> = {
  TASK_NOT_FOUND: 'not_found',
  TASK_STALE_REVISION: 'stale_revision',
  TASK_ALREADY_CLAIMED: 'already_claimed',
  TASK_NOT_CLAIMED: 'not_claimed',
  TASK_FORBIDDEN: 'forbidden',
  TASK_INVALID_TRANSITION: 'invalid_transition',
  TASK_INVALID_NOTE: 'invalid_note',
  TASK_INVALID_REASON: 'invalid_reason',
  TASK_INVALID_OBJECTIVE: 'invalid_objective',
  TASK_INVALID_ACCEPTANCE: 'invalid_acceptance',
  TASK_WAKE_INVALID_RULE: 'invalid_reason',
  TASK_INVALID_FILTER: 'invalid_filter',
}

/** Translate one seam error into the closed tool union. */
export function toolError(error: TaskError): TaskToolError {
  return { code: TOOL_CODES[error.code], message: error.message }
}

/** Stable error for failures not safe to expose. */
export function internalError(): TaskToolError {
  return { code: 'internal_error', message: 'The task operation failed.' }
}

/** Project one task view for the model. */
export function taskToolTask(view: TaskView): TaskToolTask {
  const { record } = view
  return {
    id: record.id,
    revision: record.revision,
    status: record.status,
    objective: record.objective,
    acceptance: record.acceptance,
    workspaceIds: [...record.workspaceIds],
    holder: record.holder === undefined ? null : record.holder,
    ...record.blockedReason === undefined ? {} : {
      blockedReason: { code: record.blockedReason.code, message: record.blockedReason.message },
    },
    contextPack: record.contextPack,
  }
}

/** JSON Schema of {@link TaskToolTask}. */
export const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    status: { type: 'string', required: true, enum: ['todo', 'active', 'blocked', 'review', 'done'] },
    objective: { type: 'string', required: true },
    acceptance: { type: 'string', required: true },
    workspaceIds: { type: 'array', required: true, items: { type: 'string' } },
    holder: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    blockedReason: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    contextPack: { type: 'string', required: true },
  },
} as const

/** Build one exact two-field error schema while preserving its literal code. */
function errorSchema<const C extends string>(code: C) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const ERROR_SCHEMAS = [
  errorSchema('invalid_objective'),
  errorSchema('invalid_acceptance'),
  errorSchema('not_found'),
  errorSchema('already_claimed'),
  errorSchema('not_claimed'),
  errorSchema('stale_revision'),
  errorSchema('invalid_note'),
  errorSchema('invalid_reason'),
  errorSchema('invalid_filter'),
  errorSchema('invalid_transition'),
  errorSchema('forbidden'),
  errorSchema('internal_error'),
] as const

/** Output schema of the four single-task tools. */
export const TASK_OUTPUT_SCHEMA = { oneOf: [TASK_SCHEMA, ...ERROR_SCHEMAS] } as const

/** Output schema of task_query. */
export const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: TASK_SCHEMA },
    ...ERROR_SCHEMAS,
  ],
} as const

/** Deterministic model content for every canonical value. */
export function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  // The ToolRuntime has already validated the value against the lossless-JSON output schema.
  return [{ type: 'text', text: JSON.stringify(value) }]
}
