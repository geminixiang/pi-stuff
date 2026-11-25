# @geminixiang/pi-tasks

A project-level task list for one Pi session that manages work and delegates it to
subagents. Tasks live in SQLite at `<git root>/.pi/tasks.db`; a `.pi/.gitignore` is
created so the database is never committed. Set `PI_TASKS_DB` to use another file.

Tools:

- `task_add(title, source_url?, plan?, agent_id?, result?, note?, due?)`
- `task_update(id, status?, title?, source_url?, plan?, agent_id?, result?, note?, due?)`
- `task_list(status?)` — open tasks by default, or a status, or `all`

Statuses: `todo`, `running`, `needs_input`, `review`, `done`, `cancelled`.

Guards against tasks silently going stale:

- One agent, one running task. Setting a task `running` with an `agent_id` parks that
  agent's other running tasks as `todo`, with a note saying where the agent went.
- `due` (UTC ISO time) marks when a parked or watched task should be picked up again.
- Before each agent run, tasks that are `running` but untouched for 24 h, and open tasks
  past `due`, are injected as a message asking the agent to resolve them that turn. The
  same list is not repeated within 6 hours unless it changes.

Execution is left to the existing subagent tools (`Agent`, `steer_subagent`,
`get_subagent_result`, `resume`); record the subagent ID in `agent_id`.

```sh
pi install ./packages/pi-tasks
```
