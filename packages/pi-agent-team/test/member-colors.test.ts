import assert from "node:assert/strict";
import test from "node:test";
import { accentCode, accentWrap } from "../src/member-colors.js";

test("accentCode is stable for the same member id and shared by TeamChatView and TeamRosterWidget", () => {
  assert.equal(accentCode("m7q2"), accentCode("m7q2"));
});

test("accentWrap surrounds text with that member's accent color and resets it after", () => {
  const wrapped = accentWrap("m7q2", "hi");
  const code = accentCode("m7q2");
  assert.equal(wrapped, `\x1b[38;5;${code}mhi\x1b[39m`);
});
