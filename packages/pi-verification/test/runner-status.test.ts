import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LocalTaskClient } from "../src/local-client.js";
import { normalizePlan } from "../src/plan.js";
import { runVerification } from "../src/runner.js";
import { getVerificationStatus } from "../src/status.js";
import { VerificationStore } from "../src/store.js";

const exec = promisify(execFile);
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-verification-run-"));
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "file"), "initial\n");
  await exec("git", ["add", "file"], { cwd: root });
  await exec("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

test("required pass, optional failure yields overall pass", async () => {
  const root = await repository();
  const plan = normalizePlan({
    checks: [
      { id: "pass", command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
      {
        id: "optional",
        command: process.execPath,
        args: ["-e", "process.exit(2)"],
        requirement: "optional",
      },
    ],
  });
  const evidence = await runVerification(root, plan, new LocalTaskClient());
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.checks[0]?.stdoutSummary, "ok");
  assert.equal(evidence.checks[1]?.status, "failed");
});

test("required failure and timeout fail verification", async () => {
  const root = await repository();
  const plan = normalizePlan({
    checks: [
      { id: "fail", command: process.execPath, args: ["-e", "process.exit(3)"] },
      {
        id: "timeout",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        timeoutMs: 30,
      },
    ],
    concurrency: 2,
  });
  const evidence = await runVerification(root, plan, new LocalTaskClient());
  assert.equal(evidence.status, "failed");
  assert.equal(evidence.checks[0]?.exitCode, 3);
  assert.equal(evidence.checks[1]?.status, "timeout");
});

test("status becomes stale after tracked changes", async () => {
  const root = await repository();
  const store = new VerificationStore(root);
  const plan = normalizePlan({
    checks: [{ id: "pass", command: process.execPath, args: ["-e", ""] }],
  });
  await store.savePlan(plan);
  await store.saveEvidence(await runVerification(root, plan, new LocalTaskClient()));
  assert.equal((await getVerificationStatus(root, store)).state, "passed");
  await writeFile(join(root, "file"), "changed\n");
  assert.equal((await getVerificationStatus(root, store)).state, "stale");
});
