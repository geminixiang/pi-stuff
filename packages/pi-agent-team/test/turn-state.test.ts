import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand } from "../src/domain.js";
import { endsTurn, TurnState } from "../src/turn-state.js";

test("wait, finish, and claim end the turn; say/dm/handoff/release/group ops do not", () => {
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
    { type: "vote-cast", pollId: "p", choice: "a" },
    { type: "vote-close", pollId: "p" },
  ];
  for (const command of terminal) assert.equal(endsTurn(command), true, command.type);
  for (const command of nonTerminal) assert.equal(endsTurn(command), false, command.type);
});

test("a non-terminal command is accepted, does not end the turn, and stays queued", () => {
  const state = new TurnState();
  const result = state.apply({ type: "say", body: "hi" }, "spoken publicly");
  assert.deepEqual(result, { text: "spoken publicly", endsTurn: false });
  assert.deepEqual(state.queued, [{ type: "say", body: "hi" }]);
});

test("say followed by finish is a valid combo: both queue, only finish ends the turn", () => {
  const state = new TurnState();
  const first = state.apply({ type: "say", body: "hi" }, "spoken publicly");
  const second = state.apply({ type: "finish", summary: "done" }, "finished");
  assert.equal(first.endsTurn, false);
  assert.equal(second.endsTurn, true);
  assert.deepEqual(state.queued, [
    { type: "say", body: "hi" },
    { type: "finish", summary: "done" },
  ]);
});

test("wait ends the turn and further commands are rejected as turn-ended", () => {
  const state = new TurnState();
  const waited = state.apply({ type: "wait" }, "waiting");
  assert.equal(waited.endsTurn, true);
  const after = state.apply({ type: "wait" }, "waiting");
  assert.equal(after.endsTurn, false);
  assert.match(after.text, /turn already ended/);
  assert.deepEqual(state.queued, [{ type: "wait" }], "the rejected repeat is never queued");
});

test("a solo claim is accepted and ends the turn", () => {
  const state = new TurnState();
  const result = state.apply({ type: "claim", resource: "seat" }, "claim queued");
  assert.deepEqual(result, { text: "claim queued", endsTurn: true });
});

test("claiming after already saying something this turn is rejected as claim-must-be-sole-action", () => {
  const state = new TurnState();
  state.apply({ type: "say", body: "hi" }, "spoken publicly");
  const claimed = state.apply({ type: "claim", resource: "seat" }, "claim queued");
  assert.equal(claimed.endsTurn, false);
  assert.match(claimed.text, /must be the only action/);
  assert.deepEqual(state.queued, [{ type: "say", body: "hi" }], "the rejected claim is never queued");
});

test("anything after a claim is rejected as blocked-by-pending-claim, distinct from turn-ended", () => {
  const state = new TurnState();
  state.apply({ type: "claim", resource: "seat" }, "claim queued");
  const after = state.apply({ type: "say", body: "hi" }, "spoken publicly");
  assert.equal(after.endsTurn, false);
  assert.match(after.text, /blocked by pending claim/);
});

test("reset clears queued commands and both guard flags between turns", () => {
  const state = new TurnState();
  state.apply({ type: "claim", resource: "seat" }, "claim queued");
  state.reset();
  assert.deepEqual(state.queued, []);
  const result = state.apply({ type: "say", body: "hi" }, "spoken publicly");
  assert.equal(result.endsTurn, false);
  assert.equal(result.text, "spoken publicly", "the claim fence from before reset must not leak");
});
