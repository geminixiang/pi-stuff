import assert from "node:assert/strict";
import test from "node:test";
import { parseCommands } from "../src/pi-agent.js";

test("a plain-text turn with no tool call is treated as wait", () => {
  assert.deepEqual(parseCommands("I have nothing to add right now."), [{ type: "wait" }]);
  assert.deepEqual(parseCommands(""), [{ type: "wait" }]);
});
