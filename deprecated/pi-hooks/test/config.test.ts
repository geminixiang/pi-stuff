import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILENAME, loadHooks, parseConfig, readHooks, selectHooks } from "../src/config.ts";

const valid = {
  hooks: {
    tool_call: [{ command: ["true"], match: "^write$", blockOnFailure: true }],
    session_start: [{ command: ["echo", "hi"] }],
  },
};

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-hooks-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("accepts a valid configuration", () => {
  assert.deepEqual(parseConfig(valid), valid);
});

test("names the offending event or property instead of failing opaquely", () => {
  assert.throws(
    () => parseConfig({ hooks: { on_everything: [] } }),
    /unknown event "on_everything"; supported: session_start, /,
  );
  // A command must be an argument vector, so a shell string is rejected outright.
  assert.throws(() => parseConfig({ hooks: { tool_call: [{ command: "rm -rf /" }] } }), /command/);
  assert.throws(() => parseConfig({ hooks: { tool_call: [{ command: [] }] } }), /command/);
});

test("treats a missing file as no hooks and a broken file as a warning", async () => {
  await withDir(async (dir) => {
    const path = join(dir, CONFIG_FILENAME);
    assert.deepEqual(await readHooks(path, "user"), { hooks: [] });

    await writeFile(path, "{ not json");
    const broken = await readHooks(path, "user");
    assert.equal(broken.hooks.length, 0);
    assert.match(broken.warning ?? "", /hooks\.json/);

    // An unusable regex disables that file rather than throwing at match time.
    await writeFile(
      path,
      JSON.stringify({ hooks: { tool_call: [{ command: ["true"], match: "(" }] } }),
    );
    assert.match((await readHooks(path, "user")).warning ?? "", /invalid match/);
  });
});

test("rejects blockOnFailure on an event that cannot deny anything", async () => {
  await withDir(async (dir) => {
    const path = join(dir, CONFIG_FILENAME);
    await writeFile(
      path,
      JSON.stringify({ hooks: { turn_end: [{ command: ["true"], blockOnFailure: true }] } }),
    );
    const loaded = await readHooks(path, "user");
    assert.equal(loaded.hooks.length, 0);
    assert.match(loaded.warning ?? "", /blockOnFailure is only supported on tool_call/);
  });
});

test("an untrusted project cannot contribute hooks", async () => {
  await withDir(async (dir) => {
    const agentDir = join(dir, "agent");
    const cwd = join(dir, "project");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(agentDir, CONFIG_FILENAME),
      JSON.stringify({ hooks: { session_start: [{ command: ["true"], name: "mine" }] } }),
    );
    await writeFile(
      join(cwd, ".pi", CONFIG_FILENAME),
      JSON.stringify({ hooks: { session_start: [{ command: ["false"], name: "theirs" }] } }),
    );

    // A hooks file is executable configuration, so opening an untrusted checkout must not run it.
    const untrusted = await loadHooks(agentDir, cwd, ".pi", false);
    assert.deepEqual(
      untrusted.hooks.map((hook) => hook.name),
      ["mine"],
    );

    const trusted = await loadHooks(agentDir, cwd, ".pi", true);
    assert.deepEqual(
      trusted.hooks.map((hook) => hook.name),
      ["mine", "theirs"],
    );
    assert.deepEqual(
      trusted.hooks.map((hook) => hook.source),
      ["user", "project"],
    );
  });
});

test("selects hooks by event and tool name", async () => {
  await withDir(async (dir) => {
    const path = join(dir, CONFIG_FILENAME);
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          tool_call: [
            { command: ["a"], match: "^(write|edit)$", name: "matched" },
            { command: ["b"], name: "always" },
          ],
          turn_end: [{ command: ["c"], name: "other-event" }],
        },
      }),
    );
    const { hooks } = await readHooks(path, "user");
    assert.deepEqual(
      selectHooks(hooks, "tool_call", "write").map((hook) => hook.name),
      ["matched", "always"],
    );
    // An unmatched tool still runs the hooks that declared no match at all.
    assert.deepEqual(
      selectHooks(hooks, "tool_call", "bash").map((hook) => hook.name),
      ["always"],
    );
    // A hook with a match never fires for an event that carries no tool name.
    assert.deepEqual(
      selectHooks(hooks, "turn_end").map((hook) => hook.name),
      ["other-event"],
    );
  });
});
