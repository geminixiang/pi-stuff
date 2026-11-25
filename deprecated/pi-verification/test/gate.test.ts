import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AdvisoryVerificationGate } from "../src/gate.js";
import { normalizePlan } from "../src/plan.js";
import { VerificationStore } from "../src/store.js";
import type { VerificationStatus } from "../src/types.js";

function status(sha256: string, repairBudget: number): VerificationStatus {
  const plan = normalizePlan({
    checks: [{ id: "x", command: "node", args: ["--version"] }],
    repairBudget,
  });
  return {
    plan,
    evidence: null,
    state: "never-run",
    currentFingerprint: {
      head: "h",
      worktreeDiffSha256: "w",
      cachedDiffSha256: "c",
      untrackedSha256: "u",
      planSha256: "p",
      sha256,
    },
  };
}

test("advisory gate persists repair budget per fingerprint", async () => {
  const store = new VerificationStore(await mkdtemp(join(tmpdir(), "pi-gate-")));
  assert.deepEqual(await new AdvisoryVerificationGate(store).next(status("one", 1)), {
    attempt: 1,
    budget: 1,
  });
  assert.equal(await new AdvisoryVerificationGate(store).next(status("one", 1)), null);
  assert.deepEqual(await new AdvisoryVerificationGate(store).next(status("two", 1)), {
    attempt: 1,
    budget: 1,
  });
});

test("advisory gate ignores passed, inconclusive, and zero-budget states", async () => {
  const store = new VerificationStore(await mkdtemp(join(tmpdir(), "pi-gate-")));
  const gate = new AdvisoryVerificationGate(store);
  assert.equal(await gate.next(status("one", 0)), null);
  const passed = status("two", 2);
  passed.state = "passed";
  assert.equal(await gate.next(passed), null);
  const inconclusive = status("three", 2);
  inconclusive.state = "inconclusive";
  assert.equal(await gate.next(inconclusive), null);
});
