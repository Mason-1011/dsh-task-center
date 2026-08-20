/**
 * The input dock row: one chip per pending send for the open session
 * (content + due time + ✕ to cancel), rendered only while at least one is
 * armed — the quiet case stays visually absent, exactly like an unset timer.
 * @module @task-center/task-sched/client/SchedDock
 */

import { useEffect } from 'react'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionService } from './context.ts'
import { ClockOutline14 } from './icons.tsx'
import { schedStore, useSched } from './store.ts'
import { localWhen } from './time.ts'

/** The dock row above the composer. */
export function SchedDock(props: { connection: ConnectionService; sessionId?: string }) {
  const state = useSched()
  useEffect(() => schedStore.mount(props.connection), [props.connection])
  if (props.sessionId === undefined) return null
  const pending = (state.sends ?? []).filter(send => send.sessionId === props.sessionId && send.status === 'pending')
  if (pending.length === 0) return null
  return (
    <div className="task-sched-dock">
      <span className="task-sched-dock-label">
        <ClockOutline14 size={12} />
        定时发送
      </span>
      {pending.map(send => (
        <span key={send.id} className="task-sched-dock-chip">
          <span className="task-sched-row-content">{send.content}</span>
          <span className="task-sched-row-when">{localWhen(send.scheduledAt)}</span>
          <button
            type="button"
            className="task-sched-dock-cancel"
            aria-label="取消该定时发送"
            title="取消"
            onClick={() => { void schedStore.cancel(props.connection, send.id) }}
          >
            <IconCloseOutline16 size={12} />
          </button>
        </span>
      ))}
    </div>
  )
}
