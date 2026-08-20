/**
 * Package-local glyphs drawn in the dsh ui-primitives idiom — outline,
 * `currentColor`, square 14 px — for concepts the primitives set does not
 * ship (scheduled time). Kept beside the consumers that inline them into
 * text lines; sizing rides the `size` prop like the official icons.
 * @module @task-center/task-sched/client/icons
 */

/** A minimal outline clock: ring + hands, stroked to sit inside a text line. */
export function ClockOutline14({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M7 4V7L9.1 8.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
