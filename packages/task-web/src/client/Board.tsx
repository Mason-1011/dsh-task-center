/**
 * The two board surfaces: the sidebar footer entry button (with a ⚠ dot once
 * any open task crosses the stale threshold) and the full-screen kanban
 * overlay — five fixed columns, project filter chips, the stale banner, the
 * creation form, and per-card detail. State lives in the store; these are
 * pure projections.
 * @module @task-center/task-web/client/Board
 */

import { useEffect, useState } from 'react'
import type { TaskCard, TaskStatus } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { CreateForm } from './CreateForm.tsx'
import { DetailPopover } from './DetailPopover.tsx'
import { boardStore, useBoard } from './store.ts'
import { ensureStyles } from './styles.ts'
import { TaskCardView } from './TaskCard.tsx'

/** Fixed column order: 待办 → 进行中 → 阻塞 → 待验收 → 已完成. */
const COLUMNS: readonly { readonly status: TaskStatus; readonly label: string }[] = [
  { status: 'todo', label: '待办' },
  { status: 'active', label: '进行中' },
  { status: 'blocked', label: '阻塞' },
  { status: 'review', label: '待验收' },
  { status: 'done', label: '已完成' },
]

/** Sidebar footer entry: opens the board; ⚠ when the banner is armed. */
export function BoardButton(props: { connection: ConnectionService }) {
  const state = useBoard()
  const stale = state.payload?.stalest !== undefined
  return (
    <button
      type="button"
      className="task-web-open"
      title="任务看板"
      onClick={() => {
        ensureStyles()
        boardStore.openBoard(props.connection)
      }}
    >
      任务看板{stale ? <span className="task-web-dot" /> : null}
    </button>
  )
}

/** Project filter: 'all' | 'none' (无项目) | one project id. */
type Filter = 'all' | 'none' | string

/** The full-screen board overlay; renders nothing while closed. */
export function BoardOverlay(props: { connection: ConnectionService }) {
  const state = useBoard()
  const [filter, setFilter] = useState<Filter>('all')
  const [detailId, setDetailId] = useState<string | undefined>()
  const [creating, setCreating] = useState(false)

  // Esc closes the board (open modals first: their backdrops stop propagation).
  useEffect(() => {
    if (!state.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') boardStore.closeBoard()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [state.open])

  if (!state.open) return null
  const payload = state.payload
  const visible: readonly TaskCard[] = payload === undefined
    ? []
    : payload.tasks.filter(card => {
      if (filter === 'all') return true
      if (filter === 'none') return card.projectId === undefined
      return card.projectId === filter
    })

  return (
    <div className="task-web-overlay">
      <div className="task-web-panel">
        <div className="task-web-head">
          <span className="task-web-title">任务看板</span>
          <div className="task-web-chips">
            <button type="button" className="task-web-chip" data-on={filter === 'all'} onClick={() => setFilter('all')}>全部</button>
            {payload?.projects.map(project => (
              <button
                key={project.id}
                type="button"
                className="task-web-chip"
                data-on={filter === project.id}
                onClick={() => setFilter(project.id)}
              >
                {project.name}{project.archived ? ' · 已归档' : ''} {project.taskCount}
              </button>
            ))}
            <button type="button" className="task-web-chip" data-on={filter === 'none'} onClick={() => setFilter('none')}>无项目</button>
          </div>
          <span className="task-web-spacer" />
          {state.fetchedAt !== undefined && (
            <span className="task-web-fetched">{state.fetchedAt.slice(11, 19)} 拉取</span>
          )}
          <button
            type="button"
            className="task-web-btn"
            disabled={state.loading}
            onClick={() => boardStore.manualRefresh(props.connection)}
          >
            {state.loading ? '刷新中…' : '刷新'}
          </button>
          <button type="button" className="task-web-btn" data-variant="primary" onClick={() => setCreating(true)}>新建任务</button>
          <button type="button" className="task-web-btn" data-variant="ghost" onClick={() => boardStore.closeBoard()}>关闭 (Esc)</button>
        </div>

        {state.error !== undefined && <div className="task-web-notice">看板拉取失败:{state.error}</div>}
        {state.notice !== undefined && <div className="task-web-notice">{state.notice}</div>}
        {payload?.stalest !== undefined && (
          <div className="task-web-banner">
            ⚠ 搁置最久(闲置 {payload.stalest.idleDays} 天)— <code>[{payload.stalest.id.slice(0, 8)}]</code> {payload.stalest.objective}
          </div>
        )}

        <div className="task-web-cols">
          {COLUMNS.map(column => {
            const cards = visible.filter(card => card.status === column.status)
            return (
              <div key={column.status} className="task-web-col">
                <div className="task-web-col-head">
                  <span>{column.label}</span>
                  <span className="task-web-col-count">{cards.length}</span>
                </div>
                <div className="task-web-cards">
                  {cards.map(card => (
                    <TaskCardView key={card.id} connection={props.connection} card={card} onOpenDetail={setDetailId} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>

        {detailId !== undefined && (
          <DetailPopover connection={props.connection} taskId={detailId} onClose={() => setDetailId(undefined)} />
        )}
        {creating && payload !== undefined && (
          <CreateForm
            connection={props.connection}
            projects={payload.projects}
            onDone={() => setCreating(false)}
          />
        )}
      </div>
    </div>
  )
}
