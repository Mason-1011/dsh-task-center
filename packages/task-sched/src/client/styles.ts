/**
 * The scheduler's stylesheet, injected once per document as
 * `<style data-plugin-css="task-sched">` (the shipped modules' style-injection
 * idiom). Every color/typography decision is a `--dsw-*` shell token, so the
 * surfaces follow the ambient theme; everything is scoped under `task-sched-`
 * classes so nothing leaks into the shell's CSS.
 * @module @task-center/task-sched/client/styles
 */

const CSS = `

/* Same as task-web: the shell has no global box-sizing, and width+padding
   composites here (dock, chips, modal rows) must not overflow their row. */
[class^='task-sched-'], [class*=' task-sched-'] { box-sizing: border-box; }
/* ── form fields inside the modal ── */
.task-sched-body { display: flex; flex-direction: column; gap: 12px; }
.task-sched-field { display: flex; flex-direction: column; gap: 4px; }
.task-sched-field-label { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); }
.task-sched-error { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-state-error-primary); }
/* the when row: native datetime-local in the Input idiom + quick chips */
.task-sched-when { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.task-sched-input {
  height: 32px; padding: 0 8px;
  font: var(--dsw-font-xs-13); font-family: inherit;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  color-scheme: light dark;
}
.task-sched-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.task-sched-chip {
  height: 24px; padding: 0 10px;
  font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px; cursor: pointer; font-family: inherit;
}
.task-sched-chip:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }

/* ── send rows (modal) ── */
.task-sched-rows { display: flex; flex-direction: column; gap: 4px; }
.task-sched-row {
  display: flex; align-items: center; gap: 8px; font: var(--dsw-font-xs-13);
  padding: 4px 8px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
}
.task-sched-row-content { color: var(--dsw-alias-label-primary); word-break: break-word; }
.task-sched-row-when {
  color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.task-sched-row-status { color: var(--dsw-alias-label-tertiary); margin-left: auto; }
/* width override must out-specify the module class — double the class */
.task-sched-modal.task-sched-modal { width: min(520px, 100%); max-height: calc(100vh - 48px); }

/* ── the dock row above the composer ── */
.task-sched-dock {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary);
}
.task-sched-dock-label { color: var(--dsw-alias-label-tertiary); }
/* dock label and the header button pair the clock glyph with their text */
.task-sched-dock-label { display: inline-flex; align-items: center; gap: 3px; }
.task-sched-dock-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 8px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
}
.task-sched-dock-cancel {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; padding: 0;
  color: var(--dsw-alias-label-tertiary); background: transparent;
  border: none; border-radius: 6px; cursor: pointer;
}
.task-sched-dock-cancel:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
`

/** Inject the stylesheet once per document; a no-op outside a DOM. */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="task-sched"]') !== null) return
  const element = document.createElement('style')
  element.setAttribute('data-plugin-css', 'task-sched')
  element.textContent = CSS
  document.head.append(element)
}
