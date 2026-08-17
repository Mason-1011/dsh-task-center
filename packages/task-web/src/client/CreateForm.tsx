/**
 * New-task form over the official Modal and Input: objective + acceptance +
 * project dropdown (无项目 default; native select in the Input idiom — the
 * primitives ship no Select). Domain rejections (empty fields, archived
 * project) render inline.
 * @module @task-center/task-web/client/CreateForm
 */

import { useState } from 'react'
import { Button, IconChevronDownOutline14, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
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
    <Modal
      open
      onClose={props.onDone}
      title="新建任务"
      closeLabel="关闭"
      footer={(
        <>
          <Button variant="outline" onClick={props.onDone}>取消</Button>
          <Button
            variant="primary"
            disabled={busy || objective.trim() === '' || acceptance.trim() === ''}
            onClick={() => { void submit() }}
          >
            创建
          </Button>
        </>
      )}
    >
      <div className="task-web-detail">
        <div className="task-web-field">
          <span className="task-web-field-label">目标</span>
          <Input
            autoFocus
            value={objective}
            onChange={event => setObjective(event.target.value)}
            placeholder="要做成什么"
          />
        </div>
        <div className="task-web-field">
          <span className="task-web-field-label">验收</span>
          <Input
            value={acceptance}
            onChange={event => setAcceptance(event.target.value)}
            placeholder="怎么算完成"
          />
        </div>
        <div className="task-web-field">
          <span className="task-web-field-label">项目</span>
          <span className="task-web-select-wrap">
            <select value={projectId} onChange={event => setProjectId(event.target.value)}>
              <option value="">无项目</option>
              {props.projects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.name}{project.archived ? ' · 已归档' : ''}
                </option>
              ))}
            </select>
            <IconChevronDownOutline14 size={14} />
          </span>
        </div>
        {error !== undefined && <div className="task-web-error">{error}</div>}
      </div>
    </Modal>
  )
}
