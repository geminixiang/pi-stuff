import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STATUSES = ["todo", "running", "needs_input", "review", "done", "cancelled"] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
  id: number;
  title: string;
  source_url: string | null;
  plan: string | null;
  status: Status;
  agent_id: string | null;
  result: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export const FIELDS = [
  "title",
  "source_url",
  "plan",
  "status",
  "agent_id",
  "result",
  "note",
] as const;
export type Fields = Partial<Pick<Task, (typeof FIELDS)[number]>>;

/** Git toplevel of cwd, or cwd itself outside a repository. */
export function projectRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return cwd;
  }
}

/** `<project>/.pi/tasks.db`, keeping the database out of git via `.pi/.gitignore`. */
export function dbPath(cwd: string): string {
  if (process.env.PI_TASKS_DB) return process.env.PI_TASKS_DB;
  const dir = join(projectRoot(cwd), ".pi");
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "tasks.db*\n");
  return join(dir, "tasks.db");
}

export class TaskStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        source_url TEXT,
        plan TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        agent_id TEXT,
        result TEXT,
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
  }

  add(fields: Fields & { title: string }): Task {
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO tasks (title) VALUES (?)")
      .run(fields.title);
    return this.update(Number(lastInsertRowid), fields);
  }

  update(id: number, fields: Fields): Task {
    if (fields.status && !STATUSES.includes(fields.status)) {
      throw new Error(`Unknown status ${fields.status}; use ${STATUSES.join(", ")}`);
    }
    const keys = FIELDS.filter((key) => fields[key] !== undefined);
    if (keys.length > 0) {
      const sets = keys.map((key) => `${key} = ?`).join(", ");
      const values = keys.map((key) => fields[key] as string | null);
      const { changes } = this.db
        .prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
        .run(...values, id);
      if (changes === 0) throw new Error(`Task ${id} not found`);
    }
    return this.get(id);
  }

  get(id: number): Task {
    const task = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    return task as unknown as Task;
  }

  /** Open tasks by default (everything not done or cancelled). */
  list(status?: Status | "all"): Task[] {
    const rows =
      status === "all"
        ? this.db.prepare("SELECT * FROM tasks ORDER BY id").all()
        : status
          ? this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY id").all(status)
          : this.db
              .prepare("SELECT * FROM tasks WHERE status NOT IN ('done','cancelled') ORDER BY id")
              .all();
    return rows as unknown as Task[];
  }

  close(): void {
    this.db.close();
  }
}
