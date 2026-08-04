import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand, TeamMember, TeamTurn } from "../src/domain.js";
import { TeamRuntime } from "../src/runtime.js";

test("a poll tallies votes into a clear winner, visible live in the digest before close", async () => {
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
    { id: "d", name: "D" },
  ];
  const coordinatorDigests: TeamTurn["digest"][] = [];

  class Coordinator {
    readonly member = members[0];
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      coordinatorDigests.push(turn.digest);
      // Opening a brand-new pollId requires holding a claim on it first.
      if (turn.turn === 1) return [{ type: "claim", resource: "guesser" }];
      if (turn.turn === 2)
        return [
          { type: "vote-cast", pollId: "guesser", choice: "x" },
          { type: "send", to: "b", body: "vote" },
          { type: "send", to: "c", body: "vote" },
          { type: "send", to: "d", body: "vote" },
          { type: "wait" },
        ];
      return [{ type: "vote-close", pollId: "guesser" }, { type: "finish", summary: "closed" }];
    }
  }
  class Voter {
    readonly sessionId = crypto.randomUUID();
    constructor(
      readonly member: TeamMember,
      private readonly choice: string,
    ) {}
    async act(): Promise<readonly TeamCommand[]> {
      // Casting into an already-open poll needs no claim of its own.
      return [
        { type: "vote-cast", pollId: "guesser", choice: this.choice },
        { type: "send", to: "a", body: "voted" },
        { type: "finish", summary: "voted" },
      ];
    }
  }

  const agents = [
    new Coordinator(),
    new Voter(members[1], "x"),
    new Voter(members[2], "x"),
    new Voter(members[3], "y"),
  ];
  const result = await new TeamRuntime(
    "vote",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });

  assert.equal(result.settlement.kind, "completed");
  const closed = result.publicTranscript.find((message) => message.body.startsWith("POLL_CLOSED"));
  assert.ok(closed, "runtime posts a public POLL_CLOSED announcement");
  assert.match(closed!.body, /"x":3/);
  assert.match(closed!.body, /"y":1/);
  assert.match(closed!.body, /"kind":"winner"/);
  assert.match(closed!.body, /"choice":"x"/);

  const preCloseDigest = coordinatorDigests[2];
  const livePoll = preCloseDigest.polls.find((poll) => poll.pollId === "guesser");
  assert.deepEqual(livePoll?.tally, { x: 3, y: 1 });
  assert.deepEqual(livePoll?.missing, [], "all four had voted by the time the coordinator woke again");
});

test("opening a new poll without holding a claim on its pollId is rejected", async () => {
  class NoClaim {
    readonly member = { id: "a", name: "A" };
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "vote-cast", pollId: "unclaimed", choice: "x" }];
      return [{ type: "finish", summary: "done" }];
    }
  }
  class Other {
    readonly member = { id: "b", name: "B" };
    readonly sessionId = crypto.randomUUID();
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const noClaim = new NoClaim();
  const other = new Other();
  const result = await new TeamRuntime(
    "vote",
    new Map([
      [noClaim.member.id, noClaim],
      [other.member.id, other],
    ]),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.ok(result.events.some((event) => event.type === "command.failed"));
  assert.equal(
    result.publicTranscript.some((message) => message.body.startsWith("POLL_CLOSED")),
    false,
    "the poll was never actually opened",
  );
});

test("a member other than the claim holder may still cast the first vote once the pollId is claimed", async () => {
  // Reproduces a live-run bug: a member claims a pollId to reserve it (as
  // doctrine (f) asks), announces it, but a teammate other than the
  // claimant casts before the claimant does. Voting itself needs no
  // arbitration (invariant 5's floor-control quality) — the claim only
  // guards against a truly unclaimed pollId being spun up, not who casts
  // first into an already-reserved one.
  class Claimant {
    readonly member = { id: "a", name: "A" };
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "claim", resource: "guesser" }];
      if (turn.turn === 2) return [{ type: "send", to: "b", body: "go" }, { type: "wait" }];
      const failure = turn.observations.find((message) => message.body.startsWith("COMMAND_FAILED"));
      if (failure) throw new Error(`unexpected bounce: ${failure.body}`);
      return [{ type: "finish", summary: "done" }];
    }
  }
  class FirstVoter {
    readonly member = { id: "b", name: "B" };
    readonly sessionId = crypto.randomUUID();
    async act(): Promise<readonly TeamCommand[]> {
      return [
        { type: "vote-cast", pollId: "guesser", choice: "x" },
        { type: "send", to: "a", body: "voted" },
        { type: "finish", summary: "voted" },
      ];
    }
  }
  const claimant = new Claimant();
  const firstVoter = new FirstVoter();
  const result = await new TeamRuntime(
    "vote",
    new Map([
      [claimant.member.id, claimant],
      [firstVoter.member.id, firstVoter],
    ]),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(result.events.some((event) => event.type === "command.failed"), false);
  assert.ok(result.events.some((event) => event.type === "poll.cast" && event.memberId === "b"));
});

test("choice is an opaque exact-match string: two spellings of the same candidate fragment the tally rather than merging", async () => {
  // Documents intended behavior, not a bug: the runtime treats `choice` the
  // same way it treats claim resource names and poll ids — opaque and
  // exact-match, no semantic merging. A live run showed three votes for the
  // same person split 2/1 across "id" and "display name (id)" spellings.
  // This is why doctrine tells members to vote using a member id
  // consistently when electing someone — the runtime can't fix a naming
  // collision it isn't allowed to interpret.
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  class Coordinator {
    readonly member = members[0];
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "claim", resource: "p" }];
      if (turn.turn === 2)
        return [
          { type: "vote-cast", pollId: "p", choice: "x" },
          { type: "send", to: "b", body: "vote" },
          { type: "send", to: "c", body: "vote" },
          { type: "wait" },
        ];
      return [{ type: "vote-close", pollId: "p" }, { type: "finish", summary: "closed" }];
    }
  }
  class Voter {
    readonly sessionId = crypto.randomUUID();
    constructor(
      readonly member: TeamMember,
      private readonly choice: string,
    ) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [
        { type: "vote-cast", pollId: "p", choice: this.choice },
        { type: "send", to: "a", body: "voted" },
        { type: "finish", summary: "voted" },
      ];
    }
  }
  const agents = [new Coordinator(), new Voter(members[1], "x"), new Voter(members[2], "X")];
  const result = await new TeamRuntime(
    "spelling",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  const closed = result.publicTranscript.find((message) => message.body.startsWith("POLL_CLOSED"));
  assert.ok(closed);
  assert.match(closed!.body, /"x":2/, "the two lowercase votes count together");
  assert.match(closed!.body, /"X":1/, "the differently-cased vote is a distinct, unmerged option");
});

test("a tied poll is reported honestly, never auto-broken", async () => {
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  class First {
    readonly member = members[0];
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "claim", resource: "p" }];
      if (turn.turn === 2)
        return [
          { type: "vote-cast", pollId: "p", choice: "x" },
          { type: "send", to: "b", body: "your turn" },
          { type: "wait" },
        ];
      return [{ type: "vote-close", pollId: "p" }, { type: "finish", summary: "closed" }];
    }
  }
  class Second {
    readonly member = members[1];
    readonly sessionId = crypto.randomUUID();
    async act(): Promise<readonly TeamCommand[]> {
      return [
        { type: "vote-cast", pollId: "p", choice: "y" },
        { type: "send", to: "a", body: "voted" },
        { type: "finish", summary: "voted" },
      ];
    }
  }
  const agents = [new First(), new Second()];
  const result = await new TeamRuntime(
    "tie",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  const closed = result.publicTranscript.find((message) => message.body.startsWith("POLL_CLOSED"));
  assert.ok(closed);
  assert.match(closed!.body, /"kind":"tie"/);
  assert.match(closed!.body, /"choices":\["x","y"\]/);
});

test("closing an already-closed poll bounces via command.failed instead of recomputing", async () => {
  class Solo {
    readonly member = { id: "a", name: "A" };
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "claim", resource: "p" }];
      return [
        { type: "vote-cast", pollId: "p", choice: "x" },
        { type: "vote-close", pollId: "p" },
        { type: "vote-close", pollId: "p" },
        { type: "finish", summary: "done" },
      ];
    }
  }
  class Other {
    readonly member = { id: "b", name: "B" };
    readonly sessionId = crypto.randomUUID();
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const solo = new Solo();
  const other = new Other();
  const result = await new TeamRuntime(
    "vote",
    new Map([
      [solo.member.id, solo],
      [other.member.id, other],
    ]),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(
    result.events.filter((event) => event.type === "poll.closed").length,
    1,
    "only the first close is ever recorded",
  );
  assert.ok(result.events.some((event) => event.type === "command.failed"));
});

test("casting a vote after the poll has closed is rejected, not silently accepted", async () => {
  class Solo {
    readonly member = { id: "a", name: "A" };
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1)
        return [
          { type: "vote-close", pollId: "p" },
          { type: "vote-cast", pollId: "p", choice: "late" },
        ];
      return [{ type: "finish", summary: "done" }];
    }
  }
  class Other {
    readonly member = { id: "b", name: "B" };
    readonly sessionId = crypto.randomUUID();
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const solo = new Solo();
  const other = new Other();
  const result = await new TeamRuntime(
    "vote",
    new Map([
      [solo.member.id, solo],
      [other.member.id, other],
    ]),
  ).run({ channel: { kind: "public" }, body: "start" });
  const closed = result.publicTranscript.find((message) => message.body.startsWith("POLL_CLOSED"));
  assert.match(closed!.body, /"kind":"no-votes"/);
  assert.ok(result.events.some((event) => event.type === "command.failed"));
});

test("an errored member drops out of quorum instead of being waited on forever", async () => {
  class Good {
    readonly member = { id: "good", name: "Good" };
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "claim", resource: "p" }];
      if (turn.turn === 2) return [{ type: "send", to: "bad", body: "go" }, { type: "wait" }];
      return [
        { type: "vote-cast", pollId: "p", choice: "x" },
        { type: "vote-close", pollId: "p" },
        { type: "finish", summary: "done" },
      ];
    }
  }
  class Bad {
    readonly member = { id: "bad", name: "Bad" };
    readonly sessionId = crypto.randomUUID();
    async act(): Promise<readonly TeamCommand[]> {
      throw new Error("boom");
    }
  }
  const good = new Good();
  const bad = new Bad();
  const result = await new TeamRuntime(
    "vote",
    new Map([
      [good.member.id, good],
      [bad.member.id, bad],
    ]),
  ).run({ channel: { kind: "direct", memberId: "good" }, body: "start" });
  assert.deepEqual(result.settlement, { kind: "quiescent", meaning: "errored-members-remain" });
  const closedEvent = result.events.find((event) => event.type === "poll.closed");
  assert.deepEqual(closedEvent?.data.missing, [], "bad is excluded from quorum, not counted as missing");
  assert.deepEqual(closedEvent?.data.tally, { x: 1 });
});
