/**
 * Model-facing task projection: the canonical value shape of every task tool,
 * its JSON Schema, and the closed tool-error union. Wake rules are not
 * model-visible yet — no tool sets them until task-wake ships.
 * @module @task-center/tool-task/src/view
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ProjectView, TaskError, TaskErrorCode, TaskView } from '@task-center/task'

/** One task as the model sees it: identity, discipline fields, and the pack. */
export interface TaskToolTask {
  readonly id: string
  readonly revision: number
  readonly status: 'todo' | 'active' | 'blocked' | 'review' | 'done'
  readonly objective: string
  readonly acceptance: string
  readonly workspaceIds: string[]
  readonly projectId: string | null
  readonly holder: string | null
  readonly blockedReason?: { code: string; message: string }
  readonly subtasks: string[]
  readonly contextPack: string
}

/** One project as the model sees it: human-managed grouping metadata. */
export interface TaskToolProject {
  readonly id: string
  readonly revision: number
  readonly name: string
  readonly archived: boolean
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
  | 'invalid_subtask'
  | 'invalid_project'
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

/** Success value of task_projects. */
export type TaskToolProjectListValue = readonly TaskToolProject[] | TaskToolError

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
  TASK_SUBTASK_SELF: 'invalid_subtask',
  TASK_SUBTASK_CYCLE: 'invalid_subtask',
  TASK_SUBTASK_DUPLICATE: 'invalid_subtask',
  TASK_SUBTASK_NOT_CHILD: 'invalid_subtask',
  PROJECT_NOT_FOUND: 'not_found',
  PROJECT_ALREADY_EXISTS: 'invalid_project',
  PROJECT_INVALID_NAME: 'invalid_project',
  PROJECT_FORBIDDEN: 'forbidden',
  PROJECT_ARCHIVED: 'invalid_project',
  // Candidate codes carry no tool verb: the model face never operates
  // candidates, so one reaching a tool is an internal misuse.
  CANDIDATE_NOT_FOUND: 'internal_error',
  CANDIDATE_ALREADY_EXISTS: 'internal_error',
  CANDIDATE_INVALID_OBJECTIVE: 'internal_error',
  CANDIDATE_INVALID_ACCEPTANCE: 'internal_error',
  CANDIDATE_INVALID_TRANSITION: 'internal_error',
  CANDIDATE_FORBIDDEN: 'internal_error',
  CANDIDATE_DUPLICATE_ORIGIN: 'internal_error',
  CANDIDATE_INVALID_REASON: 'internal_error',
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
    subtasks: [...record.subtasks],
    projectId: record.projectId === undefined ? null : record.projectId,
    contextPack: record.contextPack,
  }
}

/** Project one project view for the model. */
export function taskToolProject(view: ProjectView): TaskToolProject {
  return { id: view.record.id, revision: view.record.revision, name: view.record.name, archived: view.record.archived }
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
    projectId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    holder: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
    blockedReason: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', required: true },
        message: { type: 'string', required: true },
      },
    },
    subtasks: { type: 'array', required: true, items: { type: 'string' } },
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
  errorSchema('invalid_subtask'),
  errorSchema('invalid_project'),
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

/** JSON Schema of {@link TaskToolProject}. */
export const PROJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    revision: { type: 'integer', required: true },
    name: { type: 'string', required: true },
    archived: { type: 'boolean', required: true },
  },
} as const

/** Output schema of task_projects. */
export const PROJECTS_OUTPUT_SCHEMA = {
  oneOf: [
    { type: 'array', items: PROJECT_SCHEMA },
    ...ERROR_SCHEMAS,
  ],
} as const

/** Deterministic model content for every canonical value. */
export function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  // The ToolRuntime has already validated the value against the lossless-JSON output schema.
  return [{ type: 'text', text: JSON.stringify(value) }]
}
