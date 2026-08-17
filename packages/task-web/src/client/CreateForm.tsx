/**
 * New-task form: objective + acceptance + project dropdown (无项目 default).
 * Domain rejections (empty fields, archived project) render inline.
 * @module @task-center/task-web/client/CreateForm
 */

import { useState } from 'react'
import type { CreateResult, ProjectChip } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { boardStore } from './store.ts'

/** The creation modal. */
export function CreateForm(props: { connection: ConnectionService; projects: readonly ProjectChip[]; onDone: () => void }) {
  const [objective, setObjective] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result: CreateResult = await boardStore.create(
        props.connection,
        objective.trim(),
        acceptance.trim(),
        projectId === '' ? undefined : projectId,
      )
      if (result.ok) {
        props.onDone()
        return
      }
      setError(`${result.code}: ${result.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="task-web-modal-backdrop" onClick={props.onDone}>
      <div className="task-web-modal" onClick={event => event.stopPropagation()}>
        <div className="task-web-modal-title">新建任务</div>
        <div className="task-web-form">
          <div className="task-web-field">
            <span className="task-web-field-label">目标</span>
            <input
              className="task-web-input"
              autoFocus
              value={objective}
              onChange={event => setObjective(event.target.value)}
              placeholder="要做成什么"
            />
          </div>
          <div className="task-web-field">
            <span className="task-web-field-label">验收</span>
            <input
              className="task-web-input"
              value={acceptance}
              onChange={event => setAcceptance(event.target.value)}
              placeholder="怎么算完成"
            />
          </div>
          <div className="task-web-field">
            <span className="task-web-field-label">项目</span>
            <select
              className="task-web-input"
              value={projectId}
              onChange={event => setProjectId(event.target.value)}
            >
              <option value="">无项目</option>
              {props.projects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.name}{project.archived ? ' · 已归档' : ''}
                </option>
              ))}
            </select>
          </div>
          {error !== undefined && <div className="task-web-error">{error}</div>}
          <div className="task-web-form-actions">
            <button type="button" className="task-web-btn" data-variant="ghost" onClick={props.onDone}>取消</button>
            <button
              type="button"
              className="task-web-btn"
              data-variant="primary"
              disabled={busy || objective.trim() === '' || acceptance.trim() === ''}
              onClick={() => { void submit() }}
            >
              创建
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
