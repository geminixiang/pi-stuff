import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  MemoryConflictError,
  MemoryCorruptionError,
  MemoryStore,
  SensitiveMemoryError,
  UnsafeMemoryPathError,
  eventPath,
  retrievalContext,
  storageAnchor,
} from "../src/store.js";

async function fixture(): Promise<{
  root: string;
  cwd: string;
  agentDir: string;
  store: MemoryStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { root, cwd, agentDir, store: new MemoryStore(cwd, agentDir) };
}

const proposal = {
  scope: "project" as const,
  text: "Use PostgreSQL for the audit database",
  provenance: { source: "architecture decision 42", author: "user" },
  confidence: 0.9,
  tags: ["database", "audit"],
};

test("candidate lifecycle is append-only and searchable by status", async () => {
  const { cwd, agentDir, store } = await fixture();
  const candidate = await store.propose(proposal);
  assert.equal(candidate.status, "candidate");
  assert.equal(
    (await store.search("PostgreSQL", { statuses: ["candidate"] }))[0]?.id,
    candidate.id,
  );
  const active = await store.manage("approve", candidate.id);
  assert.equal(active.status, "active");
  assert.equal((await store.search("audit"))[0]?.id, candidate.id);

  const replacement = await store.propose({
    ...proposal,
    text: "Use SQLite for local audit tests",
  });
  await store.manage("approve", replacement.id);
  const superseded = await store.manage("supersede", candidate.id, replacement.id);
  assert.equal(superseded.status, "superseded");
  await store.manage("delete", replacement.id);
  assert.equal((await store.load()).find((item) => item.id === replacement.id)?.status, "deleted");

  const lines = (await readFile(eventPath("project", cwd, agentDir), "utf8")).trim().split("\n");
  assert.equal(lines.length, 6);
});

test("supports rejected lifecycle and both scopes", async () => {
  const { cwd, agentDir, store } = await fixture();
  const candidate = await store.propose({ ...proposal, scope: "user" });
  await store.manage("reject", candidate.id);
  assert.equal((await store.load("user"))[0]?.status, "rejected");
  assert.equal(eventPath("user", cwd, agentDir), join(agentDir, "memory", "v1", "events.jsonl"));
});

test("both scopes store memory/v1 and take their directory from the host", async () => {
  const cwd = "/workspace";
  // Project storage sits under the host's configured directory name, not a hardcoded ".pi".
  assert.equal(
    eventPath("project", cwd, "/agent"),
    join(cwd, CONFIG_DIR_NAME, "memory", "v1", "events.jsonl"),
  );
  // User storage follows getAgentDir(), which honours PI_CODING_AGENT_DIR.
  assert.equal(eventPath("user", cwd), join(getAgentDir(), "memory", "v1", "events.jsonl"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "relocated-agent");
  try {
    assert.equal(
      eventPath("user", cwd),
      join(tmpdir(), "relocated-agent", "memory", "v1", "events.jsonl"),
    );
    // A relocated agent directory anchors at its parent, since it is no longer under home.
    assert.equal(storageAnchor("user", cwd), tmpdir());
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("writes and reads a relocated agent directory end to end", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-relocated-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "elsewhere", "agent");
  try {
    await mkdir(join(root, "elsewhere"), { recursive: true });
    const store = new MemoryStore(join(root, "project"));
    const candidate = await store.propose({ ...proposal, scope: "user" });
    assert.equal((await store.load("user"))[0]?.id, candidate.id);
    await readFile(join(root, "elsewhere", "agent", "memory", "v1", "events.jsonl"), "utf8");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("retrieval includes only active unexpired memory, provenance, and bounds", async () => {
  const { store } = await fixture();
  const active = await store.propose(proposal);
  await store.manage("approve", active.id);
  const expired = await store.propose({
    ...proposal,
    text: "Expired PostgreSQL note",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  await store.manage("approve", expired.id);
  await store.propose({ ...proposal, text: "Candidate PostgreSQL note" });
  for (let index = 0; index < 7; index++) {
    const item = await store.propose({
      ...proposal,
      text: `PostgreSQL detail ${index} ${"x".repeat(300)}`,
    });
    await store.manage("approve", item.id);
  }
  const context = await retrievalContext(store, "PostgreSQL audit");
  assert.ok(context);
  assert.match(context, /provenance: architecture decision 42/);
  assert.doesNotMatch(context, /Expired/);
  assert.doesNotMatch(context, /Candidate/);
  assert.ok(context.length <= 2000);
  assert.ok(context.split("\n").length <= 6);
});

test("secret scanner rejects without putting secret in error", async () => {
  const { store } = await fixture();
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  await assert.rejects(
    store.propose({ ...proposal, text: `credential ${secret}` }),
    (error: unknown) => error instanceof SensitiveMemoryError && !error.message.includes(secret),
  );
});

test("tolerates a truncated trailing JSONL event", async () => {
  const { cwd, agentDir, store } = await fixture();
  const candidate = await store.propose(proposal);
  const path = eventPath("project", cwd, agentDir);
  await writeFile(path, `${await readFile(path, "utf8")}{"version":1`, "utf8");
  assert.equal((await store.load())[0]?.id, candidate.id);
});

test("rejects symlinked storage components and secures directories", async () => {
  const { root, cwd, agentDir, store } = await fixture();
  const outside = join(root, "outside");
  await mkdir(outside);
  await mkdir(join(cwd, ".pi"));
  await symlink(outside, join(cwd, ".pi", "memory"));
  await assert.rejects(store.propose(proposal), UnsafeMemoryPathError);

  const safeCwd = join(root, "safe");
  await mkdir(safeCwd);
  const safeStore = new MemoryStore(safeCwd, agentDir);
  await safeStore.propose(proposal);
  const mode = (await lstat(join(safeCwd, ".pi", "memory", "v1"))).mode & 0o777;
  assert.equal(mode, 0o700);
  await chmod(join(safeCwd, ".pi", "memory", "v1"), 0o755);
});

test("serializes concurrent appends", async () => {
  const { store } = await fixture();
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      store.propose({ ...proposal, text: `audit database ${index}` }),
    ),
  );
  assert.equal((await store.load()).length, 20);
});

test("rejects forged active proposals and malformed complete events as corruption", async () => {
  const { cwd, agentDir, store } = await fixture();
  const candidate = await store.propose(proposal);
  const path = eventPath("project", cwd, agentDir);
  const original = await readFile(path, "utf8");
  const forged = JSON.parse(original.trim());
  forged.record.status = "active";
  await writeFile(path, `${JSON.stringify(forged)}\n`, "utf8");
  await assert.rejects(store.load(), MemoryCorruptionError);
  await writeFile(path, `${original}{"version":1,"action":"approve"}\n`, "utf8");
  await assert.rejects(store.load(), MemoryCorruptionError);
  assert.equal(candidate.status, "candidate");
});

test("expected version and status prevent stale confirmation races", async () => {
  const { store } = await fixture();
  const candidate = await store.propose(proposal);
  const expectation = { expectedVersion: candidate.version, expectedStatus: candidate.status };
  await store.manage("approve", candidate.id, undefined, expectation);
  await assert.rejects(
    store.manage("reject", candidate.id, undefined, expectation),
    MemoryConflictError,
  );
});

test("untrusted projects neither read nor inject project memory", async () => {
  const { cwd, agentDir, store } = await fixture();
  const candidate = await store.propose(proposal);
  await store.manage("approve", candidate.id);
  const untrusted = new MemoryStore(cwd, agentDir, false);
  assert.deepEqual(await untrusted.load("project"), []);
  assert.equal(await retrievalContext(untrusted, "PostgreSQL audit"), undefined);
  await assert.rejects(untrusted.propose(proposal), /untrusted/);
  await assert.rejects(untrusted.manage("approve", candidate.id), /not found/i);
});
