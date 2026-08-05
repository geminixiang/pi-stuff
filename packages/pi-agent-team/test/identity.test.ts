import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand, TeamMember, TeamTurn } from "../src/domain.js";
import { assertValidMemberId } from "../src/domain.js";
import { assertUniqueMemberRoster } from "../src/extension.js";
import { TeamRuntime } from "../src/runtime.js";

test("assertValidMemberId rejects empty, whitespace-only, and reserved principal ids", () => {
  assert.throws(() => assertValidMemberId(""), /must not be empty/);
  assert.throws(() => assertValidMemberId("   "), /must not be empty/);
  assert.throws(() => assertValidMemberId("user"), /reserved principal id/);
  assert.throws(() => assertValidMemberId("runtime"), /reserved principal id/);
  assert.doesNotThrow(() => assertValidMemberId("m7q2"));
  assert.doesNotThrow(() => assertValidMemberId("all"), "the 'all' sentinel is extension-specific, not a domain-level reservation");
});

test("TeamRuntime rejects a member id colliding with a reserved principal id", () => {
  class Agent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  assert.throws(
    () =>
      new TeamRuntime(
        "obj",
        new Map([
          ["user", new Agent({ id: "user", name: "User" })],
          ["b", new Agent({ id: "b", name: "B" })],
        ]),
      ),
    /reserved principal id/,
  );
  assert.throws(
    () =>
      new TeamRuntime(
        "obj",
        new Map([
          ["", new Agent({ id: "", name: "Empty" })],
          ["b", new Agent({ id: "b", name: "B" })],
        ]),
      ),
    /must not be empty/,
  );
});

test("assertUniqueMemberRoster rejects duplicate ids before they can silently fold into one Map entry", () => {
  assert.throws(
    () =>
      assertUniqueMemberRoster([
        { id: "a", name: "First A" },
        { id: "a", name: "Second A" },
        { id: "b", name: "B" },
      ]),
    /Duplicate member id "a"/,
  );
});

test("assertUniqueMemberRoster rejects the 'all' sentinel reserved for startMemberId", () => {
  assert.throws(
    () =>
      assertUniqueMemberRoster([
        { id: "all", name: "All" },
        { id: "b", name: "B" },
      ]),
    /reserved for startMemberId/,
  );
});

test("assertUniqueMemberRoster rejects empty/reserved member ids via assertValidMemberId", () => {
  assert.throws(
    () =>
      assertUniqueMemberRoster([
        { id: "runtime", name: "Runtime" },
        { id: "b", name: "B" },
      ]),
    /reserved principal id/,
  );
});

test("assertUniqueMemberRoster accepts a clean roster", () => {
  assert.doesNotThrow(() =>
    assertUniqueMemberRoster([
      { id: "m7q", name: "A" },
      { id: "x2v", name: "B" },
    ]),
  );
});
