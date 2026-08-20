/**
 * The kanban's stylesheet, injected once per document as
 * `<style data-plugin-css="task-web">` (the shipped modules' style-injection
 * idiom — the loader auto-claims tagged styles). Every color/typography
 * decision is a `--dsw-*` shell token, so the board follows the ambient theme
 * (light and dark) for free; radii and spacing are literal px per the shell's
 * own convention (controls 8, panels 24). Everything is scoped under
 * `task-web-` classes so the board can never leak into the shell's CSS.
 * @module @task-center/task-web/client/styles
 */

const CSS = `

/* The shell sets no global box-sizing (its primitives declare their own), so
   width+padding composites here must say it themselves — without this every
   card renders 22px wider than its column and each column grows a horizontal
   scrollbar. Attribute selectors cover every element carrying our classes. */
[class^='task-web-'], [class*=' task-web-'] { box-sizing: border-box; }
/* ── sidebar footer entry (icon-only in the collapsed rail, full row when wide) ── */
.task-web-entry {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  width: 100%; height: 49px; padding: 0 12px;
  font: var(--dsw-font-s-14); color: var(--dsw-alias-label-primary);
  background: transparent; border: none; border-radius: 12px;
  cursor: pointer; font-family: inherit;
}
.task-web-entry:hover { background: var(--dsw-alias-interactive-bg-hover-solid); }
.task-web-entry-rail {
  width: 36px; height: 36px; padding: 0; justify-content: center;
  border-radius: 999px; margin: 0 auto;
}
.task-web-entry-dot {
  position: absolute; top: 5px; right: 5px;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
}

/* ── board overlay: the settings-modal surface language ── */
.task-web-overlay {
  position: fixed; inset: 0; z-index: 60; pointer-events: auto;
  background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur);
  display: flex; align-items: center; justify-content: center; padding: 24px;
  font-family: var(--dsw-font-family);
}
.task-web-panel {
  width: min(1280px, 95vw); height: min(880px, 93vh);
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-inverted); border-radius: 24px;
  box-shadow: var(--dsw-shadow-lv3); overflow: hidden;
}
.task-web-head {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  min-height: 49px; padding: 10px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.task-web-title { font: var(--dsw-font-s-strong-14); color: var(--dsw-alias-label-primary); }
.task-web-chips { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.task-web-chip-count {
  color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums; margin-left: 4px;
}
.task-web-spacer { flex: 1; }
.task-web-fetched {
  font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums;
}
/* the modal-close idiom: 28px square, radius 8, quiet until hovered */
.task-web-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0;
  color: var(--dsw-alias-label-secondary); background: transparent;
  border: none; border-radius: 8px; cursor: pointer;
}
.task-web-icon-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

/* ── persistent conditions (fetch failure) — standing rows, not toasts ── */
.task-web-notice {
  margin: 10px 16px 0; font: var(--dsw-font-xs-13);
  color: var(--dsw-alias-state-error-primary);
}
/* ── the stale banner: the shell's warn idiom — tinted tertiary bg (the only
   warn token that flips with the theme), label-token text, warn color on the
   icon only (warn-primary/secondary are static ambers and never legible as
   text on their own scale) ── */
.task-web-banner {
  display: flex; align-items: center; gap: 8px;
  margin: 10px 16px 0; padding: 8px 12px;
  font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-state-warn-tertiary);
  border-radius: 8px;
}
.task-web-banner code { font-family: var(--ds-font-family-code); font-size: 12px; }
.task-web-banner svg { flex: none; color: var(--dsw-alias-state-warn-label); }

/* ── columns ── */
.task-web-cols {
  flex: 1; min-height: 0; display: flex; gap: 10px;
  padding: 16px; overflow: auto;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.task-web-col { flex: 1 1 0; min-width: 208px; display: flex; flex-direction: column; gap: 8px; }
.task-web-col-head {
  display: flex; align-items: center; gap: 6px;
  font: var(--dsw-font-xxs-strong-12); color: var(--dsw-alias-label-tertiary);
  padding: 0 2px;
}
.task-web-col-head svg { flex: none; }
.task-web-col-count {
  margin-left: auto; font-weight: 400; color: var(--dsw-alias-label-caption);
  font-variant-numeric: tabular-nums;
}
.task-web-cards {
  display: flex; flex-direction: column; gap: 8px; overflow-y: auto; padding-bottom: 2px;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.task-web-col-empty {
  font: var(--dsw-font-xs-13); color: var(--dsw-alias-label-tertiary); padding: 4px 2px;
}

/* ── one card: the shell's interactive-row idiom ── */
.task-web-card {
  text-align: left; font-family: inherit; cursor: pointer;
  display: flex; flex-direction: column; gap: 4px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  padding: 9px 10px; font: var(--dsw-font-xs-13); width: 100%;
}
.task-web-card:hover { background: var(--dsw-alias-interactive-bg-hover); }
.task-web-card[data-status='blocked'] { border-color: var(--dsw-alias-state-error-primary); }
.task-web-card[data-archived='true'] { opacity: .55; }
/* ── the 待确认 inbox: pre-task cards, dashed like a draft column ── */
.task-web-candidates { flex: 0 0 232px; }
.task-web-candidate { border-style: dashed; cursor: default; }
.task-web-candidate:hover { background: var(--dsw-alias-bg-layer-1); }
.task-web-promote { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.task-web-card-meta {
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap;
  font: var(--dsw-font-xxxs-11); color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code);
}
.task-web-card-meta svg { flex: none; }
.task-web-card-id { color: var(--dsw-alias-label-secondary); }
/* warn colors stay on icons per the shell's own usage; marker text is a
   label token so it clears contrast in both themes */
.task-web-mark { color: var(--dsw-alias-label-secondary); }
/* the wake marker pairs the clock glyph with its text on one baseline */
.task-web-wake { display: inline-flex; align-items: center; gap: 3px; }
.task-web-objective { line-height: 1.5; word-break: break-word; }
.task-web-blocked { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.task-web-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.task-web-reason { display: flex; gap: 6px; margin-top: 4px; }

/* ── form fields inside modals ── */
.task-web-field { display: flex; flex-direction: column; gap: 4px; }
.task-web-field-label { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-tertiary); }
.task-web-lines { font: var(--dsw-font-xs-13); line-height: 1.6; word-break: break-word; color: var(--dsw-alias-label-primary); }
.task-web-error { font: var(--dsw-font-xxs-12); color: var(--dsw-alias-state-error-primary); }
/* native select in the Input idiom (no Select primitive ships) */
.task-web-select-wrap {
  position: relative; display: inline-flex; align-items: center;
  height: 32px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.task-web-select-wrap:focus-within { border-color: var(--dsw-alias-brand-primary); }
.task-web-select-wrap select {
  appearance: none; -webkit-appearance: none;
  height: 100%; padding: 0 28px 0 8px; width: 100%;
  font: var(--dsw-font-xs-13); font-family: inherit;
  color: var(--dsw-alias-label-primary); background: transparent;
  border: none; cursor: pointer;
}
.task-web-select-wrap select:focus { outline: none; }
.task-web-select-wrap svg {
  position: absolute; right: 8px; pointer-events: none;
  color: var(--dsw-alias-label-tertiary);
}

/* ── detail modal content (Modal provides the chrome) ── */
.task-web-detail { display: flex; flex-direction: column; gap: 12px; }
/* ── the scheduling field: session select + content + datetime + chips ── */
.task-web-sched { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.task-web-sched .task-web-select-wrap { max-width: 220px; }
.task-web-datetime {
  height: 32px; padding: 0 8px;
  font: var(--dsw-font-xs-13); font-family: inherit;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  color-scheme: light dark;
}
.task-web-datetime:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.task-web-chip {
  height: 24px; padding: 0 10px;
  font: var(--dsw-font-xxs-12); color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px; cursor: pointer; font-family: inherit;
}
.task-web-chip:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.task-web-sched-rows { display: flex; flex-direction: column; gap: 4px; }
.task-web-sched-row {
  display: flex; align-items: center; gap: 8px; font: var(--dsw-font-xs-13);
  padding: 4px 8px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
}
.task-web-sched-when { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-web-sched-status { color: var(--dsw-alias-label-tertiary); margin-left: auto; }
.task-web-detail-objective { font: var(--dsw-font-base-strong-16); color: var(--dsw-alias-label-primary); line-height: 1.5; word-break: break-word; }
/* session ids are jump chips wherever they appear (holder, history, source) */
.task-web-sessions { display: flex; flex-wrap: wrap; gap: 6px; }
.task-web-session-link {
  display: inline-flex; align-items: center; padding: 1px 8px;
  font-family: var(--ds-font-family-code); font-size: 11px;
  color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
  cursor: pointer;
}
.task-web-session-link:hover { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.task-web-children { display: flex; flex-direction: column; gap: 4px; }
.task-web-child {
  display: flex; gap: 8px; align-items: center; font: var(--dsw-font-xxs-12);
  padding: 4px 8px; background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
}
.task-web-child svg { flex: none; }
.task-web-child-id { font-family: var(--ds-font-family-code); font-size: 11px; color: var(--dsw-alias-label-secondary); }
.task-web-child-objective { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); }
.task-web-child-status { color: var(--dsw-alias-label-tertiary); }
/* width override must out-specify the module class — double the class */
.task-web-detail-modal.task-web-detail-modal { width: min(560px, 100%); max-height: calc(100vh - 48px); }
.task-web-detail-body.task-web-detail-body { overflow-y: auto; min-height: 0; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
`

/** Inject the stylesheet once per document; a no-op outside a DOM. */
export function ensureStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-plugin-css="task-web"]') !== null) return
  const element = document.createElement('style')
  element.setAttribute('data-plugin-css', 'task-web')
  element.textContent = CSS
  document.head.append(element)
}
