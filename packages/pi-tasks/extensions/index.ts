import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dbPath, STATUSES, TaskStore, type Task } from "./store.ts";

const statusSchema = Type.Union(STATUSES.map((status) => Type.Literal(status)));
const optional = (description: string) => Type.Optional(Type.String({ description }));

const fieldSchemas = {
  source_url: optional("GitHub issue/PR URL the task comes from"),
  plan: optional("Agreed plan and constraints, given to the agent doing the work"),
  agent_id: optional("Subagent ID or Rex tab number working on the task"),
  result: optional("Outcome for review: summary, links, drafts"),
  note: optional("User decision, feedback or other context"),
  due: optional(
    "When to pick it up again or check it, ISO time (UTC) like 2026-11-17T08:00Z; set for parked or watched tasks",
  ),
};

export function formatTask(task: Task): string {
  const head = `#${task.id} [${task.status}] ${task.title}`;
  const lines = [
    task.source_url && `  source: ${task.source_url}`,
    task.agent_id && `  agent: ${task.agent_id}`,
    task.plan && `  plan: ${task.plan}`,
    task.result && `  result: ${task.result}`,
    task.note && `  note: ${task.note}`,
    task.due && `  due: ${task.due}`,
  ].filter(Boolean);
  return [head, ...lines].join("\n");
}

function withHandOff(task: Task, parked: Task[]): string {
  const lines = parked.map(
    (t) => `parked #${t.id} [todo] ${t.title} (agent ${task.agent_id} reassigned)`,
  );
  return [formatTask(task), ...lines].join("\n");
}

const ATTENTION_EVERY_MS = 6 * 60 * 60 * 1000;

export function attentionText(stale: Task[], due: Task[]): string | undefined {
  const staleIds = new Set(stale.map((task) => task.id));
  const dueOnly = due.filter((task) => !staleIds.has(task.id));
  if (stale.length === 0 && dueOnly.length === 0) return undefined;
  const line = (t: Task) =>
    `- #${t.id} [${t.status}] ${t.title}${t.agent_id ? ` (agent ${t.agent_id})` : ""} — updated ${t.updated_at}Z${t.due ? `, due ${t.due}` : ""}`;
  return [
    "pi-tasks: verify these tasks against the agent, PR, or issue. Keep running only if work is active. If waiting on an external result, record what is pending and set the next check time.",
    stale.length ? `Running but untouched for 24 h (${stale.length}):` : "",
    ...stale.map(line),
    dueOnly.length ? `Due for follow-up (${dueOnly.length}):` : "",
    ...dueOnly.map(line),
  ]
    .filter(Boolean)
    .join("\n");
}

export default function piTasks(pi: ExtensionAPI): void {
  let store: TaskStore | undefined;
  let storeCwd: string | undefined;
  const open = (cwd: string): TaskStore => {
    if (!store || storeCwd !== cwd) {
      store?.close();
      store = new TaskStore(dbPath(cwd));
      storeCwd = cwd;
    }
    return store;
  };
  const text = (value: string) => ({
    content: [{ type: "text" as const, text: value }],
    details: undefined,
  });

  pi.registerTool({
    name: "task_add",
    label: "task add",
    description: "Record a work item in this project's task list (.pi/tasks.db).",
    promptSnippet:
      "Track work items (GitHub issues/PRs, pasted Slack requests) in the project task list.",
    promptGuidelines: [
      "Record each delegated or ongoing work item with task_add, and keep its status, agent_id and result current with task_update.",
      "Statuses: todo, running (an agent is working), needs_input (waiting on the user), review (result ready for the user), done, cancelled.",
      "running means an agent is working on it now; one agent_id has at most one running task, and assigning a new one parks the old one as todo. Give deferred or watched tasks a due time instead of leaving them running.",
    ],
    parameters: Type.Object({ title: Type.String(), ...fieldSchemas }),
    async execute(_id, args, _signal, _update, ctx) {
      const s = open(ctx.cwd);
      const task = s.add(args);
      return text(withHandOff(task, s.handOff(task)));
    },
  });

  pi.registerTool({
    name: "task_update",
    label: "task update",
    description: "Update a task's status, agent, plan, result or note.",
    parameters: Type.Object({
      id: Type.Number(),
      title: optional("New title"),
      status: Type.Optional(statusSchema),
      ...fieldSchemas,
    }),
    async execute(_id, { id, ...fields }, _signal, _update, ctx) {
      const s = open(ctx.cwd);
      const task = s.update(id, fields);
      return text(withHandOff(task, s.handOff(task)));
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "task list",
    description: "List tasks. Defaults to open tasks; pass a status or 'all'.",
    parameters: Type.Object({
      status: Type.Optional(Type.Union([statusSchema, Type.Literal("all")])),
    }),
    async execute(_id, { status }, _signal, _update, ctx) {
      const tasks = open(ctx.cwd).list(status);
      return text(tasks.length ? tasks.map(formatTask).join("\n") : "No tasks.");
    },
  });

  let lastAttention = { key: "", at: 0 };
  pi.on("before_agent_start", async (_event, ctx) => {
    let found;
    try {
      found = open(ctx.cwd).attention();
    } catch {
      return;
    }
    const key = [...found.stale, ...found.due].map((t) => `${t.id}:${t.updated_at}`).join(",");
    const now = Date.now();
    if (!key || (key === lastAttention.key && now - lastAttention.at < ATTENTION_EVERY_MS)) return;
    lastAttention = { key, at: now };
    const content = attentionText(found.stale, found.due);
    if (!content) return;
    return { message: { customType: "pi-tasks-attention", content, display: true } };
  });

  pi.on("session_shutdown", () => {
    store?.close();
    store = undefined;
  });
}
