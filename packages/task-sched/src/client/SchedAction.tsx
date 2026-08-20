/**
 * The session-page scheduling surfaces. The header action opens the modal:
 * content (default `cont`), a `datetime-local` field with quick chips
 * (+5 分/+30 分/+1 时/明早 9 点), this session's sends below (pending first,
 * settle notes inline), cancel on every unsettled row. The dock row echoes
 * the pending chips above the composer so an armed send is visible without
 * opening anything.
 * @module dsh-task-center-task-sched/client/SchedAction
 */

import { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SchedSend } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { ClockOutline14 } from './icons.tsx'
import { QuotaResumeField } from './QuotaResumeField.tsx'
import { schedStore, useSched } from './store.ts'
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

/** The scheduling modal for one session. */
export function SchedModal(props: { connection: ConnectionService; sessionId: string; onClose: () => void }) {
  const [content, setContent] = useState('cont')
  const [when, setWhen] = useState(() => toLocalInput(new Date(Date.now() + 5 * 60_000)))
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const state = useSched()
  useEffect(() => schedStore.mount(props.connection), [props.connection])
  const mine = (state.sends ?? []).filter(send => send.sessionId === props.sessionId)

  const submit = async (): Promise<void> => {
    if (busy) return
    const parsed = new Date(when)
    if (when.trim() === '' || Number.isNaN(parsed.getTime())) {
      setError('发送时间无效')
      return
    }
    setBusy(true)
    try {
      const result = await schedStore.create(props.connection, props.sessionId, content.trim(), parsed.toISOString())
      if (result.ok) setError(undefined)
      else setError(`${result.code}: ${result.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={props.onClose}
      title={`定时发送 · 会话 ${props.sessionId.slice(0, 8)}`}
      closeLabel="关闭"
      className="task-sched-modal"
      footer={(
        <>
          <Button variant="outline" onClick={props.onClose}>关闭</Button>
          <Button variant="primary" disabled={busy || content.trim() === ''} onClick={() => { void submit() }}>
            定时
          </Button>
        </>
      )}
    >
      <div className="task-sched-body">
        <div className="task-sched-field">
          <span className="task-sched-field-label">发送内容(到点后以用户消息发进本会话)</span>
          <Input value={content} onChange={event => setContent(event.target.value)} placeholder="cont" />
        </div>
        <div className="task-sched-field">
          <span className="task-sched-field-label">发送时间</span>
          <span className="task-sched-when">
            <input
              type="datetime-local"
              className="task-sched-input"
              value={when}
              onChange={event => setWhen(event.target.value)}
            />
            {CHIPS.map(chip => (
              <button
                key={chip.label}
                type="button"
                className="task-sched-chip"
                onClick={() => setWhen(toLocalInput(chip.at(new Date())))}
              >
                {chip.label}
              </button>
            ))}
          </span>
        </div>
        <QuotaResumeField connection={props.connection} sessionId={props.sessionId} />
        {error !== undefined && <div className="task-sched-error">{error}</div>}
        {mine.length > 0 && (
          <div className="task-sched-field">
            <span className="task-sched-field-label">本会话的定时发送 ({mine.length})</span>
            <div className="task-sched-rows">
              {mine.map(send => (
                <div key={send.id} className="task-sched-row">
                  <span className="task-sched-row-content">{send.content}</span>
                  <span className="task-sched-row-when">{localWhen(send.scheduledAt)}</span>
                  <span className={send.status === 'failed' ? 'task-sched-error' : 'task-sched-row-status'}>
                    {STATUS_LABEL[send.status]}
                    {send.status === 'failed' && send.note !== undefined ? `:${send.note}` : ''}
                  </span>
                  {send.status !== 'firing' && send.status !== 'fired' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { void schedStore.cancel(props.connection, send.id) }}
                    >
                      取消
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** The header action: opens the modal, badge counts this session's pending sends. */
export function SchedHeaderAction(props: { connection: ConnectionService; sessionId?: string }) {
  const [open, setOpen] = useState(false)
  const state = useSched()
  useEffect(() => schedStore.mount(props.connection), [props.connection])
  if (props.sessionId === undefined) return null
  const pending = (state.sends ?? []).filter(send => send.sessionId === props.sessionId && send.status === 'pending').length
  return (
    <>
      <Button size="sm" variant="ghost" icon={<ClockOutline14 size={12} />} onClick={() => setOpen(current => !current)}>
        定时{pending > 0 ? ` ·${pending}` : ''}
      </Button>
      {open && <SchedModal connection={props.connection} sessionId={props.sessionId} onClose={() => setOpen(false)} />}
    </>
  )
}
