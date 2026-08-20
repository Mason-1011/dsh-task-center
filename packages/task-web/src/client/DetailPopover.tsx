/**
 * Detail modal for one card: full objective/acceptance, project, birth
 * workspace, holder, historical sessions, blocking reason, wake rule, the
 * scheduling field (a timed user message into one of the task's sessions),
 * child rows with status dots, and the context-pack tail over the official
 * CodeBlock. Every session id — holder and history alike — is a chip that
 * jumps the conversation view to it. Fetched on mount; unknown ids render the
 * host's error code.
 * @module dsh-task-center-task-web/client/DetailPopover
 */

import { useEffect, useState } from 'react'
import { Button, CodeBlock, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ShowResult } from '../wire.ts'
import type { ConnectionService } from './context.ts'
import { boardStore } from './store.ts'
import { SchedField } from './SchedField.tsx'
import { STATUS_DOT, STATUS_LABEL, blockedLabel } from './status.ts'
import { localWhen } from './time.ts'

/** One clickable session id chip; jumps the conversation view to it. */
function SessionLink(props: { id: string; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      className="task-web-session-link"
      title="打开该会话"
      onClick={() => props.onOpen(props.id)}
    >
      {props.id}
    </button>
  )
}

/** One task's detail, over the official Modal (widened via doubled class). */
export function DetailPopover(props: { connection: ConnectionService; openSession: (id: string) => void; taskId: string; onClose: () => void }) {
  const [result, setResult] = useState<ShowResult | undefined>()

  useEffect(() => {
    let cancelled = false
    void boardStore.show(props.connection, props.taskId).then(value => {
      if (!cancelled) setResult(value)
    })
    return () => { cancelled = true }
  }, [props.connection, props.taskId])

  return (
    <Modal
      open
      onClose={props.onClose}
      title="任务详情"
      closeLabel="关闭"
      className="task-web-detail-modal"
      contentClassName="task-web-detail-body"
      footer={<Button variant="outline" onClick={props.onClose}>关闭</Button>}
    >
      <div className="task-web-detail">
        {result === undefined && <div className="task-web-lines">载入中…</div>}
        {result?.ok === false && <div className="task-web-error">{result.code}: {result.message}</div>}
        {result?.ok === true && (
          <>
            <div className="task-web-detail-objective">{result.task.objective}</div>
            <div className="task-web-card-meta">
              <span className="task-web-card-id">[{result.task.id.slice(0, 8)}] r{result.task.revision}</span>
              <span>{STATUS_LABEL[result.task.status] ?? result.task.status}{result.task.archived ? ' · 已归档' : ''}</span>
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
            {result.task.workspacePath !== undefined && (
              <div className="task-web-field">
                <span className="task-web-field-label">工作区(出生目录)</span>
                <span className="task-web-lines">{result.task.workspacePath}</span>
              </div>
            )}
            <div className="task-web-field">
              <span className="task-web-field-label">持有会话</span>
              {result.task.holder === undefined
                ? <span className="task-web-lines">无</span>
                : <SessionLink id={result.task.holder} onOpen={props.openSession} />}
            </div>
            {result.task.historySessions !== undefined && (
              <div className="task-web-field">
                <span className="task-web-field-label">历史对话 ({result.task.historySessions.length})</span>
                <div className="task-web-sessions">
                  {result.task.historySessions.map(id => (
                    <SessionLink key={id} id={id} onOpen={props.openSession} />
                  ))}
                </div>
              </div>
            )}
            {result.task.blockedCode !== undefined && (
              <div className="task-web-field">
                <span className="task-web-field-label">阻塞</span>
                <span className="task-web-error">
                  [{blockedLabel(result.task.blockedCode)}] {result.task.blockedMessage ?? ''}
                </span>
              </div>
            )}
            {result.task.wake !== undefined && (
              <div className="task-web-field">
                <span className="task-web-field-label">定时唤醒</span>
                <span className="task-web-lines">
                  {result.task.wake.label}
                  {result.task.wake.nextAt !== undefined && ` · 下次 ${localWhen(result.task.wake.nextAt)}`}
                </span>
              </div>
            )}
            <SchedField
              connection={props.connection}
              sessions={[
                ...result.task.holder === undefined ? [] : [result.task.holder],
                ...(result.task.historySessions ?? []).filter(id => id !== result.task.holder),
              ]}
            />
            {result.children.length > 0 && (
              <div className="task-web-field">
                <span className="task-web-field-label">子任务 ({result.children.length})</span>
                <div className="task-web-children">
                  {result.children.map(child => {
                    const dot = STATUS_DOT[child.status]
                    return (
                      <div key={child.id} className="task-web-child">
                        {dot !== undefined && <StateDot state={dot} size={8} />}
                        <span className="task-web-child-id">[{child.id.slice(0, 8)}] r{child.revision}</span>
                        <span className="task-web-child-objective">{child.objective}</span>
                        <span className="task-web-child-status">
                          {STATUS_LABEL[child.status] ?? child.status}{child.archived ? ' · 已归档' : ''}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            <div className="task-web-field">
              <span className="task-web-field-label">上下文包(尾部 8 行)</span>
              {result.packTail === ''
                ? <span className="task-web-col-empty">(尚无记录)</span>
                : <CodeBlock code={result.packTail} copyLabel="复制" copiedLabel="已复制" />}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
