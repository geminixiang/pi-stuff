import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TERMINAL_STATES,
  type TaskRecord,
  type TaskSpec,
  type TaskState,
  type TaskView,
} from "@geminixiang/pi-task-protocol";
import { LogWriter, readWindow } from "./logfile.ts";
import { listeningPorts } from "./ports.ts";
import { DurableStore } from "./store.ts";

/** Upper bound on how long a terminal transition waits for buffered output to reach disk. */
const FLUSH_GRACE_MS = 5_000;
/** How long an observed set of listening ports is reused before re-inspecting. */
const PORT_CACHE_MS = 2_000;
const execFileAsync = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface OutputResult {
  stream: "stdout" | "stderr";
  offset: number;
  nextOffset: number;
  size: number;
  /** Earliest logical byte still on disk; anything below it was evicted by log rotation. */
  retainedFrom: number;
  eof: boolean;
  text: string;
}

async function processIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === "win32") return undefined;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-p", String(pid)],
      { timeout: 1_000 },
    );
    const identity = stdout.trim().replace(/\s+/g, " ");
    return identity.startsWith(`${pid} ${pid} `) ? identity : undefined;
  } catch {
    return undefined;
  }
}

export class TaskRunner {
  readonly store: DurableStore;
  private readonly children = new Map<string, ChildProcess>();
  private readonly forcedFailure = new Map<string, { error: string; reason: string }>();
  private readonly portCache = new Map<string, { at: number; ports: number[] }>();
  constructor(store: DurableStore) {
    this.store = store;
  }

  /**
   * Decorates a record with the ports it is currently listening on. Cached briefly because
   * inspecting a process group costs a subprocess, and callers refresh on a timer.
   */
  async view(record: TaskRecord): Promise<TaskView> {
    if (!record.pid || TERMINAL_STATES.has(record.state)) {
      this.portCache.delete(record.id);
      return record;
    }
    const cached = this.portCache.get(record.id);
    if (cached && Date.now() - cached.at < PORT_CACHE_MS)
      return cached.ports.length ? { ...record, ports: cached.ports } : record;
    const ports = await listeningPorts(record.pid);
    this.portCache.set(record.id, { at: Date.now(), ports });
    return ports.length ? { ...record, ports } : record;
  }

  async recover(): Promise<void> {
    for (const record of this.store.list()) {
      if (TERMINAL_STATES.has(record.state)) continue;
      const identity = record.pid ? await processIdentity(record.pid) : undefined;
      if (!identity || identity !== record.processIdentity) {
        record.error = "taskd restarted and process identity could not be safely verified";
        await this.transition(record, "orphaned", "terminal", {
          reason: "unverified_process_identity",
        });
        continue;
      }
      this.signal(record.pid!, "SIGTERM");
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && (await processIdentity(record.pid!)) === identity)
        await delay(25);
      if ((await processIdentity(record.pid!)) === identity) this.signal(record.pid!, "SIGKILL");
      record.error = "taskd restarted while task was active; verified process group stopped";
      await this.transition(record, "failed", "terminal", { reason: "daemon_restart_interrupted" });
    }
  }

  async start(spec: TaskSpec): Promise<TaskRecord> {
    if (!isAbsolute(spec.cwd)) throw new Error("cwd must be absolute");
    const cwdStat = await stat(spec.cwd).catch(() => undefined);
    if (!cwdStat?.isDirectory()) throw new Error(`cwd is not a directory: ${spec.cwd}`);
    if (spec.command.includes("/") && isAbsolute(spec.command))
      await access(spec.command, constants.X_OK);
    const now = new Date().toISOString();
    const record: TaskRecord = {
      id: randomUUID(),
      spec: structuredClone(spec),
      state: "starting",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.create(record);
    const stdout = new LogWriter(join(this.store.dir, `${record.id}.stdout`));
    const stderr = new LogWriter(join(this.store.dir, `${record.id}.stderr`));
    await stdout.open();
    await stderr.open();
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args ?? [], {
        cwd: spec.cwd,
        env: process.env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.on("data", (chunk: Buffer) => stdout.write(chunk));
      child.stderr!.on("data", (chunk: Buffer) => stderr.write(chunk));
      if (!child.pid) throw new Error("Process did not provide a pid");
      record.pid = child.pid;
      this.children.set(record.id, child);
      const started = (async () => {
        record.processIdentity = await processIdentity(child.pid!);
        await this.transition(record, "running", "state", { pid: child.pid });
      })();
      // "close" follows "exit" once both stdio pipes have ended, so draining from there is
      // what makes the log on disk complete. A reader that sees a terminal state must not
      // race the tail of the output, so the terminal transition below awaits this.
      const flushed = new Promise<void>((resolve) => child.once("close", () => resolve()))
        .then(() => Promise.all([stdout.close(), stderr.close()]))
        .then(() => undefined)
        .catch(() => undefined);
      // A store write can fail here (a full or unwritable runtime directory), and this chain
      // has no caller to reject to. Record it on the task rather than letting an unhandled
      // rejection take down the daemon and every other task it supervises.
      const settle = (run: () => Promise<void>) =>
        void started
          .then(() => Promise.race([flushed, delay(FLUSH_GRACE_MS)]))
          .then(run)
          .catch((error: unknown) => {
            record.error = `Failed to record task completion: ${error instanceof Error ? error.message : String(error)}`;
          });
      child.once("error", (error) => {
        settle(() => {
          record.error = error.message;
          return this.finish(record, "failed", null, null);
        });
      });
      child.once("exit", (code, signal) => {
        settle(() => {
          const forced = this.forcedFailure.get(record.id);
          if (forced) {
            this.forcedFailure.delete(record.id);
            record.error = forced.error;
            return this.finish(record, "failed", code, signal, forced.reason);
          }
          return this.finish(
            record,
            record.state === "stopping" ? "stopped" : code === 0 ? "succeeded" : "failed",
            code,
            signal,
          );
        });
      });
      await started;
    } catch (error) {
      await stdout.close().catch(() => undefined);
      await stderr.close().catch(() => undefined);
      record.error = String(error);
      await this.transition(record, "failed", "terminal", { error: record.error });
      return record;
    }

    if (spec.runTimeoutMs)
      setTimeout(() => {
        if (TERMINAL_STATES.has(this.store.get(record.id)?.state ?? "failed")) return;
        this.forcedFailure.set(record.id, { error: "Run timed out", reason: "run_timed_out" });
        void this.stop(record.id);
      }, spec.runTimeoutMs).unref();
    if (spec.readiness) void this.awaitReadiness(record);
    return this.store.get(record.id)!;
  }

  /**
   * Reads a bounded window of one stream. `tail` reads the last `limit` bytes instead of
   * seeking from `offset`, so a caller can reach the end of a long-lived service log
   * without first knowing its size. Offsets are logical and survive log rotation.
   */
  async output(
    id: string,
    stream: "stdout" | "stderr" = "stdout",
    offset = 0,
    limit = 64 * 1024,
    tail = false,
  ): Promise<OutputResult> {
    if (!this.store.get(id)) throw new Error("Task not found");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid output offset");
    const window = await readWindow(join(this.store.dir, `${id}.${stream}`), {
      offset,
      limit: Math.max(1, Math.min(limit, 1024 * 1024)),
      tail,
    });
    return { stream, ...window };
  }

  async wait(id: string, timeoutMs = 30_000): Promise<TaskRecord> {
    const end = Date.now() + Math.max(1, Math.min(timeoutMs, 3_600_000));
    while (Date.now() < end) {
      const record = this.store.get(id);
      if (!record) throw new Error("Task not found");
      if (TERMINAL_STATES.has(record.state) || record.state === "ready") return record;
      await delay(25);
    }
    throw new Error("Wait timed out");
  }

  async stop(id: string, timeoutMs = 5_000): Promise<TaskRecord> {
    const record = this.store.get(id);
    if (!record) throw new Error("Task not found");
    if (TERMINAL_STATES.has(record.state)) return record;
    await this.transition(record, "stopping", "state", {});
    const child = this.children.get(id);
    if (!child?.pid) return this.store.get(id)!;
    this.signal(child.pid, "SIGTERM");
    try {
      return await this.waitTerminal(id, timeoutMs);
    } catch {
      this.signal(child.pid, "SIGKILL");
      return this.waitTerminal(id, 2_000);
    }
  }

  async stopOwner(ownerSessionId: string, timeoutMs = 5_000): Promise<TaskRecord[]> {
    const owned = this.store
      .list()
      .filter(
        (record) =>
          record.spec.ownerSessionId === ownerSessionId && !TERMINAL_STATES.has(record.state),
      );
    return Promise.all(owned.map((record) => this.stop(record.id, timeoutMs)));
  }

  private signal(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  private async waitTerminal(id: string, timeoutMs: number): Promise<TaskRecord> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const record = this.store.get(id)!;
      if (TERMINAL_STATES.has(record.state)) return record;
      await delay(25);
    }
    throw new Error("Stop timed out");
  }
  private async finish(
    record: TaskRecord,
    state: TaskState,
    code: number | null,
    signal: NodeJS.Signals | null,
    reason?: string,
  ): Promise<void> {
    const current = this.store.get(record.id);
    if (!current || TERMINAL_STATES.has(current.state)) return;
    this.children.delete(record.id);
    record.state = current.state;
    record.exitCode = code;
    record.signal = signal;
    if (reason) record.terminationReason = reason;
    const finalState = reason ? "failed" : current.state === "stopping" ? "stopped" : state;
    await this.transition(record, finalState, "terminal", {
      exitCode: code,
      signal,
      ...(reason ? { reason, error: record.error } : {}),
    });
  }
  private async transition(
    record: TaskRecord,
    state: TaskState,
    event: "state" | "ready" | "terminal",
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.store.transition({ record, state, type: event, data });
    record.state = state;
    record.updatedAt = this.store.get(record.id)!.updatedAt;
  }

  private async awaitReadiness(record: TaskRecord): Promise<void> {
    const deadline = Date.now() + (record.spec.readinessTimeoutMs ?? 30_000);
    const ready = record.spec.readiness!;
    while (
      Date.now() < deadline &&
      !TERMINAL_STATES.has(this.store.get(record.id)?.state ?? "failed")
    ) {
      let ok = false;
      if (ready.type === "output") {
        const streams =
          ready.stream === "stderr"
            ? (["stderr"] as const)
            : ready.stream === "both"
              ? (["stdout", "stderr"] as const)
              : (["stdout"] as const);
        for (const stream of streams)
          if ((await this.output(record.id, stream, 0, 1024 * 1024)).text.includes(ready.substring))
            ok = true;
      } else if (ready.type === "http") {
        try {
          const response = await fetch(ready.url, { signal: AbortSignal.timeout(1_000) });
          ok = response.status === (ready.expectedStatus ?? 200);
        } catch {}
      } else
        ok = await new Promise<boolean>((resolve) => {
          const socket = createConnection({ host: ready.host, port: ready.port });
          socket.setTimeout(1_000);
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          const fail = () => {
            socket.destroy();
            resolve(false);
          };
          socket.once("error", fail);
          socket.once("timeout", fail);
        });
      if (ok) {
        const current = this.store.get(record.id);
        if (current && !TERMINAL_STATES.has(current.state)) {
          record.state = current.state;
          await this.transition(record, "ready", "ready", {});
        }
        return;
      }
      await delay(50);
    }
    const current = this.store.get(record.id);
    if (current && !TERMINAL_STATES.has(current.state)) {
      this.forcedFailure.set(record.id, {
        error: "Readiness timed out",
        reason: "readiness_timed_out",
      });
      record.state = current.state;
      await this.transition(record, "stopping", "state", { reason: "readiness_timed_out" });
      const child = this.children.get(record.id);
      if (child?.pid) this.signal(child.pid, "SIGTERM");
    }
  }
}
