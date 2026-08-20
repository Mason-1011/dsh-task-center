/**
 * The quota-aware resume field inside the scheduling modal: choosing 开
 * targets THIS session as the reset-point continuation's landing spot (it
 * rides the scheduled-send channel, like any row armed below), choosing 关
 * returns to the board's default (a fresh wake session unless the board says
 * otherwise — the status line names it). Turning it on also flips the global
 * resume knob when it was off — an armed target with the gate closed would
 * silently never fire. Hidden while task-quota's channel cannot be read
 * (plugin absent or the fetch failed); the board's quota modal stays the
 * other, global entry.
 * @module @task-center/task-sched/client/QuotaResumeField
 */

import { useEffect, useState } from 'react'
import { Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuotaGetResult, QuotaSetResult, QuotaTargetSetResult } from '@task-center/task-quota'
import type { ConnectionService } from './context.ts'
import { callSched } from './api.ts'

/** One line naming the board's current default continuation target. */
function defaultLine(quota: QuotaGetResult): string {
  if (quota.target === 'origin') return '当前默认:撞墙的会话续做'
  if (quota.target === 'session') return `当前默认:指定会话 ${quota.session?.slice(0, 8) ?? ''}`
  return '当前默认:新会话续做'
}

/** The quota resume field for one session's scheduling modal. */
export function QuotaResumeField(props: { connection: ConnectionService; sessionId: string }) {
  const [quota, setQuota] = useState<QuotaGetResult | undefined>()
  const [note, setNote] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void callSched<QuotaGetResult>(props.connection, 'quotaGet', {}, 'task-quota').then(result => {
      if (cancelled) return
      // Unreadable state (absent plugin, failed fetch): the field does not render.
      if (result.ok) setQuota(result)
    })
    return () => { cancelled = true }
  }, [props.connection])

  if (quota === undefined) return null
  const mine = quota.target === 'session' && quota.session === props.sessionId

  const flip = async (on: boolean): Promise<void> => {
    if (busy || on === mine) return
    setBusy(true)
    try {
      let resume = quota.resume
      if (on && !resume) {
        const gate = await callSched<QuotaSetResult>(props.connection, 'quotaSet', { value: true }, 'task-quota')
        if (gate.ok === false) {
          setError(`${gate.code}: ${gate.message}`)
          return
        }
        resume = gate.resume
        setNote('已同时打开自动续做总开关(此前是关)')
      }
      const result = await callSched<QuotaTargetSetResult>(
        props.connection, 'quotaTargetSet', on ? { target: 'session', sessionId: props.sessionId } : { target: 'fresh' }, 'task-quota',
      )
      if (result.ok === false) {
        setError(`${result.code}: ${result.message}`)
        return
      }
      setError(undefined)
      setQuota({
        ...quota,
        resume,
        target: result.target,
        ...result.session === undefined ? {} : { session: result.session },
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="task-sched-field">
      <span className="task-sched-field-label">额度感知续作(开 = 额度恢复后,续做消息自动发进本会话;关 = 按看板设置的默认走)</span>
      <span className="task-sched-when">
        <Pill active={mine} disabled={busy} onClick={() => { void flip(true) }}>开</Pill>
        <Pill active={!mine} disabled={busy} onClick={() => { void flip(false) }}>关</Pill>
        {!mine && <span className="task-sched-row-status">{defaultLine(quota)}</span>}
      </span>
      {note !== undefined && <span className="task-sched-row-status">{note}</span>}
      {error !== undefined && <div className="task-sched-error">{error}</div>}
    </div>
  )
}
