/**
 * Time rendering and datetime-local conversion for the scheduling surfaces:
 * the `datetime-local` input trades in `YYYY-MM-DDTHH:MM` local strings, and
 * board timestamps are for one-glance scanning, so today's instants drop the
 * date.
 * @module @task-center/task-sched/client/time
 */

/**
 * Localized one-glance rendering of one ISO instant: time-only when it lands
 * today, full date and time otherwise.
 * @param iso - the instant to render.
 * @returns the localized string.
 */
export function localWhen(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return sameDay ? date.toLocaleTimeString() : date.toLocaleString()
}

/**
 * Render one instant as a `datetime-local` input value (local time, minute
 * precision).
 * @param date - the instant to render.
 * @returns the `YYYY-MM-DDTHH:MM` string.
 */
export function toLocalInput(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The next local 09:00 strictly after `now` — tomorrow morning's, unless now
 * is before today's.
 * @param now - the reference instant.
 * @returns the next 9am.
 */
export function nextMorning9(now: Date): Date {
  const today9 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0)
  return today9.getTime() > now.getTime() ? today9 : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0)
}
