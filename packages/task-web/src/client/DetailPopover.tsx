/**
 * Detail modal for one card: full objective/acceptance, project, holder,
 * blocking reason, child rows, and the context-pack tail. Fetched on mount;
 * unknown ids render the host's error code.
 * @module @task-center/task-web/client/DetailPopover
 */

import { useEffect, useState } from 'react'
import type { ShowResult } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { boardStore } from './store.ts'

const STATUS_LABEL: Readonly<Record<string, string>> = {
  todo: '待办', active: '进行中', blocked: '阻塞', review: '待验收', done: '已完成',
}

/** One task's detail, overlaid on the board. */
export function DetailPopover(props: { connection: ConnectionService; taskId: string; onClose: () => void }) {
  const [result, setResult] = useState<ShowResult | undefined>()

  useEffect(() => {
    let cancelled = false
    void boardStore.show(props.connection, props.taskId).then(value => {
      if (!cancelled) setResult(value)
    })
    return () => { cancelled = true }
  }, [props.connection, props.taskId])

  return (
    <div className="task-web-modal-backdrop" onClick={props.onClose}>
      <div className="task-web-modal" onClick={event => event.stopPropagation()}>
        {result === undefined && <div className="task-web-lines">载入中…</div>}
        {result?.ok === false && <div className="task-web-error">{result.code}: {result.message}</div>}
        {result?.ok === true && (
          <>
            <div className="task-web-modal-head">
              <span className="task-web-modal-title">{result.task.objective}</span>
              <span className="task-web-fetched">
                [{result.task.id.slice(0, 8)}] r{result.task.revision} · {STATUS_LABEL[result.task.status] ?? result.task.status}
                {result.task.archived ? ' · 已归档' : ''}
              </span>
            </div>
            <div className="task-web-field">
              <span className="task-web-field-label">验收</span>
              <span className="task-web-lines">{result.task.acceptance}</span>
            </div>
            {result.projectName !== undefined && (
              <div className="task-web-field">
                <span className="task-web-field-label">项目</span>
                <span className="task-web-lines">{result.projectName}</span>
              </div>
            )}
            <div className="task-web-field">
              <span className="task-web-field-label">持有会话</span>
              <span className="task-web-lines">{result.task.holder ?? '无'}</span>
            </div>
            {result.task.blockedMessage !== undefined && (
              <div className="task-web-field">
                <span className="task-web-field-label">阻塞</span>
                <span className="task-web-lines">{result.task.blockedCode}: {result.task.blockedMessage}</span>
              </div>
            )}
            {result.children.length > 0 && (
              <div className="task-web-field">
                <span className="task-web-field-label">子任务 ({result.children.length})</span>
                <div className="task-web-children">
                  {result.children.map(child => (
                    <div key={child.id} className="task-web-child">
                      <span className="task-web-card-id">[{child.id.slice(0, 8)}] r{child.revision}</span>
                      <span>{child.objective}</span>
                      <span style={{ color: '#7d8aa0' }}>{STATUS_LABEL[child.status] ?? child.status}{child.archived ? ' · 已归档' : ''}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="task-web-field">
              <span className="task-web-field-label">上下文包(尾部 8 行)</span>
              <div className="task-web-pack">{result.packTail === '' ? '(尚无记录)' : result.packTail}</div>
            </div>
          </>
        )}
        <div className="task-web-form-actions">
          <button type="button" className="task-web-btn" onClick={props.onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}
