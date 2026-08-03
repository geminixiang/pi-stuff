import { randomUUID } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  assertTransition,
  type TaskEvent,
  type TaskRecord,
  type TaskState,
} from "@geminixiang/pi-task-protocol";

interface Snapshot {
  version: 1;
  sequence: number;
  tasks: Record<string, TaskRecord>;
  cursors: Record<string, number>;
}
interface TransitionInput {
  record: TaskRecord;
  state: TaskState;
  type: "state" | "ready" | "terminal";
  data: Record<string, unknown>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class DurableStore {
  readonly dir: string;
  readonly eventsPath: string;
  readonly snapshotPath: string;
  private data: Snapshot = { version: 1, sequence: 0, tasks: {}, cursors: {} };
  private committed: Snapshot = structuredClone(this.data);
  private mutation: Promise<void> = Promise.resolve();
  constructor(dir: string) {
    this.dir = dir;
    this.eventsPath = join(dir, "events.jsonl");
    this.snapshotPath = join(dir, "snapshot.json");
  }

  async open(): Promise<void> {
    await this.secureDirectory();
    try {
      const parsed: unknown = JSON.parse(await readFile(this.snapshotPath, "utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        (parsed as Snapshot).version !== 1 ||
        !Number.isSafeInteger((parsed as Snapshot).sequence)
      )
        throw new Error("Invalid task store snapshot");
      this.data = parsed as Snapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.persist();
    }
    const events = await this.readEvents();
    let previous = 0;
    for (const event of events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous)
        throw new Error("Invalid event sequence in spool");
      previous = event.sequence;
    }
    this.data.sequence = Math.max(this.data.sequence, previous);
    await this.persist();
    this.committed = clone(this.data);
    await this.secureFile(this.snapshotPath);
    try {
      await this.secureFile(this.eventsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): TaskRecord[] {
    return Object.values(this.committed.tasks)
      .map(clone)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  get(id: string): TaskRecord | undefined {
    const record = this.committed.tasks[id];
    return record ? clone(record) : undefined;
  }
  cursor(name: string): number {
    return this.committed.cursors[name] ?? 0;
  }

  put(record: TaskRecord): Promise<void> {
    return this.serialized(async () => {
      this.data.tasks[record.id] = clone(record);
      await this.persist();
    });
  }

  create(record: TaskRecord): Promise<TaskEvent> {
    return this.serialized(async () => {
      if (this.data.tasks[record.id]) throw new Error("Task already exists");
      this.data.tasks[record.id] = clone(record);
      return this.appendEvent(record.id, "created", { spec: record.spec });
    });
  }

  transition(input: TransitionInput): Promise<TaskEvent> {
    return this.serialized(async () => {
      const current = this.data.tasks[input.record.id];
      if (!current) throw new Error("Task not found");
      assertTransition(current.state, input.state);
      const next = clone(input.record);
      next.state = input.state;
      next.updatedAt = new Date().toISOString();
      this.data.tasks[next.id] = next;
      return this.appendEvent(next.id, input.type, { state: input.state, ...input.data });
    });
  }

  emit(taskId: string, type: TaskEvent["type"], data: Record<string, unknown>): Promise<TaskEvent> {
    return this.serialized(() => this.appendEvent(taskId, type, data));
  }

  async events(after: number, limit = 100): Promise<TaskEvent[]> {
    return (await this.readEvents())
      .filter((event) => event.sequence > after)
      .slice(0, Math.max(1, Math.min(limit, 1000)));
  }

  ack(name: string, sequence: number): Promise<void> {
    return this.serialized(async () => {
      if (
        !Number.isSafeInteger(sequence) ||
        sequence < (this.data.cursors[name] ?? 0) ||
        sequence > this.data.sequence
      )
        throw new Error("Invalid event acknowledgement");
      this.data.cursors[name] = sequence;
      await this.persist();
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(
      () => {
        this.committed = clone(this.data);
      },
      () => undefined,
    );
    return result;
  }

  private async appendEvent(
    taskId: string,
    type: TaskEvent["type"],
    data: Record<string, unknown>,
  ): Promise<TaskEvent> {
    const event: TaskEvent = {
      version: PROTOCOL_VERSION,
      sequence: this.data.sequence + 1,
      timestamp: new Date().toISOString(),
      taskId,
      type,
      data,
    };
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flush: true,
      mode: 0o600,
    });
    await chmod(this.eventsPath, 0o600);
    this.data.sequence = event.sequence;
    await this.persist();
    return event;
  }

  private async readEvents(): Promise<TaskEvent[]> {
    let text: string;
    try {
      text = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = text.split("\n");
    const events: TaskEvent[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as TaskEvent);
      } catch (error) {
        if (index === lines.length - 1 && !text.endsWith("\n")) break;
        throw new Error(`Invalid event spool line ${index + 1}`, { cause: error });
      }
    }
    return events;
  }

  private async persist(): Promise<void> {
    const temp = `${this.snapshotPath}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, {
      encoding: "utf8",
      flush: true,
      mode: 0o600,
    });
    await chmod(temp, 0o600);
    await rename(temp, this.snapshotPath);
  }

  private async secureDirectory(): Promise<void> {
    try {
      const info = await lstat(this.dir);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe runtime directory: ${this.dir}`);
      if (typeof process.getuid === "function" && info.uid !== process.getuid())
        throw new Error(`Runtime directory is owned by another user: ${this.dir}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
    }
    await chmod(this.dir, 0o700);
  }

  private async secureFile(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unsafe runtime file: ${path}`);
    if (typeof process.getuid === "function" && info.uid !== process.getuid())
      throw new Error(`Runtime file is owned by another user: ${path}`);
    await chmod(path, 0o600);
  }
}
