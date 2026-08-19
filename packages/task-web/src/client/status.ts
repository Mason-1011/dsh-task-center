/**
 * Status vocabulary shared by every board surface: the zh label and the
 * official StateDot state that renders beside it. `todo` maps to undefined —
 * the primitive has no neutral state, and an undotted 待办 reads correctly.
 * @module @task-center/task-web/client/status
 */

import type { TaskStatus } from '../wire.ts'

/** StateDot's accepted states. */
export type DotState = 'done' | 'warning' | 'ongoing' | 'error'

/** The zh label per status (column heads, card meta, detail rows). */
export const STATUS_LABEL: Readonly<Record<TaskStatus, string>> = {
  todo: '待办',
  active: '进行中',
  blocked: '阻塞',
  review: '待验收',
  done: '已完成',
}

/** The StateDot state per status; undefined renders no dot. */
export const STATUS_DOT: Readonly<Record<TaskStatus, DotState | undefined>> = {
  todo: undefined,
  active: 'ongoing',
  blocked: 'error',
  review: 'warning',
  done: 'done',
}

/** Chinese category label per known blocked-reason code; unknown codes show verbatim. */
export function blockedLabel(code: string): string {
  if (code === 'quota') return '额度'
  if (code === 'human-blocked') return '人工'
  if (code === 'blocked') return '模型'
  return code
}
