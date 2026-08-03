import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJson, normalizePlan } from "../src/plan.js";
import { VerificationStore } from "../src/store.js";

test("normalizes defaults and rejects shell-string-shaped plans without args", () => {
  const plan = normalizePlan({ checks: [{ id: "types", command: "npm", args: ["run", "check"] }] });
  assert.equal(plan.concurrency, 2);
  assert.equal(plan.checks[0]?.requirement, "required");
  assert.equal(plan.checks[0]?.timeoutMs, 120_000);
  assert.throws(() => normalizePlan({ checks: [{ id: "bad", command: "npm run check" }] }), /args/);
  assert.throws(
    () =>
      normalizePlan({
        checks: [
          { id: "x", command: "npm", args: [] },
          { id: "x", command: "npm", args: [] },
        ],
      }),
    /duplicate/,
  );
});

test("canonical JSON is key-order independent", () => {
  assert.equal(
    canonicalJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("store persists plan and evidence under project-local v1 directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-verification-store-"));
  const store = new VerificationStore(root);
  const plan = normalizePlan({ checks: [{ id: "ok", command: "node", args: ["--version"] }] });
  await store.savePlan(plan);
  assert.deepEqual(await store.loadPlan(), plan);
  assert.match(store.directory, /\.pi\/verification-local\/v1$/);
});
