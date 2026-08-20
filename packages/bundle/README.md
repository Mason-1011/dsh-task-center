# dsh-task-center

The web-profile entry bundle of the task-center plugin set — one install brings
the whole task board: the ledger, model tools, human commands, wake patrol,
quota-resume guard, idle-session mining, the reaper, scheduled sends, and the
web kanban.

```sh
dsh plugin --profile web add dsh-task-center
```

The `web` profile (created by `dsh web` on first run) already carries the
storage rows this set needs, at the shared `~/.dsh/storages` root; this layer
deliberately does not insert them again. For a fresh, non-web profile use
[`dsh-task-center-headless`](../bundle-headless), which carries its own storage
rows.

Every plugin row lands with a deployment default; override any row by `id` in
your profile's own `cordis.patch.yml` (a later layer replaces the whole
`config`). Rows: `tasks`, `task-local`, `task-source`, `tool-task`,
`command-task`, `task-wake`, `task-quota`, `task-reaper`, `task-web`,
`task-sched`.

Requires `DEEPSEEK_API_KEY` in the environment (or saved through the web UI's
Models page); the summarizer/wake/scheduler agents default to
`deepseek-official` / `$TASK_CENTER_MODEL` (fallback `deepseek-v4-flash`).
