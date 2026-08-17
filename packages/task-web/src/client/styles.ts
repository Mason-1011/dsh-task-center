/**
 * The kanban's stylesheet, injected once per document as
 * `<style data-plugin-css="task-web">`. Everything is scoped under
 * `.task-web` so the board can never leak into the shell's own CSS.
 * @module @task-center/task-web/client/styles
 */

const CSS = `
.task-web-open {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; font-size: 12px; line-height: 1.4;
  color: inherit; background: transparent;
  border: 1px solid rgba(125, 138, 160, .35); border-radius: 8px;
  cursor: pointer; font-family: inherit;
}
.task-web-open:hover { background: rgba(125, 138, 160, .14); }
.task-web-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #e5a53c; box-shadow: 0 0 5px rgba(229, 165, 60, .9);
}

.task-web-overlay {
  position: fixed; inset: 0; z-index: 60; pointer-events: auto;
  background: rgba(9, 12, 18, .62); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center;
  font-family: system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
.task-web-panel {
  width: min(1280px, 95vw); height: min(880px, 93vh);
  display: flex; flex-direction: column;
  background: #10141c; color: #e6e9f0;
  border: 1px solid #242c3a; border-radius: 14px;
  box-shadow: 0 28px 90px rgba(0, 0, 0, .55);
}
.task-web-head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 12px 16px; border-bottom: 1px solid #242c3a;
}
.task-web-title { font-size: 15px; font-weight: 600; letter-spacing: .02em; }
.task-web-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.task-web-chip {
  padding: 3px 10px; font-size: 12px; cursor: pointer;
  color: #aab3c5; background: #151b26; border: 1px solid #2a3342; border-radius: 999px;
}
.task-web-chip[data-on='true'] { color: #e6e9f0; background: #1f3a5f; border-color: #3f6ea8; }
.task-web-spacer { flex: 1; }
.task-web-fetched { font-size: 11px; color: #7d8aa0; }
.task-web-btn {
  padding: 4px 12px; font-size: 12px; cursor: pointer; font-family: inherit;
  color: #d7dce6; background: #1a2230; border: 1px solid #2e3849; border-radius: 8px;
}
.task-web-btn:hover { background: #212b3c; }
.task-web-btn:disabled { opacity: .5; cursor: default; }
.task-web-btn[data-variant='primary'] { background: #1f4d33; border-color: #2f7050; }
.task-web-btn[data-variant='primary']:hover { background: #256240; }
.task-web-btn[data-variant='danger'] { background: #4d1f1f; border-color: #702f2f; }
.task-web-btn[data-variant='danger']:hover { background: #5c2626; }
.task-web-btn[data-variant='ghost'] { background: transparent; border-color: transparent; color: #93a0b5; }
.task-web-btn[data-variant='ghost']:hover { color: #e6e9f0; background: rgba(125, 138, 160, .12); }

.task-web-notice {
  margin: 10px 16px 0; padding: 7px 12px; font-size: 12.5px;
  color: #f0c96a; background: #2a2211; border: 1px solid #5c4a24; border-radius: 10px;
}
.task-web-banner {
  margin: 10px 16px 0; padding: 8px 12px; font-size: 13px;
  color: #f0c96a; background: #2a2211; border: 1px solid #5c4a24; border-radius: 10px;
}
.task-web-banner code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }

.task-web-cols {
  flex: 1; min-height: 0; display: flex; gap: 10px;
  padding: 12px 16px 16px; overflow: auto;
}
.task-web-col { flex: 1 1 0; min-width: 208px; display: flex; flex-direction: column; gap: 8px; }
.task-web-col-head {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 12px; color: #93a0b5; padding: 0 2px; font-weight: 600;
}
.task-web-col-count { font-weight: 400; color: #6f7c92; }
.task-web-cards { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; padding-bottom: 2px; }

.task-web-card {
  text-align: left; font-family: inherit; cursor: pointer;
  background: #161d29; border: 1px solid #242c3a; border-radius: 10px;
  padding: 9px 10px; font-size: 13px; color: #d7dce6; width: 100%;
}
.task-web-card:hover { border-color: #33405a; background: #182031; }
.task-web-card[data-status='blocked'] { border-color: #6b3f3f; }
.task-web-card[data-archived='true'] { opacity: .55; }
.task-web-card-meta {
  display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap;
  font-size: 10.5px; color: #7d8aa0; font-family: ui-monospace, Consolas, monospace;
  margin-bottom: 4px;
}
.task-web-card-id { color: #93a0b5; }
.task-web-mark { color: #e5a53c; }
.task-web-objective { line-height: 1.45; word-break: break-word; }
.task-web-blocked { margin-top: 4px; font-size: 11.5px; color: #d98d8d; }
.task-web-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.task-web-reason { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.task-web-input {
  padding: 6px 9px; font-size: 12.5px; font-family: inherit;
  color: #e6e9f0; background: #0d1118; border: 1px solid #2e3849; border-radius: 8px;
}
.task-web-input:focus { outline: none; border-color: #3f6ea8; }
.task-web-error { color: #e08a8a; font-size: 12px; }

.task-web-modal-backdrop {
  position: absolute; inset: 0; z-index: 5; pointer-events: auto;
  background: rgba(9, 12, 18, .5);
  display: flex; align-items: center; justify-content: center;
}
.task-web-modal {
  width: min(560px, 92%); max-height: 86%; overflow-y: auto;
  background: #141a25; border: 1px solid #2a3342; border-radius: 12px;
  padding: 16px; display: flex; flex-direction: column; gap: 10px;
}
.task-web-modal-head { display: flex; align-items: baseline; gap: 8px; }
.task-web-modal-title { font-size: 14px; font-weight: 600; }
.task-web-field { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.task-web-field-label { color: #93a0b5; font-size: 11.5px; }
.task-web-lines { font-size: 12.5px; line-height: 1.55; word-break: break-word; }
.task-web-children { display: flex; flex-direction: column; gap: 4px; }
.task-web-child {
  display: flex; gap: 8px; align-items: baseline; font-size: 12px;
  padding: 4px 8px; background: #101623; border-radius: 8px;
}
.task-web-pack {
  background: #0d1118; border: 1px solid #232a36; border-radius: 8px;
  padding: 8px 10px; font-family: ui-monospace, Consolas, monospace;
  font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
  color: #aab3c5;
}
.task-web-form { display: flex; flex-direction: column; gap: 10px; }
.task-web-form-actions { display: flex; gap: 8px; justify-content: flex-end; }
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
