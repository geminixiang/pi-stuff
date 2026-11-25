import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { TERMINAL_STATES } from "@geminixiang/pi-task-protocol";
import { TaskRunner } from "../src/runner.ts";
import { DurableStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);

async function fixture(
  t: TestContext,
): Promise<{ store: DurableStore; runner: TaskRunner; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "supervisor-lifecycle-"));
  const store = new DurableStore(dir);
  await store.open();
  const runner = new TaskRunner(store);
  const groups = new Set<number>();
  // Cleanup tracks only the process groups created by this isolated fixture, even when
  // a regression incorrectly publishes a terminal state while leaving a descendant alive.
  const start = runner.start.bind(runner);
  t.mock.method(runner, "start", async (spec: Parameters<TaskRunner["start"]>[0]) => {
    const task = await start(spec);
    if (task.pid) groups.add(task.pid);
    return task;
  });
  t.after(async () => {
    for (const task of store.list()) {
      if (!TERMINAL_STATES.has(task.state)) await runner.stop(task.id, 100).catch(() => undefined);
    }
    for (const pid of groups) {
      try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { store, runner, dir };
}

async function assertExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)]);
      // Linux may leave an orphaned child zombie until PID 1 reaps it.
      if (!stdout.trim() || stdout.trim().startsWith("Z")) return;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return;
      throw error;
    }
    await delay(20);
  }
  assert.fail(`Fixture process ${pid} is still running`);
}

test("missing executable settles as one failed task without an unhandled rejection", async (t) => {
  const { runner, store, dir } = await fixture(t);
  const task = await runner.start({ command: "pi-supervisor-nonexistent-executable", cwd: dir });
  assert.equal(task.state, "failed");
  await delay(50);
  assert.equal((await store.events(0)).filter((event) => event.type === "terminal").length, 1);
});

test("passes arguments literally and preserves UTF-8, binary bytes, and final newlines", async (t) => {
  const { runner, dir } = await fixture(t);
  const literal = "$(touch SHOULD-NOT-EXIST); 'quoted' * café 中文";
  const task = await runner.start({
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write(process.argv[1]+'\\n');process.stderr.write(Buffer.from([0,255,10]));",
      literal,
    ],
    cwd: dir,
  });
  assert.equal((await runner.wait(task.id)).state, "succeeded");
  assert.equal((await runner.output(task.id)).text, literal + "\n");
  assert.equal((await runner.output(task.id, "stderr")).size, 3);
});

test(
  "stop gives a TERM handler its requested grace and flushes final output",
  { skip: process.platform === "win32" },
  async (t) => {
    const { runner, dir } = await fixture(t);
    const task = await runner.start({
      command: process.execPath,
      args: [
        "-e",
        "const keep=setInterval(()=>{},1000);process.on('SIGTERM',()=>setTimeout(()=>{console.log('final stdout');console.error('final stderr');clearInterval(keep)},200));console.log('armed')",
      ],
      cwd: dir,
      readiness: { type: "output", substring: "armed" },
    });
    assert.equal((await runner.wait(task.id)).state, "ready");
    const began = performance.now();
    const done = await runner.stop(task.id, 1_500);
    assert.equal(done.state, "stopped");
    assert.equal(done.exitCode, 0);
    assert.equal(done.signal, null);
    assert.ok(performance.now() - began >= 180);
    assert.match((await runner.output(task.id)).text, /final stdout\n$/);
    assert.match((await runner.output(task.id, "stderr")).text, /final stderr\n$/);
  },
);

test(
  "stop escalates after the caller grace and kills a TERM-resistant descendant",
  { skip: process.platform === "win32" },
  async (t) => {
    const { runner, dir } = await fixture(t);
    const descendant =
      "process.on('SIGTERM',()=>{});console.log('descendant '+process.pid);setInterval(()=>{},1000)";
    const task = await runner.start({
      command: process.execPath,
      args: [
        "-e",
        `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`,
      ],
      cwd: dir,
      readiness: { type: "output", substring: "descendant " },
    });
    assert.equal((await runner.wait(task.id)).state, "ready");
    const descendantPid = Number(
      (await runner.output(task.id)).text.match(/descendant (\d+)/)?.[1],
    );
    assert.ok(Number.isSafeInteger(descendantPid));
    const began = performance.now();
    const done = await runner.stop(task.id, 250);
    const elapsed = performance.now() - began;
    assert.equal(done.state, "stopped");
    assert.equal(done.signal, "SIGKILL");
    assert.ok(elapsed >= 230, `Grace ended too early: ${elapsed}ms`);
    assert.ok(elapsed < 2_500, `Ignored caller grace: ${elapsed}ms`);
    await assertExited(task.pid!);
    await assertExited(descendantPid);
  },
);

test(
  "stop still kills descendants after their group leader exits on TERM",
  { skip: process.platform === "win32" },
  async (t) => {
    const { runner, dir } = await fixture(t);
    const descendant =
      "process.on('SIGTERM',()=>{});console.log('descendant '+process.pid);setInterval(()=>{},1000)";
    const task = await runner.start({
      command: process.execPath,
      args: [
        "-e",
        `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});setInterval(()=>{},1000)`,
      ],
      cwd: dir,
      readiness: { type: "output", substring: "descendant " },
    });
    assert.equal((await runner.wait(task.id)).state, "ready");
    const descendantPid = Number(
      (await runner.output(task.id)).text.match(/descendant (\d+)/)?.[1],
    );
    assert.ok(Number.isSafeInteger(descendantPid));
    const done = await runner.stop(task.id, 250);
    assert.equal(done.state, "stopped");
    assert.equal(done.signal, "SIGTERM");
    await assertExited(descendantPid);
  },
);

test(
  "stop honors a grace period longer than Execa's default escalation deadline",
  { skip: process.platform === "win32" },
  async (t) => {
    const { runner, dir } = await fixture(t);
    const task = await runner.start({
      command: process.execPath,
      args: [
        "-e",
        "const keep=setInterval(()=>{},1000);process.on('SIGTERM',()=>setTimeout(()=>{console.log('long cleanup complete');clearInterval(keep)},5200));console.log('armed')",
      ],
      cwd: dir,
      readiness: { type: "output", substring: "armed" },
    });
    assert.equal((await runner.wait(task.id)).state, "ready");
    const done = await runner.stop(task.id, 7_000);
    assert.equal(done.state, "stopped");
    assert.equal(done.exitCode, 0);
    assert.equal(done.signal, null);
    assert.match((await runner.output(task.id)).text, /long cleanup complete\n$/);
  },
);

for (const kind of ["run", "readiness"] as const) {
  test(
    `${kind} timeout escalates for a TERM-resistant process and retains failure classification`,
    { skip: process.platform === "win32" },
    async (t) => {
      const { runner, store, dir } = await fixture(t);
      const task = await runner.start({
        command: process.execPath,
        args: [
          "-e",
          "process.on('SIGTERM',()=>console.log('received TERM'));console.log('armed');setInterval(()=>{},1000)",
        ],
        cwd: dir,
        runTimeoutMs: kind === "run" ? 500 : undefined,
        readiness: kind === "readiness" ? { type: "output", substring: "never" } : undefined,
        readinessTimeoutMs: 500,
      });
      const done = await runner.wait(task.id, 10_000);
      assert.equal(done.state, "failed");
      assert.equal(done.signal, "SIGKILL");
      assert.equal(done.terminationReason, `${kind}_timed_out`);
      assert.equal(done.error, kind === "run" ? "Run timed out" : "Readiness timed out");
      assert.match((await runner.output(task.id)).text, /received TERM/);
      const terminal = (await store.events(0)).filter((event) => event.type === "terminal");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0]?.data.reason, `${kind}_timed_out`);
      await assertExited(task.pid!);
    },
  );
}

test(
  "recovery still validates the identity of an Execa-owned process group",
  { skip: process.platform === "win32" },
  async (t) => {
    const { runner, store, dir } = await fixture(t);
    const task = await runner.start({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: dir,
    });
    assert.match(task.processIdentity!, new RegExp(`^${task.pid} ${task.pid} `));
    const recoveredStore = new DurableStore(dir);
    await recoveredStore.open();
    // Model a restart without starting another daemon or allowing the original runner's
    // completion callback to mutate the replacement store.
    t.mock.method(store, "transition", async () => {
      throw new Error("Original daemon unavailable");
    });
    await new TaskRunner(recoveredStore).recover();
    const recovered = recoveredStore.get(task.id)!;
    assert.equal(recovered.state, "failed");
    assert.match(recovered.error!, /verified process group stopped/);
    await assertExited(task.pid!);
  },
);
