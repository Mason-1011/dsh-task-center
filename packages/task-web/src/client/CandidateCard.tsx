/**
 * One 待确认 card: a candidate the source extractor found in an idle session,
 * awaiting the human verdict. 晋升 expands the acceptance input (required —
 * the extractor cannot know the human's done bar) plus an optional objective
 * override; 忽略 is terminal for the origin. No detail surface: everything the
 * human needs is on the card.
 * @module @task-center/task-web/client/CandidateCard
 */

import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CandidateCard as Card } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { boardStore } from './store.ts'

/** The zh label per extraction tier (the dsh record family). */
const TIER_LABEL: Readonly<Record<Card['tier'], string>> = {
  goal: 'goal', plan: '计划', todo: 'todo', summary: '总结',
}

/** One candidate card with its inline promote form and ignore button. */
export function CandidateCardView(props: { connection: ConnectionService; card: Card }) {
  const { card } = props
  const [promoting, setPromoting] = useState(false)
  const [acceptance, setAcceptance] = useState('')
  const [objective, setObjective] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  const promote = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await boardStore.promote(
        props.connection,
        card.id,
        card.revision,
        acceptance.trim(),
        objective.trim() === '' ? undefined : objective.trim(),
      )
      if (result.ok) return
      setError(`${result.code}: ${result.message}`)
    } finally {
      setBusy(false)
    }
  }

  const ignore = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await boardStore.ignore(props.connection, card.id, card.revision)
      if (result.ok) return
      setError(`${result.code}: ${result.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="task-web-card task-web-candidate">
      <span className="task-web-card-meta">
        <span className="task-web-card-id">[{card.id.slice(0, 8)}] r{card.revision}</span>
        <span>来源 {TIER_LABEL[card.tier]} · 会话 {card.sessionId.slice(0, 8)}</span>
      </span>
      <span className="task-web-objective" style={{ display: 'block' }}>{card.objective}</span>
      {card.note !== '' && <span className="task-web-mark" style={{ display: 'block' }}>{card.note}</span>}
      {!promoting && (
        <span className="task-web-actions">
          <Button size="sm" variant="primary" disabled={busy} onClick={() => { setPromoting(true); setError(undefined) }}>
            晋升
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void ignore() }}>
            忽略
          </Button>
        </span>
      )}
      {promoting && (
        <span className="task-web-promote">
          <Input
            autoFocus
            placeholder="验收标准(必填,由人补)"
            value={acceptance}
            onChange={event => setAcceptance(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && acceptance.trim() !== '') void promote()
              if (event.key === 'Escape') setPromoting(false)
            }}
          />
          <Input
            placeholder="覆写目标(可留空)"
            value={objective}
            onChange={event => setObjective(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && acceptance.trim() !== '') void promote()
              if (event.key === 'Escape') setPromoting(false)
            }}
          />
          <span className="task-web-actions">
            <Button size="sm" variant="primary" disabled={busy || acceptance.trim() === ''} onClick={() => { void promote() }}>
              确定晋升
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPromoting(false)}>
              取消
            </Button>
          </span>
        </span>
      )}
      {error !== undefined && <span className="task-web-error" style={{ display: 'block' }}>{error}</span>}
    </div>
  )
}
