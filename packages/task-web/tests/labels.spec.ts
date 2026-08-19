/**
 * Unit spec for the client's pure label/time helpers: the blocked-reason
 * category mapping the blocked column annotates cards with, and the
 * one-glance wake-time rendering (time-only when the instant lands today).
 * @module @task-center/task-web/tests/labels
 */

import { describe, expect, it } from 'vitest'
import { blockedLabel } from '../src/client/status.ts'
import { localWhen } from '../src/client/time.ts'

describe('blockedLabel', () => {
  it('maps the two known codes to Chinese categories and shows unknown codes verbatim', () => {
    expect(blockedLabel('quota')).toBe('额度')
    expect(blockedLabel('human-blocked')).toBe('人工')
    expect(blockedLabel('blocked')).toBe('模型')
    expect(blockedLabel('waiting-on-ci')).toBe('waiting-on-ci')
  })
})

describe('localWhen', () => {
  it('renders a same-day instant as time-only and any other as date and time', () => {
    const now = new Date()
    const laterToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 0, 0).toISOString()
    const nextYear = new Date(now.getFullYear() + 1, 0, 2, 9, 30, 0).toISOString()
    expect(localWhen(laterToday)).toBe(new Date(laterToday).toLocaleTimeString())
    expect(localWhen(nextYear)).toBe(new Date(nextYear).toLocaleString())
  })
})
