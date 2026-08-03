import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TaskEvent, TaskRecord, TaskSpec, TaskView } from "@geminixiang/pi-task-protocol";
import { PROTOCOL_VERSION, TERMINAL_STATES } from "@geminixiang/pi-task-protocol";
import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { IncompatibleProtocolError, TaskClient } from "../src/daemon.ts";
import {
  LOG_STREAMS,
  type LogStream,
  type StreamCursors,
  compileFilter,
  describeTask,
  renderStream,
  selectWindow,
} from "../src/logs.ts";
import type { OutputResult } from "../src/runner.ts";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  details: undefined,
});
const plain = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  details: undefined,
});
const base = process.env.PI_TASKD_HOME ?? join(homedir(), ".pi", "taskd");
const socket = process.env.PI_TASKD_SOCKET ?? join(base, "taskd.sock");
const client = new TaskClient(socket);
/** ANSI faint on/off, matching the dim weight the footer applies to its own lines. */
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";

/**
 * Wraps text in an OSC 8 hyperlink. The sequences occupy no columns — pi-tui parses them
 * when measuring and slicing — and terminals without OSC 8 support render the text alone.
 */
const hyperlink = (label: string, url: string): string =>
  `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;

/**
 * Newest modification time among the daemon's own sources.
 *
 * taskd outlives any one Pi session and is reused whenever its protocol matches, so a
 * daemon started before an edit keeps serving the old behaviour with nothing to indicate
 * it. Comparing against its start time catches that; for an installed package the sources
 * predate every daemon start, so this never fires.
 */
async function daemonSourceMtime(): Promise<number> {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  try {
    const names = await readdir(dir);
    const times = await Promise.all(
      names
        .filter((name) => name.endsWith(".ts"))
        .map((name) =>
          stat(join(dir, name)).then(
            (info) => info.mtimeMs,
            () => 0,
          ),
        ),
    );
    return Math.max(0, ...times);
  } catch {
    return 0;
  }
}

export default function supervisor(pi: ExtensionAPI): void {
  let polling = false;
  let cursor = 0;
  let sessionId: string | undefined;
  let cursorName = "pi-supervisor-unbound";
  let ui: ExtensionUIContext | undefined;
  const ownedTasks = new Map<string, string>();
  /** Ids still running, so the footer reflects what is live without polling the daemon. */
  const liveTasks = new Set<string>();
  /** Ports each live task is listening on, refreshed on a timer rather than per event. */
  const livePorts = new Map<string, number[]>();
  /** Per-stream byte offset already shown to the agent, so a plain read returns only new output. */
  const readCursors = new Map<string, StreamCursors>();

  const refreshStatus = (): void => {
    if (!ui) return;
    // The footer dims its own lines but renders extension status verbatim, so the faint
    // attribute is applied here to sit at the same visual weight as the rest of the footer.
    if (!liveTasks.size) {
      ui.setStatus("pi-supervisor", undefined);
      return;
    }
    const labels = [...liveTasks].map((id) => {
      const name = ownedTasks.get(id) ?? id;
      const port = livePorts.get(id)?.[0];
      // A listening service links to itself, so the port is one click away rather than
      // spending footer columns. Without a port the name stands alone.
      return port ? hyperlink(name, `http://localhost:${port}`) : name;
    });
    const rest = labels.length - 3;
    const summary = `${labels.length} running: ${labels.slice(0, 3).join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
    ui.setStatus("pi-supervisor", `${DIM}${summary}${UNDIM}`);
  };

  /**
   * Re-reads live records so the footer picks up ports bound after startup — a server
   * usually listens some time after the process itself is running.
   */
  const refreshPorts = async (): Promise<void> => {
    if (!liveTasks.size) return;
    try {
      const records = await client.request<TaskView[]>({ method: "list" });
      for (const record of records) {
        if (!owned(record) || !liveTasks.has(record.id)) continue;
        if (record.ports?.length) livePorts.set(record.id, record.ports);
        else livePorts.delete(record.id);
      }
      refreshStatus();
    } catch {}
  };

  let daemonStartedAt: string | undefined;
  const compatiblePing = async (): Promise<void> => {
    const result = await client.ping();
    if (result.protocolVersion !== PROTOCOL_VERSION)
      throw new IncompatibleProtocolError(result.protocolVersion, result.pid);
    daemonStartedAt = result.startedAt;
  };

  /** Warns when the running daemon predates the code on disk, which serves stale behaviour. */
  const warnIfStale = async (): Promise<void> => {
    if (!ui || !daemonStartedAt) return;
    const started = Date.parse(daemonStartedAt);
    const modified = await daemonSourceMtime();
    if (!Number.isFinite(started) || !modified || modified <= started) return;
    const pid = await client.daemonPid();
    ui.notify(
      `taskd${pid ? ` (pid ${pid})` : ""} started before the current pi-supervisor sources and is serving older behaviour. ` +
        "Run `taskd shutdown` and reload to pick up the changes — note this stops every " +
        "supervised process, since a restarted daemon cannot reattach to their output.",
      "warning",
    );
  };

  /**
   * taskd is shared by every Pi session on this machine, and stopping it stops their
   * processes too, so an incompatible daemon is reported for the user to resolve rather
   * than terminated on their behalf.
   */
  const incompatibleDaemon = async (error: IncompatibleProtocolError): Promise<Error> => {
    const pid = error.daemonPid ?? (await client.daemonPid());
    return new Error(
      `An incompatible taskd is already running (protocol v${error.runningVersion}${pid ? `, pid ${pid}` : ""}), ` +
        `but pi-supervisor requires v${PROTOCOL_VERSION}. Stop it with \`taskd shutdown\`` +
        `${pid ? ` or \`kill ${pid}\`` : ""}, then reload this session. ` +
        `Stopping taskd also stops background processes owned by other Pi sessions.`,
    );
  };

  const ensureDaemon = async (): Promise<void> => {
    try {
      await compatiblePing();
      return;
    } catch (error) {
      if (error instanceof IncompatibleProtocolError) throw await incompatibleDaemon(error);
    }
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = spawn(process.execPath, [cli, "serve"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      try {
        await compatiblePing();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error("Unable to connect to or auto-start taskd");
  };

  const owned = (record: TaskRecord): boolean => record.spec.ownerSessionId === sessionId;
  const requireOwned = async (supervisorId: string): Promise<TaskRecord> => {
    const record = await client.request<TaskRecord>({
      method: "get",
      params: { taskId: supervisorId },
    });
    if (!owned(record)) throw new Error("Supervisor process does not belong to this Pi session");
    return record;
  };

  const follow = async (): Promise<void> => {
    let ticks = 0;
    while (polling) {
      // Ports are inspected every ~5s; the event stream itself is read every 500ms.
      if (ticks++ % 10 === 0) await refreshPorts();
      try {
        const result = await client.request<{ events: TaskEvent[]; nextAfter: number }>({
          method: "events",
          params: { cursor: cursorName, ...(cursor ? { after: cursor } : {}) },
        });
        for (const event of result.events) {
          cursor = event.sequence;
          const name = ownedTasks.get(event.taskId);
          if (name && (event.type === "ready" || event.type === "terminal")) {
            if (event.type === "terminal") {
              liveTasks.delete(event.taskId);
              livePorts.delete(event.taskId);
              refreshStatus();
            }
            pi.sendUserMessage(
              `Supervisor process "${name}" (${event.taskId}) ${event.type}: ${JSON.stringify(event.data)}`,
              { deliverAs: "followUp" },
            );
          }
        }
        if (cursor) {
          await client.request({
            method: "ack",
            params: { cursor: cursorName, sequence: cursor },
          });
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      ui = ctx.ui;
      await ensureDaemon();
      sessionId = ctx.sessionManager.getSessionId();
      cursorName = `pi-supervisor-${sessionId}`;
      const records = await client.request<TaskRecord[]>({ method: "list" });
      for (const record of records) {
        if (!owned(record)) continue;
        ownedTasks.set(record.id, describeTask(record));
        // Reconnecting after /reload adopts whatever this session left running.
        if (!TERMINAL_STATES.has(record.state)) liveTasks.add(record.id);
      }
      polling = true;
      void follow();
      refreshStatus();
      void warnIfStale();
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  });

  pi.on("session_shutdown", async (event) => {
    polling = false;
    if (event.reason === "reload" || !sessionId) return;
    await client
      .request({ method: "stopOwner", params: { ownerSessionId: sessionId, timeoutMs: 5_000 } })
      .catch(() => undefined);
  });

  pi.registerTool({
    name: "supervisor_start",
    label: "Start supervised process",
    description:
      "Start a background process owned by this Pi session and return immediately. Do not wait after starting it; readiness and exit events arrive automatically. Pass `name` to label the process, which makes logs and events readable when several run at once.",
    promptSnippet: "Start a session-owned background process without blocking the agent",
    promptGuidelines: [
      "After supervisor_start succeeds, continue working immediately; do not wait or poll unless the user explicitly asks for logs or status.",
      "Give each process a short `name` such as 'dev-server' or 'api'; several processes can run at once and events identify them by name.",
    ],
    parameters: Type.Object({
      command: Type.String(),
      args: Type.Optional(Type.Array(Type.String())),
      cwd: Type.String(),
      name: Type.Optional(Type.String()),
      readiness: Type.Optional(
        Type.Union([
          Type.Object({ type: Type.Literal("output"), substring: Type.String() }),
          Type.Object({
            type: Type.Literal("http"),
            url: Type.String(),
            expectedStatus: Type.Optional(Type.Integer()),
          }),
          Type.Object({ type: Type.Literal("tcp"), host: Type.String(), port: Type.Integer() }),
        ]),
      ),
      readinessTimeoutMs: Type.Optional(Type.Integer()),
      runTimeoutMs: Type.Optional(Type.Integer()),
    }),
    async execute(_id, params) {
      await ensureDaemon();
      if (!sessionId) throw new Error("Supervisor is not attached to a Pi session");
      const record = await client.request<TaskRecord>({
        method: "start",
        params: { ...params, service: true, ownerSessionId: sessionId } as TaskSpec,
      });
      ownedTasks.set(record.id, describeTask(record));
      liveTasks.add(record.id);
      refreshStatus();
      return text(record);
    },
  });

  pi.registerTool({
    name: "supervisor_list",
    label: "List supervised processes",
    description:
      "List background processes owned by this Pi session, with the id needed to read their logs.",
    parameters: Type.Object({}),
    async execute() {
      const records = (await client.request<TaskView[]>({ method: "list" })).filter(owned);
      if (!records.length) return plain("No supervised processes in this session.");
      return plain(
        records
          .map((record) =>
            [
              `${describeTask(record)} — ${record.state}`,
              `  id: ${record.id}`,
              `  cwd: ${record.spec.cwd}`,
              record.ports?.length ? `  listening: ${record.ports.join(", ")}` : undefined,
              record.pid ? `  pid: ${record.pid}` : undefined,
              record.error ? `  error: ${record.error}` : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n"),
      );
    },
  });

  pi.registerTool({
    name: "supervisor_logs",
    label: "Read supervisor logs",
    description:
      "Read logs from a session-owned background process. By default returns only output that appeared since the last read of both stdout and stderr, so it can be called repeatedly while a service runs. Use mode 'tail' for the most recent output regardless of what was already read, and 'all' to read from the beginning.",
    promptGuidelines: [
      "Call supervisor_logs with just a supervisorId to see what a service printed since you last looked; there is no offset to track.",
      "Use `filter` with a regular expression to keep only matching lines when a service is noisy.",
    ],
    parameters: Type.Object({
      supervisorId: Type.String(),
      stream: Type.Optional(
        Type.Union([Type.Literal("stdout"), Type.Literal("stderr"), Type.Literal("both")]),
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("new"), Type.Literal("tail"), Type.Literal("all")]),
      ),
      filter: Type.Optional(Type.String()),
      offset: Type.Optional(Type.Integer()),
      limit: Type.Optional(Type.Integer()),
    }),
    async execute(_id, params, signal) {
      const record = await requireOwned(params.supervisorId);
      const mode = params.mode ?? "new";
      const limit = params.limit ?? 64 * 1024;
      const filter = compileFilter(params.filter);
      const streams =
        !params.stream || params.stream === "both" ? LOG_STREAMS : ([params.stream] as const);
      const cursors = readCursors.get(params.supervisorId) ?? { stdout: 0, stderr: 0 };
      const sections: string[] = [];
      for (const stream of streams) {
        const seen = cursors[stream];
        const window = selectWindow(mode, seen, params.offset);
        const result = await client.request<OutputResult>(
          { method: "output", params: { taskId: params.supervisorId, stream, limit, ...window } },
          signal,
        );
        cursors[stream] = result.nextOffset;
        sections.push(renderStream(result, filter, mode === "new" ? seen : result.offset));
      }
      readCursors.set(params.supervisorId, cursors);
      return plain(
        `${describeTask(record)} (${record.state})\n\n${sections.join("\n\n")}`.trimEnd(),
      );
    },
  });

  pi.registerTool({
    name: "supervisor_control",
    label: "Control supervised process",
    description: "Get status or stop a session-owned background process.",
    parameters: Type.Object({
      supervisorId: Type.String(),
      action: Type.Union([Type.Literal("get"), Type.Literal("stop")]),
      timeoutMs: Type.Optional(Type.Integer()),
    }),
    async execute(_id, params, signal) {
      const record = await requireOwned(params.supervisorId);
      if (params.action === "get") return text(record);
      return text(
        await client.request(
          {
            method: "stop",
            params: { taskId: params.supervisorId, timeoutMs: params.timeoutMs },
          },
          signal,
        ),
      );
    },
  });
}
