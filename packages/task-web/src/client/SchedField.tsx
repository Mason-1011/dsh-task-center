/**
 * The board's scheduling field, embedded in the task detail: pick one of the
 * task's sessions (holder first, then history), content (default `cont`), a
 * due time with quick chips, and 定时 — the send lands in the same store the
 * session page's surfaces read. The selected session's sends list below with
 * cancel on every unsettled row. The field stays hidden when the sched
 * plugin is absent (its RPC channel is not installed) or the task has no
 * session to target.
 * @module dsh-task-center-task-web/client/SchedField
 */

import { useEffect, useState } from 'react'
import { Button, IconChevronDownOutline14, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SchedCancelResult, SchedCreateResult, SchedListResult, SchedSend } from 'dsh-task-center-task-sched'
import type { ConnectionService } from './context.ts'
import { callApi } from './api.ts'
import { localWhen, nextMorning9, toLocalInput } from './time.ts'

/** Status label per send lifecycle. */
const STATUS_LABEL: Readonly<Record<SchedSend['status'], string>> = {
  pending: '等待中',
  firing: '发送中',
  fired: '已发送',
  failed: '失败',
}

/** Quick-time chip: label + factory of the target instant from now. */
const CHIPS: readonly { readonly label: string; readonly at: (now: Date) => Date }[] = [
  { label: '+5 分', at: now => new Date(now.getTime() + 5 * 60_000) },
  { label: '+30 分', at: now => new Date(now.getTime() + 30 * 60_000) },
  { label: '+1 时', at: now => new Date(now.getTime() + 3_600_000) },
  { label: '明早 9 点', at: now => nextMorning9(now) },
]

/** The scheduling field for one task's sessions. */
export function SchedField(props: { connection: ConnectionService; sessions: readonly string[] }) {
  const [target, setTarget] = useState(props.sessions[0] ?? '')
  const [content, setContent] = useState('cont')
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 5 * 60_000)))
  const [sends, setSends] = useState<readonly SchedSend[] | undefined>()
  const [absent, setAbsent] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSends(undefined)
    setAbsent(false)
    void callApi<SchedListResult>(props.connection, 'schedList', {}, 'task-sched').then(result => {
      if (cancelled) return
      // No sched channel installed: the field simply does not render.
      if (result.ok === false && result.code === 'RPC_TRANSPORT') setAbsent(true)
      else if (result.ok === false) setError(`${result.code}: ${result.message}`)
      else setSends(result.sends)
    })
    return () => { cancelled = true }
  }, [props.connection])

  if (absent || props.sessions.length === 0) return null
  const mine = (sends ?? []).filter(send => send.sessionId === target)

  const submit = async (): Promise<void> => {
    if (busy) return
    const parsed = new Date(when)
    if (when.trim() === '' || Number.isNaN(parsed.getTime())) {
      setError('发送时间无效')
      return
    }
    setBusy(true)
    try {
      const result = await callApi<SchedCreateResult>(
        props.connection, 'schedCreate', { sessionId: target, content: content.trim(), scheduledAt: parsed.toISOString() }, 'task-sched',
      )
      if (result.ok === false) {
        setError(`${result.code}: ${result.message}`)
        return
      }
      setError(undefined)
      const listed = await callApi<SchedListResult>(props.connection, 'schedList', {}, 'task-sched')
      if (listed.ok) setSends(listed.sends)
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (sendId: string): Promise<void> => {
    const result = await callApi<SchedCancelResult>(props.connection, 'schedCancel', { sendId }, 'task-sched')
    if (result.ok === false) setError(`${result.code}: ${result.message}`)
    else setError(undefined)
    const listed = await callApi<SchedListResult>(props.connection, 'schedList', {}, 'task-sched')
    if (listed.ok) setSends(listed.sends)
  }

  return (
    <div className="task-web-field">
      <span className="task-web-field-label">定时发送(到点后以用户消息发进所选会话)</span>
      <div className="task-web-sched">
        <span className="task-web-select-wrap">
          <select value={target} onChange={event => setTarget(event.target.value)}>
            {props.sessions.map(sessionId => (
              <option key={sessionId} value={sessionId}>{sessionId}</option>
            ))}
          </select>
          <IconChevronDownOutline14 size={14} />
        </span>
        <Input value={content} onChange={event => setContent(event.target.value)} placeholder="cont" />
        <input
          type="datetime-local"
          className="task-web-datetime"
          value={when}
          onChange={event => setWhen(event.target.value)}
        />
        {CHIPS.map(chip => (
          <button
            key={chip.label}
            type="button"
            className="task-web-chip"
            onClick={() => setWhen(toLocalInput(chip.at(new Date())))}
          >
            {chip.label}
          </button>
        ))}
        <Button size="sm" variant="primary" disabled={busy || content.trim() === ''} onClick={() => { void submit() }}>
          定时
        </Button>
      </div>
      {error !== undefined && <div className="task-web-error">{error}</div>}
      {mine.length > 0 && (
        <div className="task-web-sched-rows">
          {mine.map(send => (
            <div key={send.id} className="task-web-sched-row">
              <span className="task-web-card-id">{send.sessionId.slice(0, 8)}</span>
              <span>{send.content}</span>
              <span className="task-web-sched-when">{localWhen(send.scheduledAt)}</span>
              <span className="task-web-sched-status">
                {STATUS_LABEL[send.status]}{send.status === 'failed' && send.note !== undefined ? `:${send.note}` : ''}
              </span>
              {send.status !== 'firing' && send.status !== 'fired' && (
                <Button size="sm" variant="ghost" onClick={() => { void cancel(send.id) }}>取消</Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
