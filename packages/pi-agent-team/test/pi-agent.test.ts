import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand } from "../src/domain.js";
import { endsTurn, parseCommands } from "../src/pi-agent.js";

test("wait, finish, and claim end the turn; say/dm/handoff/release do not", () => {
  const terminal: TeamCommand[] = [
    { type: "wait" },
    { type: "finish", summary: "done" },
    { type: "claim", resource: "r" },
  ];
  const nonTerminal: TeamCommand[] = [
    { type: "say", body: "hi" },
    { type: "send", to: "b", body: "hi" },
    { type: "handoff", to: "b", body: "hi" },
    { type: "release", resource: "r" },
    { type: "create-group", channelId: "g", name: "G", members: ["b"] },
    { type: "group-send", channelId: "g", body: "hi" },
  ];
  for (const command of terminal) assert.equal(endsTurn(command), true, command.type);
  for (const command of nonTerminal) assert.equal(endsTurn(command), false, command.type);
});

test("a plain-text turn with no tool call is treated as wait", () => {
  assert.deepEqual(parseCommands("I have nothing to add right now."), [{ type: "wait" }]);
  assert.deepEqual(parseCommands(""), [{ type: "wait" }]);
});
