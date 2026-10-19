# @geminixiang/pi-tasks

A project-level task list for one Pi session that manages work and delegates it to
subagents. Tasks live in SQLite at `<git root>/.pi/tasks.db`; a `.pi/.gitignore` is
created so the database is never committed. Set `PI_TASKS_DB` to use another file.

Tools:

- `task_add(title, source_url?, plan?, agent_id?, result?, note?)`
- `task_update(id, status?, title?, source_url?, plan?, agent_id?, result?, note?)`
- `task_list(status?)` — open tasks by default, or a status, or `all`

Statuses: `todo`, `running`, `needs_input`, `review`, `done`, `cancelled`.

Execution is left to the existing subagent tools (`Agent`, `steer_subagent`,
`get_subagent_result`, `resume`); record the subagent ID in `agent_id`.

```sh
pi install ./packages/pi-tasks
```
