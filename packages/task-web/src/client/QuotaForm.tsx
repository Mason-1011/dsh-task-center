/**
 * The quota resume modal: the on/off knob and where the reset-point
 * continuation goes — a fresh wake session (default), the session that hit
 * the wall, or one named session picked from the board's session list; the
 * latter two ride the scheduled-send channel, exactly like a human-scheduled
 * `cont`. Every flip awaits its RPC and re-renders from the returned
 * effective value; failures land inline.
 * @module @task-center/task-web/client/QuotaForm
 */

import { useEffect, useState } from 'react'
import { Button, IconChevronDownOutline14, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuotaGetResult, QuotaSetResult, QuotaTargetSetResult } from '@task-center/task-quota'
import type { SessionOption, SessionsResult } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { callApi } from './api.ts'

/** One picker option's label: id prefix, cwd basename, live marker. */
function optionLabel(session: SessionOption): string {
  const base = (session.cwd ?? '').split('/').filter(Boolean).at(-1) ?? ''
  return `${session.id.slice(0, 8)}${base === '' ? '' : ` · ${base}`}${session.live ? ' · 在运行' : ''}`
}

/** The quota resume settings modal. */
export function QuotaForm(props: {
  connection: ConnectionService
  quota: QuotaGetResult
  onQuota: (quota: QuotaGetResult) => void
  onClose: () => void
}) {
  const [sessions, setSessions] = useState<readonly SessionOption[] | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void callApi<SessionsResult>(props.connection, 'sessions', {}).then(result => {
      if (cancelled) return
      if (result.ok) setSessions(result.sessions)
      else setError(`${result.code}: ${result.message}`)
    })
    return () => { cancelled = true }
  }, [props.connection])

  const flip = async (value: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await callApi<QuotaSetResult>(props.connection, 'quotaSet', { value }, 'task-quota')
      if (result.ok) {
        setError(undefined)
        props.onQuota({ ...props.quota, resume: result.resume })
      } else {
        setError(`${result.code}: ${result.message}`)
      }
    } finally {
      setBusy(false)
    }
  }

  const choose = async (target: 'fresh' | 'origin' | 'session', session: string | undefined): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await callApi<QuotaTargetSetResult>(props.connection, 'quotaTargetSet', { target, sessionId: session }, 'task-quota')
      if (result.ok) {
        setError(undefined)
        props.onQuota({
          ...props.quota,
          target: result.target,
          ...result.session === undefined ? {} : { session: result.session },
        })
      } else {
        setError(`${result.code}: ${result.message}`)
      }
    } finally {
      setBusy(false)
    }
  }

  /** Entering 指定会话 mode needs a session to name; pick the newest offered. */
  const enterNamed = (): void => {
    if (props.quota.target === 'session') return
    const first = sessions?.[0]?.id
    if (first === undefined) {
      setError('会话列表还没拿到或为空,稍后再试')
      return
    }
    void choose('session', first)
  }

  return (
    <Modal
      open
      onClose={props.onClose}
      title="额度自动续做"
      closeLabel="关闭"
      className="task-web-detail-modal"
      contentClassName="task-web-detail-body"
      footer={<Button variant="outline" onClick={props.onClose}>关闭</Button>}
    >
      <div className="task-web-detail">
        <div className="task-web-field">
          <span className="task-web-field-label">自动续做(额度重置后是否自动继续被挂起的任务;对下一次额度墙生效,已挂起的不变)</span>
          <div className="task-web-sched">
            <Pill active={props.quota.resume} disabled={busy} onClick={() => { void flip(true) }}>开</Pill>
            <Pill active={!props.quota.resume} disabled={busy} onClick={() => { void flip(false) }}>关</Pill>
          </div>
        </div>
        <div className="task-web-field">
          <span className="task-web-field-label">续做会话(续做消息发到哪;原会话/指定会话经定时发送通道到点送达,未装 task-sched 时自动回退为新会话唤醒)</span>
          <div className="task-web-sched">
            <Pill active={props.quota.target === 'fresh'} disabled={busy} onClick={() => { void choose('fresh', undefined) }}>新会话(默认)</Pill>
            <Pill active={props.quota.target === 'origin'} disabled={busy} onClick={() => { void choose('origin', undefined) }}>撞墙的会话</Pill>
            <Pill active={props.quota.target === 'session'} disabled={busy} onClick={enterNamed}>指定会话</Pill>
            {props.quota.target === 'session' && (
              <span className="task-web-select-wrap">
                <select
                  value={props.quota.session ?? ''}
                  disabled={busy}
                  onChange={event => { void choose('session', event.target.value) }}
                >
                  {(sessions ?? []).map(session => (
                    <option key={session.id} value={session.id}>{optionLabel(session)}</option>
                  ))}
                </select>
                <IconChevronDownOutline14 size={14} />
              </span>
            )}
          </div>
        </div>
        {error !== undefined && <div className="task-web-error">{error}</div>}
      </div>
    </Modal>
  )
}
