#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { TaskClient, TaskDaemon, probe } from "./daemon.ts";
import type { TaskRecord, TaskSpec } from "@geminixiang/pi-task-protocol";

export function defaultPaths(): { socket: string; data: string } {
  const base = process.env.PI_TASKD_HOME ?? join(homedir(), ".pi", "taskd");
  return {
    socket: process.env.PI_TASKD_SOCKET ?? join(base, "taskd.sock"),
    data: join(base, "data"),
  };
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const paths = defaultPaths();
  const client = new TaskClient(paths.socket);
  if (command === "serve") {
    const daemon = new TaskDaemon(paths.socket, paths.data);
    await daemon.start();
    const close = async () => {
      await daemon.close();
      process.exit(0);
    };
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    return;
  }
  if (command === "start") {
    try {
      console.log(JSON.stringify(await client.ping()));
    } catch {
      const child = spawn(process.execPath, [process.argv[1]!, "serve"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      const end = Date.now() + 5_000;
      while (Date.now() < end) {
        try {
          console.log(JSON.stringify(await client.ping()));
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      throw new Error("taskd did not start");
    }
    return;
  }
  if (command === "run") {
    const cwdIndex = args.indexOf("--cwd");
    const cwd = cwdIndex >= 0 ? resolve(args.splice(cwdIndex, 2)[1]!) : process.cwd();
    if (!args.length) throw new Error("Usage: taskd run [--cwd DIR] COMMAND [ARGS...]");
    const spec: TaskSpec = { command: args[0]!, args: args.slice(1), cwd };
    console.log(
      JSON.stringify(await client.request<TaskRecord>({ method: "start", params: spec }), null, 2),
    );
    return;
  }
  if (command === "status") {
    const id = args[0];
    console.log(
      JSON.stringify(
        id
          ? await client.request({ method: "get", params: { taskId: id } })
          : await client.request({ method: "list" }),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "shutdown") {
    const pid = await client.daemonPid();
    if (!pid) throw new Error("No taskd lock found; taskd does not appear to be running");
    // Signal only a pid that still owns a live socket, so a recycled pid is never targeted.
    if (!(await probe(paths.socket))) {
      console.log(`No taskd listening at ${paths.socket}; leaving lock for pid ${pid} untouched`);
      return;
    }
    process.kill(pid, "SIGTERM");
    const end = Date.now() + 5_000;
    while (Date.now() < end) {
      try {
        process.kill(pid, 0);
      } catch {
        console.log(`taskd ${pid} stopped`);
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`taskd ${pid} did not stop`);
  }
  if (command === "stop") {
    if (!args[0]) throw new Error("Usage: taskd stop TASK_ID");
    console.log(
      JSON.stringify(
        await client.request({ method: "stop", params: { taskId: args[0] } }),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error("Usage: taskd <start|serve|run|status|stop|shutdown>");
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
