/**
 * The two board surfaces: the sidebar footer entry button (official checklist
 * glyph, icon-only in the collapsed rail, ⚠ dot once any open task crosses
 * the stale threshold) and the full-screen kanban overlay — five fixed
 * columns, project filter pills, the stale banner, the creation form, and
 * per-card detail. Chrome comes from the official primitives (Button/Pill/
 * StateDot/Toast + icons); state lives in the store, these are projections.
 * @module @task-center/task-web/client/Board
 */

import { useEffect, useRef, useState } from 'react'
import {
  Button,
  IconChecklistOutline14,
  IconCloseOutline16,
  IconPlusOutline16,
  IconRefreshOutline14,
  IconWarningOutline16,
  Pill,
  StateDot,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskCard, TaskStatus } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { CreateForm } from './CreateForm.tsx'
import { DetailPopover } from './DetailPopover.tsx'
import { STATUS_DOT, STATUS_LABEL } from './status.ts'
import { boardStore, useBoard } from './store.ts'
import { ensureStyles } from './styles.ts'
import { TaskCardView } from './TaskCard.tsx'

/** Fixed column order: 待办 → 进行中 → 阻塞 → 待验收 → 已完成. */
const COLUMNS: readonly { readonly status: TaskStatus; readonly label: string }[] = [
  { status: 'todo', label: STATUS_LABEL.todo },
  { status: 'active', label: STATUS_LABEL.active },
  { status: 'blocked', label: STATUS_LABEL.blocked },
  { status: 'review', label: STATUS_LABEL.review },
  { status: 'done', label: STATUS_LABEL.done },
]

/**
 * Sidebar footer entry, one row above the Settings control. Follows the
 * shell's footer-badge idiom: full row with label in the wide column, bare
 * icon in the collapsed rail (the rail is ~35px wide — a text label there
 * collapses to nothing, which is exactly how the first iteration went
 * missing).
 */
export function BoardButton(props: { connection: ConnectionService; wide?: boolean }) {
  const state = useBoard()
  const stale = state.payload?.stalest !== undefined
  const wide = props.wide !== false
  return (
    <button
      type="button"
      className={wide ? 'task-web-entry' : 'task-web-entry task-web-entry-rail'}
      title="任务看板"
      aria-label="任务看板"
      onClick={() => {
        ensureStyles()
        boardStore.openBoard(props.connection)
      }}
    >
      <IconChecklistOutline14 />
      {wide ? <span>任务看板</span> : null}
      {stale ? <span className="task-web-entry-dot" /> : null}
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
  const panelRef = useRef<HTMLDivElement>(null)

  // Esc closes the board only when no modal is up — the primitives' Modal has
  // its own document listener, and one keypress must not close both layers.
  useEffect(() => {
    if (!state.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && detailId === undefined && !creating) boardStore.closeBoard()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [state.open, detailId, creating])

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
      <div className="task-web-panel" ref={panelRef}>
        <div className="task-web-head">
          <span className="task-web-title">任务看板</span>
          <div className="task-web-chips">
            <Pill active={filter === 'all'} onClick={() => setFilter('all')}>全部</Pill>
            {payload?.projects.map(project => (
              <Pill
                key={project.id}
                active={filter === project.id}
                onClick={() => setFilter(project.id)}
              >
                {project.name}{project.archived ? ' · 已归档' : ''}
                <span className="task-web-chip-count">{project.taskCount}</span>
              </Pill>
            ))}
            <Pill active={filter === 'none'} onClick={() => setFilter('none')}>无项目</Pill>
          </div>
          <span className="task-web-spacer" />
          {state.fetchedAt !== undefined && (
            <span className="task-web-fetched">{state.fetchedAt.slice(11, 19)}</span>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefreshOutline14 />}
            disabled={state.loading}
            onClick={() => boardStore.manualRefresh(props.connection)}
          >
            刷新
          </Button>
          <Button variant="primary" size="sm" icon={<IconPlusOutline16 />} onClick={() => setCreating(true)}>
            新建任务
          </Button>
          <button
            type="button"
            className="task-web-icon-btn"
            aria-label="关闭看板"
            title="关闭 (Esc)"
            onClick={() => boardStore.closeBoard()}
          >
            <IconCloseOutline16 size={14} />
          </button>
        </div>

        {state.error !== undefined && <div className="task-web-notice">看板拉取失败:{state.error}</div>}
        {payload?.stalest !== undefined && (
          <div className="task-web-banner">
            <IconWarningOutline16 />
            <span>
              搁置最久(闲置 {payload.stalest.idleDays} 天)— <code>[{payload.stalest.id.slice(0, 8)}]</code> {payload.stalest.objective}
            </span>
          </div>
        )}

        <div className="task-web-cols">
          {COLUMNS.map(column => {
            const cards = visible.filter(card => card.status === column.status)
            const dot = STATUS_DOT[column.status]
            return (
              <div key={column.status} className="task-web-col">
                <div className="task-web-col-head">
                  {dot !== undefined ? <StateDot state={dot} size={8} /> : null}
                  <span>{column.label}</span>
                  <span className="task-web-col-count">{cards.length}</span>
                </div>
                <div className="task-web-cards">
                  {cards.length === 0 && <div className="task-web-col-empty">暂无任务</div>}
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

      {state.notice !== undefined && (
        <Toast
          key={state.noticeSeq}
          text={state.notice}
          icon={<IconWarningOutline16 />}
          anchor={panelRef.current}
          onDone={() => boardStore.clearNotice()}
        />
      )}
    </div>
  )
}
