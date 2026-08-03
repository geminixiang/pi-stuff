import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PROTOCOL_VERSION,
  parseRequest,
  type Request,
  type Response,
} from "@geminixiang/pi-task-protocol";
import { DurableStore } from "./store.ts";
import { TaskRunner } from "./runner.ts";

const MAX_FRAME_BYTES = 1024 * 1024;
const SOCKET_TIMEOUT_MS = 30_000;
const startupLocks = new Map<string, Promise<void>>();

export async function probe(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export class TaskDaemon {
  readonly socketPath: string;
  readonly lockPath: string;
  /** When this daemon process loaded, so a client can tell it is running older code. */
  readonly startedAt = new Date().toISOString();
  private server?: Server;
  private lockHandle?: Awaited<ReturnType<typeof open>>;
  private readonly sockets = new Set<Socket>();
  readonly store: DurableStore;
  readonly runner: TaskRunner;
  constructor(socketPath: string, dataDir: string) {
    this.socketPath = socketPath;
    this.lockPath = `${socketPath}.lock`;
    this.store = new DurableStore(dataDir);
    this.runner = new TaskRunner(this.store);
  }

  async start(): Promise<void> {
    const previous = startupLocks.get(this.socketPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    startupLocks.set(
      this.socketPath,
      previous.then(() => current),
    );
    await previous;
    try {
      await this.startExclusive();
    } finally {
      release();
      if (startupLocks.get(this.socketPath) === current) startupLocks.delete(this.socketPath);
    }
  }

  private async startExclusive(): Promise<void> {
    await this.secureSocketDirectory();
    if (await probe(this.socketPath))
      throw new Error(`taskd is already running at ${this.socketPath}`);
    await this.acquireLock();
    try {
      if (await probe(this.socketPath))
        throw new Error(`taskd is already running at ${this.socketPath}`);
      try {
        const info = await lstat(this.socketPath);
        if (!info.isSocket())
          throw new Error(`Refusing to remove non-socket path: ${this.socketPath}`);
        if (typeof process.getuid === "function" && info.uid !== process.getuid())
          throw new Error("Socket is owned by another user");
        await rm(this.socketPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.store.open();
      await this.runner.recover();
      this.server = createServer((socket) => this.accept(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.socketPath, resolve);
      });
      await chmod(this.socketPath, 0o600);
    } catch (error) {
      await this.releaseLock();
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    if (!(await probe(this.socketPath))) await rm(this.socketPath, { force: true });
    await this.releaseLock();
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        socket.destroy(new Error("Request frame too large"));
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) void this.respond(socket, line);
      }
    });
    socket.once("timeout", () => socket.destroy(new Error("Socket timed out")));
    socket.once("close", () => this.sockets.delete(socket));
    socket.on("error", () => undefined);
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let id = "invalid";
    try {
      const raw: unknown = JSON.parse(line);
      if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).id === "string")
        id = (raw as { id: string }).id;
      const request = parseRequest(raw);
      id = request.id;
      const result = await this.dispatch(request);
      socket.write(
        `${JSON.stringify({ version: PROTOCOL_VERSION, id, ok: true, result } satisfies Response)}\n`,
      );
    } catch (error) {
      socket.write(
        `${JSON.stringify({ version: PROTOCOL_VERSION, id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies Response)}\n`,
      );
    }
  }

  private async dispatch(request: Request): Promise<unknown> {
    switch (request.method) {
      case "ping":
        return { pid: process.pid, protocolVersion: PROTOCOL_VERSION, startedAt: this.startedAt };
      case "start":
        return this.runner.start(request.params);
      case "list":
        return Promise.all(this.store.list().map((task) => this.runner.view(task)));
      case "get": {
        const task = this.store.get(request.params.taskId);
        if (!task) throw new Error("Task not found");
        return this.runner.view(task);
      }
      case "output":
        return this.runner.output(
          request.params.taskId,
          request.params.stream,
          request.params.offset,
          request.params.limit,
          request.params.tail,
        );
      case "wait":
        return this.runner.wait(request.params.taskId, request.params.timeoutMs);
      case "stop":
        return this.runner.stop(request.params.taskId, request.params.timeoutMs);
      case "stopOwner":
        return this.runner.stopOwner(request.params.ownerSessionId, request.params.timeoutMs);
      case "events": {
        const acknowledged = this.store.cursor(request.params.cursor);
        const events = await this.store.events(
          request.params.after ?? acknowledged,
          request.params.limit,
        );
        return {
          events,
          cursor: acknowledged,
          nextAfter: events.at(-1)?.sequence ?? request.params.after ?? acknowledged,
        };
      }
      case "ack":
        await this.store.ack(request.params.cursor, request.params.sequence);
        return { cursor: request.params.sequence };
    }
  }

  private async acquireLock(): Promise<void> {
    try {
      this.lockHandle = await open(this.lockPath, "wx", 0o600);
      await writeFile(this.lockHandle, `${process.pid}\n`);
      await this.lockHandle.sync();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let owner = 0;
    try {
      owner = Number((await readFile(this.lockPath, "utf8")).trim());
    } catch {}
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
        throw new Error(`taskd lock is held by live process ${owner}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const info = await lstat(this.lockPath);
    if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid()))
      throw new Error("Unsafe taskd lock file");
    await rm(this.lockPath);
    this.lockHandle = await open(this.lockPath, "wx", 0o600);
    await writeFile(this.lockHandle, `${process.pid}\n`);
    await this.lockHandle.sync();
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHandle) return;
    await this.lockHandle.close();
    this.lockHandle = undefined;
    await rm(this.lockPath, { force: true });
  }

  private async secureSocketDirectory(): Promise<void> {
    const path = dirname(this.socketPath);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe socket directory: ${path}`);
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error("Socket directory is owned by another user");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await chmod(path, 0o700);
  }
}

type RequestInput<T extends Request = Request> = T extends Request
  ? Omit<T, "version" | "id">
  : never;

export class IncompatibleProtocolError extends Error {
  readonly runningVersion: number;
  readonly daemonPid?: number;
  constructor(runningVersion: number, daemonPid?: number) {
    super(
      `taskd protocol mismatch: running v${runningVersion}, client requires v${PROTOCOL_VERSION}`,
    );
    this.name = "IncompatibleProtocolError";
    this.runningVersion = runningVersion;
    this.daemonPid = daemonPid;
  }
}

export class TaskClient {
  readonly socketPath: string;
  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }
  request<T>(request: RequestInput, signal?: AbortSignal): Promise<T> {
    const id = crypto.randomUUID();
    const payload = { version: PROTOCOL_VERSION, id, ...request } as Request;
    const operationTimeout =
      "params" in request &&
      request.params &&
      typeof request.params === "object" &&
      "timeoutMs" in request.params &&
      typeof request.params.timeoutMs === "number"
        ? request.params.timeoutMs
        : 30_000;
    const transportTimeout = Math.min(3_610_000, operationTimeout + 10_000);
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error("taskd request aborted"));
        return;
      }
      const socket = createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const cleanup = () => signal?.removeEventListener("abort", abort);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const abort = () =>
        fail(signal?.reason instanceof Error ? signal.reason : new Error("taskd request aborted"));
      signal?.addEventListener("abort", abort, { once: true });
      socket.setEncoding("utf8");
      socket.setTimeout(transportTimeout);
      socket.once("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
          fail(new Error("Response frame too large"));
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as Response;
          if (response.id !== id) throw new Error("Mismatched response");
          if (response.version !== PROTOCOL_VERSION) {
            const daemonPid =
              response.ok &&
              response.result &&
              typeof response.result === "object" &&
              typeof (response.result as { pid?: unknown }).pid === "number"
                ? (response.result as { pid: number }).pid
                : undefined;
            throw new IncompatibleProtocolError(response.version, daemonPid);
          }
          settled = true;
          cleanup();
          socket.end();
          if (!response.ok) reject(new Error(response.error));
          else resolve(response.result as T);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once("timeout", () => fail(new Error("taskd request timed out")));
      socket.once("error", (error) => fail(error));
    });
  }
  ping(): Promise<{ pid: number; protocolVersion: number; startedAt?: string }> {
    return this.request({ method: "ping" });
  }

  /**
   * Reads the pid of the daemon holding the socket lock.
   *
   * A daemon speaking an incompatible protocol rejects our request during schema validation
   * and answers `ok: false`, so it never reports its own pid. The lock file is legible
   * regardless of protocol version, which makes it the only way to identify such a daemon.
   */
  async daemonPid(): Promise<number | undefined> {
    try {
      const pid = Number((await readFile(`${this.socketPath}.lock`, "utf8")).trim());
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }
}
