/**
 * One kanban card: the id/revision/holder meta line, the objective, the
 * shelving markers, and the per-status action row. Reason-requiring actions
 * (打回/阻塞) expand an inline reason input instead of prompting.
 * @module @task-center/task-web/client/TaskCard
 */

import { useState } from 'react'
import type { BoardAction, TaskCard as Card } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { boardStore } from './store.ts'

const STATUS_LABEL: Readonly<Record<Card['status'], string>> = {
  todo: '待办', active: '进行中', blocked: '阻塞', review: '待验收', done: '已完成',
}

/** Actions offered per status; done and archived cards carry none. */
function actionsOf(card: Card): readonly BoardAction[] {
  if (card.archived || card.status === 'done') return []
  if (card.status === 'review') return ['approve', 'reject']
  if (card.status === 'active' || card.status === 'blocked') return ['release', 'abandon', 'block']
  return ['abandon']
}

const ACTION_LABEL: Readonly<Record<BoardAction, string>> = {
  approve: '通过', reject: '打回', block: '阻塞', release: '释放', abandon: '放弃',
}

/** One board card with its inline action row. */
export function TaskCardView(props: { connection: ConnectionService; card: Card; onOpenDetail: (id: string) => void }) {
  const { card } = props
  const [reasonFor, setReasonFor] = useState<BoardAction | undefined>()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (action: BoardAction, text?: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await boardStore.act(props.connection, card.id, card.revision, action, text)
      setReasonFor(undefined)
      setReason('')
    } finally {
      setBusy(false)
    }
  }

  const open = !card.archived && card.status !== 'done'
  const markers: string[] = []
  if (open && card.idleDays >= 1) markers.push(`闲置 ${card.idleDays} 天`)
  if (card.subtaskCount > 0) markers.push(`⊕${card.subtaskCount}`)
  if (card.hasWake === true) markers.push('⏰')

  return (
    <button
      type="button"
      className="task-web-card"
      data-status={card.status}
      data-archived={card.archived}
      onClick={() => { if (reasonFor === undefined) props.onOpenDetail(card.id) }}
    >
      <span className="task-web-card-meta">
        <span className="task-web-card-id">[{card.id.slice(0, 8)}] r{card.revision}</span>
        {card.holder !== undefined && <span>@{card.holder.slice(0, 8)}</span>}
        <span>{STATUS_LABEL[card.status]}{card.archived ? ' · 已归档' : ''}</span>
      </span>
      <span className="task-web-objective" style={{ display: 'block' }}>{card.objective}</span>
      {markers.length > 0 && (
        <span className="task-web-mark" style={{ display: 'block', fontSize: '11px', marginTop: 4 }}>{markers.join(' · ')}</span>
      )}
      {card.blockedMessage !== undefined && card.status === 'blocked' && (
        <span className="task-web-blocked" style={{ display: 'block' }}>{card.blockedCode}: {card.blockedMessage}</span>
      )}
      <span className="task-web-actions" style={{ display: 'flex' }} onClick={event => event.stopPropagation()}>
        {actionsOf(card).map(action => (
          <button
            key={action}
            type="button"
            className="task-web-btn"
            disabled={busy}
            data-variant={action === 'approve' ? 'primary' : action === 'abandon' ? 'danger' : undefined}
            onClick={event => {
              event.stopPropagation()
              if (action === 'reject' || action === 'block') {
                setReasonFor(current => current === action ? undefined : action)
              } else {
                void run(action)
              }
            }}
          >
            {ACTION_LABEL[action]}
          </button>
        ))}
      </span>
      {reasonFor !== undefined && (
        <span className="task-web-reason" style={{ display: 'flex' }} onClick={event => event.stopPropagation()}>
          <input
            className="task-web-input"
            autoFocus
            placeholder={reasonFor === 'reject' ? '打回理由(必填,写入上下文包)' : '阻塞理由(必填)'}
            value={reason}
            onChange={event => setReason(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && reason.trim() !== '') void run(reasonFor, reason.trim())
            }}
          />
          <button
            type="button"
            className="task-web-btn"
            data-variant="primary"
            disabled={busy || reason.trim() === ''}
            onClick={() => { void run(reasonFor, reason.trim()) }}
          >
            确定
          </button>
        </span>
      )}
    </button>
  )
}
