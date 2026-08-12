import assert from "node:assert/strict";
import test from "node:test";
import type { TeamTurn } from "../src/domain.js";
import { formatTurn, PiTeamAgent } from "../src/pi-agent.js";
import type { TurnState } from "../src/turn-state.js";

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
      blockedReasons: {},
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
      polls: [
        {
          pollId: "guesser",
          initiator: "a",
          tally: { a: 2, b: 1 },
          abstained: [],
          autoAbstained: [],
          missing: ["c"],
        },
      ],
    }),
  );
  assert.match(
    text,
    /OPEN POLLS: guesser initiator=a tally=\{"a":2,"b":1\} abstained=\[\] autoAbstained=\[\] missing=\["c"\]/,
  );
});

test("formatTurn surfaces a blocked member's state and reason in the digest", () => {
  const text = formatTurn(
    baseTurn({
      states: { a: "blocked", b: "waiting" },
      blockedReasons: { a: "needs approval" },
    }),
  );
  assert.match(text, /TEAM STATE: a=blocked, b=waiting/);
  assert.match(text, /BLOCKED: a="needs approval"/);
});

interface FakeSession {
  readonly sessionId: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getLastAssistantText?(): string | undefined;
}

interface AgentInternals {
  session: FakeSession;
  turnState: TurnState;
}

function agentWithSession(prompt: (internals: AgentInternals) => Promise<void>): PiTeamAgent {
  const agent = new PiTeamAgent({ id: "a", name: "A" }, "/tmp", {} as never);
  const internals = agent as unknown as AgentInternals;
  internals.session = {
    sessionId: "fake-session",
    prompt: () => prompt(internals),
    abort: async () => {},
    dispose: () => {},
  };
  return agent;
}

test("a provider failure after a non-terminal command was queued rethrows instead of committing the half batch", async () => {
  // Regression: act() used to treat "anything was queued" as proof the
  // prompt failure was its own turn-ending self-abort. A provider can die
  // after a say was queued but before any turn-ending command — that turn
  // produced half a plan, and swallowing the error would hand the runtime
  // the half batch as if the agent had deliberately stopped there.
  const agent = agentWithSession(async (internals) => {
    internals.turnState.apply({ type: "say", body: "first half of a plan" }, "spoken publicly");
    throw new Error("provider exploded mid-turn");
  });
  await assert.rejects(
    agent.act(baseTurn(), new AbortController().signal),
    /provider exploded mid-turn/,
  );
});

test("report() sends the prompt and returns the last assistant text verbatim", async () => {
  const agent = new PiTeamAgent({ id: "a", name: "A" }, "/tmp", {} as never);
  const internals = agent as unknown as { session: FakeSession };
  let prompted: string | undefined;
  internals.session = {
    sessionId: "fake-session",
    prompt: async (text) => {
      prompted = text;
    },
    abort: async () => {},
    dispose: () => {},
    getLastAssistantText: () => "the final report",
  };
  const body = await agent.report("REPORT NOW", new AbortController().signal);
  assert.equal(body, "the final report");
  assert.equal(prompted, "REPORT NOW");
});

test("a report turn that produces no assistant text rejects instead of returning emptiness", async () => {
  const agent = new PiTeamAgent({ id: "a", name: "A" }, "/tmp", {} as never);
  const internals = agent as unknown as { session: FakeSession };
  internals.session = {
    sessionId: "fake-session",
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
    getLastAssistantText: () => "   ",
  };
  await assert.rejects(
    agent.report("REPORT NOW", new AbortController().signal),
    /no final response/,
  );
});

test("team tools called mid-report get a settled notice: nothing queues and the prompt is not aborted", async () => {
  // A reporter reflexively calling team_say/team_finish during the report
  // turn must neither reopen the settled runtime (queued commands) nor cut
  // its own report short (the turn-ending self-abort).
  const agent = new PiTeamAgent({ id: "a", name: "A" }, "/tmp", {} as never);
  const internals = agent as unknown as {
    session: FakeSession;
    turnState: TurnState;
    queueCommand(command: unknown, confirmation: string): { content: [{ text: string }] };
  };
  let aborted = 0;
  internals.session = {
    sessionId: "fake-session",
    prompt: async () => {
      const outcome = internals.queueCommand({ type: "finish", summary: "x" }, "finished");
      assert.match(outcome.content[0].text, /TEAM_SETTLED/);
    },
    abort: async () => {
      aborted += 1;
    },
    dispose: () => {},
    getLastAssistantText: () => "final",
  };
  const body = await agent.report("REPORT NOW", new AbortController().signal);
  assert.equal(body, "final");
  assert.equal(aborted, 0);
  assert.equal(internals.turnState.queued.length, 0);
});

test("the self-abort raised by a turn-ending command is still swallowed and the full batch committed", async () => {
  const agent = agentWithSession(async (internals) => {
    internals.turnState.apply({ type: "say", body: "done, wrapping up" }, "spoken publicly");
    internals.turnState.apply({ type: "finish", summary: "all done" }, "finished");
    // queueCommand aborts the session on a turn-ending command; the prompt
    // then rejects with the abort. That is the one expected failure.
    throw new Error("aborted by turn-ending command");
  });
  const commands = await agent.act(baseTurn(), new AbortController().signal);
  assert.deepEqual(commands, [
    { type: "say", body: "done, wrapping up" },
    { type: "finish", summary: "all done" },
  ]);
});

test("team_block ends the turn like wait/finish: the queued command survives the self-abort", async () => {
  const agent = agentWithSession(async (internals) => {
    internals.turnState.apply({ type: "block", reason: "need requester input" }, "blocked");
    // queueCommand aborts the session on a turn-ending command; the prompt
    // then rejects with the abort. That is the one expected failure.
    throw new Error("aborted by turn-ending command");
  });
  const commands = await agent.act(baseTurn(), new AbortController().signal);
  assert.deepEqual(commands, [{ type: "block", reason: "need requester input" }]);
});
