/**
 * The two board surfaces: the sidebar footer entry button (official checklist
 * glyph, icon-only in the collapsed rail, ⚠ dot once any open task crosses
 * the stale threshold) and the full-screen kanban overlay — five fixed
 * columns, filter pills (human projects, then non-empty birth-workspace
 * groups; an explicit project wins over a stamp), the stale banner, the
 * creation form, and
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
import { CandidateCardView } from './CandidateCard.tsx'
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

/** Board filter: everything, the ungrouped bucket, one project, or one birth workspace. */
type Filter =
  | { readonly kind: 'all' }
  | { readonly kind: 'none' }
  | { readonly kind: 'project'; readonly id: string }
  | { readonly kind: 'workspace'; readonly path: string }

/** One derived workspace pill group: tasks stamped with this birth directory and no explicit project. */
interface WorkspaceGroup {
  readonly path: string
  readonly count: number
}

/**
 * Derive the workspace pill groups: explicit projects win, so a stamped task
 * under a project counts only there; only non-empty groups appear.
 */
function workspaceGroups(tasks: readonly TaskCard[]): WorkspaceGroup[] {
  const counts = new Map<string, number>()
  for (const card of tasks) {
    if (card.projectId !== undefined || card.workspacePath === undefined) continue
    counts.set(card.workspacePath, (counts.get(card.workspacePath) ?? 0) + 1)
  }
  return [...counts.entries()].map(([path, count]) => ({ path, count }))
}

/** A group's pill label: the directory's last segment, or the full path when basenames collide. */
function workspaceLabel(path: string, all: readonly WorkspaceGroup[]): string {
  const base = path.split('/').filter(Boolean).at(-1) ?? path
  const collision = all.some(group => group !== undefined && group.path !== path
    && (group.path.split('/').filter(Boolean).at(-1) ?? group.path) === base)
  return collision ? path : base
}

/** The full-screen board overlay; renders nothing while closed. */
export function BoardOverlay(props: { connection: ConnectionService; openSession: (id: string) => void }) {
  const state = useBoard()
  const [filter, setFilter] = useState<Filter>({ kind: 'all' })
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
  const workspaces = workspaceGroups(payload?.tasks ?? [])
  const visible: readonly TaskCard[] = payload === undefined
    ? []
    : payload.tasks.filter(card => {
      if (filter.kind === 'all') return true
      if (filter.kind === 'none') return card.projectId === undefined && card.workspacePath === undefined
      if (filter.kind === 'project') return card.projectId === filter.id
      return card.projectId === undefined && card.workspacePath === filter.path
    })

  return (
    <div className="task-web-overlay">
      <div className="task-web-panel" ref={panelRef}>
        <div className="task-web-head">
          <span className="task-web-title">任务看板</span>
          <div className="task-web-chips">
            <Pill active={filter.kind === 'all'} onClick={() => setFilter({ kind: 'all' })}>全部</Pill>
            {payload?.projects.map(project => (
              <Pill
                key={project.id}
                active={filter.kind === 'project' && filter.id === project.id}
                onClick={() => setFilter({ kind: 'project', id: project.id })}
              >
                {project.name}{project.archived ? ' · 已归档' : ''}
                <span className="task-web-chip-count">{project.taskCount}</span>
              </Pill>
            ))}
            {workspaces.map(group => (
              <Pill
                key={group.path}
                title={group.path}
                active={filter.kind === 'workspace' && filter.path === group.path}
                onClick={() => setFilter({ kind: 'workspace', path: group.path })}
              >
                {workspaceLabel(group.path, workspaces)}
                <span className="task-web-chip-count">{group.count}</span>
              </Pill>
            ))}
            <Pill active={filter.kind === 'none'} onClick={() => setFilter({ kind: 'none' })}>无分组</Pill>
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
          {/* The 待确认 inbox rides outside project filters: candidates have
              no project until a human promotes them. */}
          <div className="task-web-col task-web-candidates">
            <div className="task-web-col-head">
              <span>待确认</span>
              <span className="task-web-col-count">{payload?.candidates.length ?? 0}</span>
            </div>
            <div className="task-web-cards">
              {(payload?.candidates.length ?? 0) === 0 && (
                <div className="task-web-col-empty">暂无候选;闲置会话里未完结的 goal 会自动出现在这里</div>
              )}
              {payload?.candidates.map(card => (
                <CandidateCardView key={card.id} connection={props.connection} card={card} openSession={props.openSession} />
              ))}
            </div>
          </div>
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
          <DetailPopover connection={props.connection} openSession={props.openSession} taskId={detailId} onClose={() => setDetailId(undefined)} />
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
