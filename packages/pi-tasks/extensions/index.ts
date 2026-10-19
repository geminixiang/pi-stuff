import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dbPath, STATUSES, TaskStore, type Task } from "./store.ts";

const statusSchema = Type.Union(STATUSES.map((status) => Type.Literal(status)));
const optional = (description: string) => Type.Optional(Type.String({ description }));

const fieldSchemas = {
  source_url: optional("GitHub issue/PR URL the task comes from"),
  plan: optional("Agreed plan and constraints, given to the agent doing the work"),
  agent_id: optional("Subagent ID working on the task"),
  result: optional("Outcome for review: summary, links, drafts"),
  note: optional("User decision, feedback or other context"),
};

export function formatTask(task: Task): string {
  const head = `#${task.id} [${task.status}] ${task.title}`;
  const lines = [
    task.source_url && `  source: ${task.source_url}`,
    task.agent_id && `  agent: ${task.agent_id}`,
    task.plan && `  plan: ${task.plan}`,
    task.result && `  result: ${task.result}`,
    task.note && `  note: ${task.note}`,
  ].filter(Boolean);
  return [head, ...lines].join("\n");
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
    ],
    parameters: Type.Object({ title: Type.String(), ...fieldSchemas }),
    async execute(_id, args, _signal, _update, ctx) {
      return text(formatTask(open(ctx.cwd).add(args)));
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
      return text(formatTask(open(ctx.cwd).update(id, fields)));
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

  pi.on("session_shutdown", () => {
    store?.close();
    store = undefined;
  });
}
