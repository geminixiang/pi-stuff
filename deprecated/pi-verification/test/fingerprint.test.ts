import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fingerprint } from "../src/fingerprint.js";
import { normalizePlan } from "../src/plan.js";

const exec = promisify(execFile);

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-verification-git-"));
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await exec("git", ["config", "user.name", "Test"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "one\n");
  await exec("git", ["add", "tracked.txt"], { cwd: root });
  await exec("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

test("fingerprint covers HEAD, worktree diff, cached diff, and canonical plan", async () => {
  const root = await repository();
  const plan = normalizePlan({ checks: [{ id: "ok", command: "node", args: ["--version"] }] });
  const initial = await fingerprint(root, plan);
  assert.equal(initial.head.length, 40);
  await writeFile(join(root, "tracked.txt"), "two\n");
  const dirty = await fingerprint(root, plan);
  assert.notEqual(dirty.sha256, initial.sha256);
  await exec("git", ["add", "tracked.txt"], { cwd: root });
  const staged = await fingerprint(root, plan);
  assert.notEqual(staged.sha256, dirty.sha256);
  const changedPlan = normalizePlan({ checks: [{ id: "ok", command: "node", args: ["-v"] }] });
  assert.notEqual((await fingerprint(root, changedPlan)).planSha256, staged.planSha256);

  await writeFile(join(root, "untracked.txt"), "alpha\n");
  const untracked = await fingerprint(root, plan);
  await writeFile(join(root, "untracked.txt"), "beta\n");
  assert.notEqual((await fingerprint(root, plan)).untrackedSha256, untracked.untrackedSha256);

  await symlink("untracked.txt", join(root, "link"));
  const linked = await fingerprint(root, plan);
  await writeFile(join(root, "untracked.txt"), "gamma\n");
  assert.notEqual((await fingerprint(root, plan)).sha256, linked.sha256);
  assert.equal((await lstat(join(root, "link"))).isSymbolicLink(), true);
});
