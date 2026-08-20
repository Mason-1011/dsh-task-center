/**
 * One kanban card: the official StateDot + id/revision/holder meta line, the
 * objective, the shelving markers, and the per-status action row over the
 * official Button. Reason-requiring actions (打回/阻塞) expand an inline
 * official Input instead of prompting.
 * @module dsh-task-center-task-web/client/TaskCard
 */

import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BoardAction, TaskCard as Card } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { ClockOutline14 } from './icons.tsx'
import { boardStore } from './store.ts'
import { STATUS_DOT, STATUS_LABEL, blockedLabel } from './status.ts'
import { localWhen } from './time.ts'

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
  const markers: ReactNode[] = []
  if (open && card.idleDays >= 1) markers.push(`闲置 ${card.idleDays} 天`)
  if (card.subtaskCount > 0) markers.push(`子任务 ×${card.subtaskCount}`)
  if (card.wake !== undefined) {
    markers.push(
      <span key="wake" className="task-web-wake">
        <ClockOutline14 size={12} />
        {card.wake.nextAt === undefined ? card.wake.label : localWhen(card.wake.nextAt)}
      </span>,
    )
  }
  const dot = STATUS_DOT[card.status]

  return (
    <button
      type="button"
      className="task-web-card"
      data-status={card.status}
      data-archived={card.archived}
      onClick={() => { if (reasonFor === undefined) props.onOpenDetail(card.id) }}
    >
      <span className="task-web-card-meta">
        {dot !== undefined && <StateDot state={dot} size={8} />}
        <span className="task-web-card-id">[{card.id.slice(0, 8)}] r{card.revision}</span>
        {card.holder !== undefined && <span>@{card.holder.slice(0, 8)}</span>}
        <span>{STATUS_LABEL[card.status]}{card.archived ? ' · 已归档' : ''}</span>
      </span>
      <span className="task-web-objective" style={{ display: 'block' }}>{card.objective}</span>
      {markers.length > 0 && (
        <span className="task-web-mark" style={{ display: 'block' }}>
          {markers.map((marker, index) => <Fragment key={index}>{index > 0 && ' · '}{marker}</Fragment>)}
        </span>
      )}
      {card.status === 'blocked' && card.blockedCode !== undefined && (
        <span className="task-web-blocked" style={{ display: 'block' }}>
          阻塞·{blockedLabel(card.blockedCode)}: {card.blockedMessage ?? ''}
        </span>
      )}
      <span className="task-web-actions" onClick={event => event.stopPropagation()}>
        {actionsOf(card).map(action => (
          <Button
            key={action}
            size="sm"
            variant={action === 'approve' ? 'primary' : 'ghost'}
            disabled={busy}
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
          </Button>
        ))}
      </span>
      {reasonFor !== undefined && (
        <span className="task-web-reason" onClick={event => event.stopPropagation()}>
          <Input
            autoFocus
            placeholder={reasonFor === 'reject' ? '打回理由(必填,写入上下文包)' : '阻塞理由(必填)'}
            value={reason}
            onChange={event => setReason(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && reason.trim() !== '') void run(reasonFor, reason.trim())
            }}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={busy || reason.trim() === ''}
            onClick={() => { void run(reasonFor, reason.trim()) }}
          >
            确定
          </Button>
        </span>
      )}
    </button>
  )
}
