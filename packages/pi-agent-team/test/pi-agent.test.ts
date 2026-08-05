import assert from "node:assert/strict";
import test from "node:test";
import type { TeamTurn } from "../src/domain.js";
import { formatTurn } from "../src/pi-agent.js";

function baseTurn(digest: Partial<TeamTurn["digest"]> = {}): TeamTurn {
  return {
    teamId: "t",
    objective: "play a game",
    member: { id: "a", name: "A" },
    peers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    observations: [],
    digest: {
      states: { a: "running", b: "waiting" },
      claims: {},
      groups: [],
      polls: [],
      ...digest,
    },
    turn: 1,
  };
}

test("formatTurn omits OPEN POLLS when no poll is live, matching HELD CLAIMS/YOUR GROUPS' own omit-when-empty behavior", () => {
  const text = formatTurn(baseTurn());
  assert.doesNotMatch(text, /OPEN POLLS/);
});

test("formatTurn surfaces live poll tally and missing voters directly in the prompt, not only in past public speech", () => {
  // Without this, a member's only way to know a poll's live state is by
  // re-reading transcript history for a POLL_FULLY_CAST/POLL_CLOSED notice
  // — the digest already carries this (invariant 1), but the adapter that
  // turns the digest into the actual prompt was silently dropping it.
  const text = formatTurn(
    baseTurn({
      polls: [{ pollId: "guesser", tally: { a: 2, b: 1 }, missing: ["c"] }],
    }),
  );
  assert.match(text, /OPEN POLLS: guesser tally=\{"a":2,"b":1\} missing=\["c"\]/);
});
