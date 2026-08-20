# dsh-task-center

The whole task-center plugin set in one package — the ledger, model tools,
human commands, wake patrol, quota-resume guard, idle-session mining, the
reaper, scheduled sends, and the web kanban.

```sh
dsh plugin --profile web add dsh-task-center
```

The `web` profile (created by `dsh web` on first run) already carries the
storage rows this set needs, at the shared `~/.dsh/storages` root; this layer
deliberately does not insert them again. For a fresh, non-web profile, add the
three storage rows to that profile's own `cordis.patch.yml` first:

```yaml
- insert:
    - id: storage
      name: '@deepseek-ai/dsh-storage'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')
    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
        routes: {}
```

Every plugin row lands with a deployment default; override any row by `id` in
your profile's own `cordis.patch.yml` (a later layer replaces the whole
`config`). Rows: `tasks`, `task-local`, `task-source`, `tool-task`,
`command-task`, `task-wake`, `task-quota`, `task-reaper`, `task-web`,
`task-sched`.

Requires `DEEPSEEK_API_KEY` in the environment (or saved through the web UI's
Models page); the summarizer/wake/scheduler agents default to
`deepseek-official` / `$TASK_CENTER_MODEL` (fallback `deepseek-v4-flash`).

The 0.1.0 multi-package family (`dsh-task-center-task` etc.) is deprecated;
this package replaces all of it.
