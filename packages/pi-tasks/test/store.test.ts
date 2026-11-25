import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatTask } from "../extensions/index.ts";
import { dbPath, TaskStore } from "../extensions/store.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "pi-tasks-"));

test("add, update and list tasks", () => {
  const store = new TaskStore(join(tmp(), "tasks.db"));
  const task = store.add({ title: "Fix", source_url: "https://github.com/o/r/issues/1" });
  assert.equal(task.status, "todo");
  store.update(task.id, { status: "running", agent_id: "a1" });
  store.add({ title: "Old", status: "done" });
  assert.deepEqual(
    store.list().map((t) => [t.title, t.status, t.agent_id]),
    [["Fix", "running", "a1"]],
  );
  assert.equal(store.list("all").length, 2);
  assert.equal(store.list("done")[0].title, "Old");
  assert.match(formatTask(store.get(task.id)), /#1 \[running\] Fix\n  source: .*\n  agent: a1/);
  store.close();
});

test("rejects unknown ids and statuses", () => {
  const store = new TaskStore(join(tmp(), "tasks.db"));
  assert.throws(() => store.update(9, { note: "x" }), /not found/);
  const { id } = store.add({ title: "t" });
  assert.throws(() => store.update(id, { status: "bogus" as never }), /Unknown status/);
  store.close();
});

test("database lives in the project .pi and is git-ignored", () => {
  const repo = tmp();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const sub = join(repo, "a");
  execFileSync("mkdir", [sub]);
  delete process.env.PI_TASKS_DB;
  const path = dbPath(sub);
  assert.equal(
    path,
    join(
      execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim(),
      ".pi",
      "tasks.db",
    ),
  );
  assert.equal(readFileSync(join(repo, ".pi", ".gitignore"), "utf8"), "tasks.db*\n");
  new TaskStore(path).add({ title: "x" });
  assert.ok(existsSync(path));
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
    "?? .pi/.gitignore",
  );
});

test("one running task per agent and attention list", () => {
  const store = new TaskStore(join(tmp(), "tasks.db"));
  const a = store.add({ title: "A", status: "running", agent_id: "3" });
  const b = store.add({ title: "B", status: "running", agent_id: "3" });
  const parked = store.handOff(b);
  assert.deepEqual(
    parked.map((t) => [t.id, t.status]),
    [[a.id, "todo"]],
  );
  assert.match(store.get(a.id).note ?? "", /moved to #2/);
  assert.deepEqual(store.handOff(store.add({ title: "C", status: "running" })), []);
  store.update(a.id, { due: "2000-01-01T00:00Z" });
  const { stale, due } = store.attention();
  assert.deepEqual(stale, []);
  assert.deepEqual(
    due.map((t) => t.id),
    [a.id],
  );
  store.close();
});
