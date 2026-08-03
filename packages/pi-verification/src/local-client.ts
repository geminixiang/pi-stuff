import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TaskRecord, TaskSpec } from "@geminixiang/pi-task-protocol";
import type { SupervisorTaskClient } from "./types.js";

type Local = { record: TaskRecord; child: ChildProcess; stdout: string; stderr: string };

/** Explicitly opt-in, non-durable fallback for tests and constrained integrations. */
export class LocalTaskClient implements SupervisorTaskClient {
  readonly #tasks = new Map<string, Local>();
  async request<T>(
    request:
      | { method: "start"; params: TaskSpec }
      | { method: "wait"; params: { taskId: string; timeoutMs?: number } }
      | {
          method: "output";
          params: { taskId: string; stream?: "stdout" | "stderr"; offset?: number; limit?: number };
        }
      | { method: "get"; params: { taskId: string } }
      | { method: "stop"; params: { taskId: string; timeoutMs?: number } },
  ): Promise<T> {
    if (request.method === "start") return (await this.start(request.params)) as T;
    const task = this.#tasks.get(request.params.taskId);
    if (!task) throw new Error("Task not found");
    if (request.method === "get") return task.record as T;
    if (request.method === "output") {
      const value = request.params.stream === "stderr" ? task.stderr : task.stdout;
      const offset = request.params.offset ?? 0;
      const nextOffset = Math.min(value.length, offset + (request.params.limit ?? 64 * 1024));
      return {
        stream: request.params.stream ?? "stdout",
        offset,
        nextOffset,
        eof: nextOffset >= value.length,
        text: value.slice(offset, nextOffset),
      } as T;
    }
    if (request.method === "stop") {
      if (!this.terminal(task.record)) task.child.kill("SIGTERM");
      return (await this.waitFor(task, request.params.timeoutMs ?? 5_000, true)) as T;
    }
    return (await this.waitFor(task, request.params.timeoutMs ?? 30_000, false)) as T;
  }
  private async start(spec: TaskSpec): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id: randomUUID(),
      spec,
      state: "starting",
      createdAt: now,
      updatedAt: now,
    };
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const task: Local = { record, child, stdout: "", stderr: "" };
    this.#tasks.set(record.id, task);
    record.pid = child.pid;
    record.state = "running";
    child.stdout.on("data", (chunk: Buffer) => {
      task.stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      task.stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      record.error = error.message;
      record.state = "failed";
      record.updatedAt = new Date().toISOString();
    });
    child.once("exit", (code) => {
      record.exitCode = code;
      record.state = code === 0 ? "succeeded" : "failed";
      record.updatedAt = new Date().toISOString();
    });
    if (spec.runTimeoutMs)
      setTimeout(() => {
        if (this.terminal(record)) return;
        record.terminationReason = "run_timed_out";
        record.error = "Run timed out";
        child.kill("SIGTERM");
      }, spec.runTimeoutMs).unref();
    return record;
  }
  private terminal(record: TaskRecord): boolean {
    return record.state === "succeeded" || record.state === "failed" || record.state === "stopped";
  }
  private async waitFor(task: Local, timeoutMs: number, stopping: boolean): Promise<TaskRecord> {
    const deadline = Date.now() + timeoutMs;
    while (!this.terminal(task.record) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (!this.terminal(task.record)) throw new Error("Wait timed out");
    if (stopping && task.record.state !== "failed" && task.record.state !== "succeeded")
      task.record.state = "stopped";
    return task.record;
  }
}
