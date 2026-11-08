import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedHook } from "../src/config.ts";
import { denial, hookEnvironment, runHook } from "../src/runner.ts";

const hook = (over: Partial<LoadedHook>): LoadedHook => ({
  event: "tool_call",
  source: "user",
  command: ["true"],
  ...over,
});

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-hooks-run-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("passes agent-controlled values through the environment, never the argument vector", () => {
  const environment = hookEnvironment({
    cwd: "/w",
    toolName: "write",
    toolInput: { path: "a.txt; rm -rf /" },
    sessionId: "s1",
  });
  assert.equal(environment.PI_HOOK_TOOL, "write");
  assert.equal(environment.PI_HOOK_SESSION, "s1");
  assert.equal(environment.PI_HOOK_INPUT, '{"path":"a.txt; rm -rf /"}');
  // A value that cannot serialize is omitted rather than partially rendered.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(hookEnvironment({ cwd: "/w", toolInput: circular }).PI_HOOK_INPUT, undefined);
});

test("reports a clean run and exposes the context to the command", async () => {
  await withDir(async (dir) => {
    const outcome = await runHook(
      hook({ command: [process.execPath, "-e", "process.stdout.write(process.env.PI_HOOK_TOOL)"] }),
      { cwd: dir, toolName: "edit" },
    );
    assert.equal(outcome.code, 0);
    assert.equal(outcome.stdout, "edit");
    assert.equal(denial(outcome), undefined);
  });
});

test("a shell metacharacter in tool input is inert", async () => {
  await withDir(async (dir) => {
    // Were the input pasted into a command line, the subshell would run and change stdout.
    const outcome = await runHook(
      hook({
        command: [process.execPath, "-e", "process.stdout.write(process.env.PI_HOOK_INPUT)"],
      }),
      { cwd: dir, toolName: "bash", toolInput: "$(echo pwned)" },
    );
    assert.equal(outcome.stdout, '"$(echo pwned)"');
  });
});

test("a blocking hook denies the call and carries its reason", async () => {
  await withDir(async (dir) => {
    const outcome = await runHook(
      hook({
        blockOnFailure: true,
        name: "guard",
        command: [
          process.execPath,
          "-e",
          "console.error('verification is stale');process.exitCode=1",
        ],
      }),
      { cwd: dir, toolName: "git_push" },
    );
    assert.equal(outcome.code, 1);
    assert.equal(denial(outcome), "guard denied this call: verification is stale");
  });
});

test("a failing hook that did not opt into blocking never denies", async () => {
  await withDir(async (dir) => {
    const outcome = await runHook(
      hook({ command: [process.execPath, "-e", "process.exitCode=2"] }),
      { cwd: dir },
    );
    assert.equal(outcome.code, 2);
    assert.equal(denial(outcome), undefined);
  });
});

test("a missing command is reported rather than thrown", async () => {
  await withDir(async (dir) => {
    const outcome = await runHook(
      hook({
        blockOnFailure: true,
        name: "absent",
        command: ["definitely-not-a-real-command-xyz"],
      }),
      { cwd: dir },
    );
    assert.equal(outcome.code, null);
    assert.ok(outcome.error);
    assert.match(denial(outcome) ?? "", /absent denied this call/);
  });
});

test("a hook that overruns its timeout is killed and reported", async () => {
  await withDir(async (dir) => {
    const outcome = await runHook(
      hook({ timeoutMs: 120, command: [process.execPath, "-e", "setInterval(()=>{},1000)"] }),
      { cwd: dir },
    );
    assert.equal(outcome.timedOut, true);
    assert.notEqual(outcome.code, 0);
  });
});
