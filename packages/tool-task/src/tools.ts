/**
 * The seven model tools over `ctx.tasks`: task_create, task_claim, task_update,
 * task_report, task_patrol, task_query, task_projects. Registered globally
 * like tool-goal; every mutation runs as the calling agent's model actor, so
 * the service writes both ledgers (domain event plus the session's
 * task/change receipt).
 * Spec: docs/design/05-seam-spec.md §6.
 * @module @task-center/tool-task/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { TaskActor, TaskError, TaskStatus, TaskView } from '@task-center/task'
import { TaskId as taskIdOf, ProjectId as projectIdOf } from '@task-center/task'
import {
  internalError,
  LIST_OUTPUT_SCHEMA,
  PROJECTS_OUTPUT_SCHEMA,
  renderValue,
  TASK_OUTPUT_SCHEMA,
  taskToolProject,
  taskToolTask,
  toolError,
} from './view.ts'
import type { TaskToolError, TaskToolListValue, TaskToolValue } from './view.ts'

/** The calling agent's session, or the stable error when no agent called. */
type Caller = { session: Session } | TaskToolError

/** Resolve the calling agent's session; task tools never run outside an agent. */
function caller(exec: ToolRunContext): Caller {
  const agent: Agent | undefined = exec.agent
  if (agent === undefined) return internalError()
  return { session: agent.session }
}

/** Actor for every model-initiated mutation: this agent's session. */
function actor(session: Session): TaskActor {
  return { kind: 'model', sessionId: session.id }
}

/** Success view or mapped error of one service call. */
function value(result: TaskView | TaskError): TaskToolValue {
  return 'code' in result ? toolError(result) : taskToolTask(result)
}

/** Generic, args-only pending presentation shared by the task tools. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Stable guard values keeping their literal codes inside the closed union. */
const missingReason = (): TaskToolError => ({ code: 'invalid_reason', message: 'outcome blocked requires a non-empty reason.' })
const missingCompletionNote = (): TaskToolError => ({ code: 'invalid_note', message: 'outcome review requires a non-empty completion note.' })
const badLimit = (): TaskToolError => ({ code: 'invalid_filter', message: 'limit must be a positive safe integer.' })

const CREATE_DESCRIPTION =
  'Create one durable task. Tasks outlive this chat: they are tracked across sessions until a human '
  + 'approves or rejects the submitted work. objective states the outcome; acceptance lists the concrete '
  + 'criteria a submitted result will be checked against — write them as verifiable statements. '
  + 'parent_task_id links the new task as a subtask of a task you hold (decomposition); if the link is '
  + 'refused the creation is withdrawn and the refusal is returned. project_id assigns the task to a '
  + 'project a human manages — list them with task_projects; assignment may also fail the creation.'

const CLAIM_DESCRIPTION =
  'Claim one todo task for this session and receive its full context pack. Read the pack before working: '
  + 'it is the accumulated progress log from every previous session. Only the holding session may '
  + 'progress, block, or submit; claim fails on a task another live session already holds.'

const UPDATE_DESCRIPTION =
  'Record one progress step on a task this session holds. note says what was just done; next optionally '
  + 'states the immediately planned step. Both land in the task context pack for later sessions. '
  + 'Sending progress also clears a blocked task.'

const REPORT_DESCRIPTION =
  'Report an outcome on a task this session holds. outcome blocked attaches a reason stating exactly '
  + 'what is missing (a credential, a review, an external event); outcome review submits the completed '
  + 'work with a completion note that checks each acceptance criterion. Humans then approve or reject.'

const PATROL_DESCRIPTION =
  'Record one observation on a task without working it: the daily patrol session refreshes where '
  + 'every unfinished task stands. note states the current situation in one line; next optionally '
  + 'states the immediately planned step; blocker optionally names what is stuck. The observation '
  + 'lands in the task context pack but does NOT claim the task, change its status, or refresh its '
  + 'idle clock — a shelved task stays visibly shelved. Legal while a task is held by another session.'

const QUERY_DESCRIPTION =
  'Query tasks by filter. Omit every filter to list current non-archived tasks. parent_task_id instead '
  + 'lists that task\'s live children — use it to watch delegated subtasks. project_id narrows either '
  + 'listing to one project. Use the exact id and revision from the results for claim, update, and '
  + 'report calls.'

const PROJECTS_DESCRIPTION =
  'List the projects a human manages, in creation order. Projects group tasks for the human\'s board; '
  + 'they are created, renamed, and archived by humans only — use an id from this list as task_create\'s '
  + 'project_id and never invent one.'

/**
 * Register the seven task tools on `ctx`.
 * @param ctx - Context carrying `tasks` and `tools`.
 * @returns aggregate disposer removing all seven registrations.
 */
export function registerTaskTools(ctx: Context): () => void {
  const disposers: Array<() => void> = []
  try {
    disposers.push(ctx.tools.register(defineTool({
      name: 'task_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        objective: { type: 'string', required: true, description: 'Outcome the task exists to reach.' },
        acceptance: {
          type: 'string',
          required: true,
          description: 'Verifiable criteria a submitted result is checked against.',
        },
        parent_task_id: {
          type: 'string',
          description: 'Optional exact id of the parent task to link this task under.',
        },
        project_id: {
          type: 'string',
          description: 'Optional exact project id from task_projects to assign the task to.',
        },
      },
      output: { schema: TASK_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec) {
        const who = caller(exec)
        if ('code' in who) return who
        // The birth workspace is a fact of this session's directory, not a
        // model choice — stamped from the session header, never an argument.
        // The seam validates the project reference before appending, so a
        // refused assignment (missing or archived) never creates the task.
        const created = await ctx.tasks.create({
          objective: args.objective,
          acceptance: args.acceptance,
          ...who.session.header.cwd === undefined ? {} : { workspacePath: who.session.header.cwd },
          ...args.project_id === undefined ? {} : { projectId: projectIdOf(args.project_id) },
        }, actor(who.session))
        if ('code' in created) return toolError(created)
        if (args.parent_task_id === undefined) return taskToolTask(created.task)
        const parentId = taskIdOf(args.parent_task_id)
        const parent = ctx.tasks.get(parentId)
        if (parent === undefined) {
          await ctx.tasks.mutate(created.task.record.id, 1, { operation: 'abandon' }, actor(who.session), who.session)
          return toolError({ code: 'TASK_NOT_FOUND', message: 'parent task does not exist' })
        }
        // Link under the parent as this session; a refused link withdraws the child
        // so the tool stays single-effect (the abandon is the same model actor).
        const linked = await ctx.tasks.mutate(parentId, parent.record.revision, {
          operation: 'subtask-add', childId: created.task.record.id,
        }, actor(who.session), who.session)
        if ('code' in linked) {
          await ctx.tasks.mutate(created.task.record.id, 1, { operation: 'abandon' }, actor(who.session), who.session)
          return toolError(linked)
        }
        return taskToolTask(created.task)
      },
      presentCall: args => present('Create task', 'other', args.objective),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'task_claim',
      description: CLAIM_DESCRIPTION,
      parameters: {
        task_id: { type: 'string', required: true, description: 'Exact task id from task_create or task_query.' },
      },
      output: { schema: TASK_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec) {
        const who = caller(exec)
        if ('code' in who) return who
        return value(await ctx.tasks.claim(taskIdOf(args.task_id), who.session, actor(who.session)))
      },
      presentCall: args => present('Claim task', 'other', args.task_id),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'task_update',
      description: UPDATE_DESCRIPTION,
      parameters: {
        task_id: { type: 'string', required: true, description: 'Exact task id of the held task.' },
        revision: {
          type: 'number',
          required: true,
          description: 'Revision the caller last saw; a mismatch returns stale_revision.',
        },
        note: { type: 'string', required: true, description: 'What was just done; must be non-empty.' },
        next: { type: 'string', description: 'Optional immediately planned step.' },
      },
      output: { schema: TASK_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec) {
        const who = caller(exec)
        if ('code' in who) return who
        return value(await ctx.tasks.mutate(taskIdOf(args.task_id), args.revision, {
          operation: 'progress',
          note: args.note,
          ...args.next === undefined ? {} : { next: args.next },
        }, actor(who.session), who.session))
      },
      presentCall: args => present('Update task', 'other', args.note),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'task_report',
      description: REPORT_DESCRIPTION,
      parameters: {
        task_id: { type: 'string', required: true, description: 'Exact task id of the held task.' },
        revision: {
          type: 'number',
          required: true,
          description: 'Revision the caller last saw; a mismatch returns stale_revision.',
        },
        outcome: {
          type: 'string',
          required: true,
          enum: ['blocked', 'review'],
          description: 'blocked parks the task with a reason; review submits it for human approval.',
        },
        reason: {
          type: 'string',
          description: 'Required with outcome blocked: exactly what is missing to continue.',
        },
        completion_note: {
          type: 'string',
          description: 'Required with outcome review: the self-check against every acceptance criterion.',
        },
      },
      output: { schema: TASK_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec) {
        const who = caller(exec)
        if ('code' in who) return who
        if (args.outcome === 'blocked') {
          if (args.reason === undefined || args.reason.trim() === '') {
            return missingReason()
          }
          return value(await ctx.tasks.mutate(taskIdOf(args.task_id), args.revision, {
            operation: 'block',
            reason: { code: 'blocked', message: args.reason },
          }, actor(who.session), who.session))
        }
        if (args.completion_note === undefined || args.completion_note.trim() === '') {
          return missingCompletionNote()
        }
        return value(await ctx.tasks.mutate(taskIdOf(args.task_id), args.revision, {
          operation: 'submit',
          completionNote: args.completion_note,
        }, actor(who.session), who.session))
      },
      presentCall: args => present('Report task', 'other', args.outcome),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'task_patrol',
      description: PATROL_DESCRIPTION,
      parameters: {
        task_id: { type: 'string', required: true, description: 'Exact task id from task_query or the patrol inventory.' },
        revision: {
          type: 'number',
          required: true,
          description: 'Revision the caller last saw; a mismatch returns stale_revision.',
        },
        note: { type: 'string', required: true, description: 'One line on where the task currently stands; must be non-empty.' },
        next: { type: 'string', description: 'Optional immediately planned step.' },
        blocker: { type: 'string', description: 'Optional what is currently stuck, if anything.' },
      },
      output: { schema: TASK_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec) {
        const who = caller(exec)
        if ('code' in who) return who
        // Patrol holds nothing and moves nothing: no holder requirement, and the
        // seam keeps workedAt put so the observation cannot mask shelving.
        return value(await ctx.tasks.mutate(taskIdOf(args.task_id), args.revision, {
          operation: 'patrol',
          note: args.note,
          ...args.next === undefined ? {} : { next: args.next },
          ...args.blocker === undefined ? {} : { blocker: args.blocker },
        }, actor(who.session), who.session))
      },
      presentCall: args => present('Patrol task', 'other', args.note),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'task_query',
      description: QUERY_DESCRIPTION,
      parameters: {
        status: {
          type: 'string',
          enum: ['todo', 'active', 'blocked', 'review', 'done'],
          description: 'Optional exact status filter.',
        },
        workspace_path: { type: 'string', description: 'Optional exact birth-workspace directory filter.' },
        project_id: { type: 'string', description: 'Optional exact project id from task_projects.' },
        parent_task_id: { type: 'string', description: 'Optional exact id; list this task\'s live children.' },
        limit: { type: 'number', description: 'Optional positive safe-integer result cap.' },
      },
      output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
      async execute(args, exec) {
        const who = caller(exec)
        if ('code' in who) return who
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit <= 0)) {
          return badLimit()
        }
        if (args.parent_task_id !== undefined) {
          const parent = ctx.tasks.get(taskIdOf(args.parent_task_id))
          if (parent === undefined) return toolError({ code: 'TASK_NOT_FOUND', message: 'parent task does not exist' })
          return ctx.tasks.children(parent.record.id)
            .filter(child => !child.archived)
            .slice(0, args.limit ?? undefined)
            .map(taskToolTask)
        }
        return ctx.tasks.list({
          ...args.status === undefined ? {} : { status: args.status as TaskStatus },
          ...args.workspace_path === undefined ? {} : { workspacePath: args.workspace_path },
          ...args.project_id === undefined ? {} : { projectId: projectIdOf(args.project_id) },
          ...args.limit === undefined ? {} : { limit: args.limit },
        }).map(taskToolTask)
      },
      presentCall: args => present('Query tasks', 'read', args.status),
    })))

    disposers.push(ctx.tools.register(defineTool({
      name: 'task_projects',
      description: PROJECTS_DESCRIPTION,
      parameters: {},
      output: { schema: PROJECTS_OUTPUT_SCHEMA, render: renderValue },
      async execute(_args, exec) {
        const who = caller(exec)
        if ('code' in who) return who
        return ctx.tasks.projects().map(taskToolProject)
      },
      presentCall: () => present('Query projects', 'read'),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
