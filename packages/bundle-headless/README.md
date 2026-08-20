# dsh-task-center-headless

The fresh-profile entry bundle of the task-center plugin set: the storage rows
the dsh-base layer does not carry plus the core plugins (ledger, model tools,
human commands, wake patrol, quota-resume guard, idle-session mining, the
reaper). `task-web`/`task-sched` stay out — they belong to the web profile
([`dsh-task-center`](../bundle) there).

```sh
dsh plugin --profile tasks add dsh-task-center-headless
dsh --profile tasks "some task"
```

A profile name used for the first time initializes from `dsh-base`; this layer
adds the storage rows (same `~/.dsh/storages` root as the web bundle, so
profiles share one ledger) and the plugin rows with deployment defaults.
Override any row by `id` in your profile's own `cordis.patch.yml`.

Requires `DEEPSEEK_API_KEY` in the environment; the summarizer/wake agents
default to `deepseek-official` / `$TASK_CENTER_MODEL` (fallback
`deepseek-v4-flash`).
