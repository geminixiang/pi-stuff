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

test("once every eligible member has cast, the runtime wakes everyone instead of leaving the poll to rot unclosed", async () => {
  // Reproduces a live-run deadlock: four members claimed and voted, then
  // every one of them called team_wait without anyone sending a single
  // message about it (unlike the other tests in this file, none of these
  // agents ever directly notifies a teammate). Casting a vote is otherwise
  // silent — unlike a claim or a group, it posts nothing observable — so
  // with nothing to wake anyone, the whole team went quiescent with the
  // poll never closed. The fix: once the last eligible voter casts, the
  // runtime posts a POLL_FULLY_CAST notice that wakes everyone, giving
  // someone a chance to close it.
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
    { id: "d", name: "D" },
  ];
  class Claimant {
    readonly member = members[0];
    readonly sessionId = crypto.randomUUID();
    private voted = false;
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body.startsWith("POLL_CLOSED")))
        return [{ type: "finish", summary: "done" }];
      if (turn.observations.some((message) => message.body.startsWith("POLL_FULLY_CAST")))
        return [{ type: "vote-close", pollId: "p" }, { type: "finish", summary: "closed" }];
      if (!this.voted) {
        if (turn.turn === 1) return [{ type: "claim", resource: "p" }];
        this.voted = true;
        return [{ type: "vote-cast", pollId: "p", choice: "x" }, { type: "wait" }];
      }
      return [{ type: "wait" }];
    }
  }
  class Voter {
    readonly sessionId = crypto.randomUUID();
    private voted = false;
    constructor(
      readonly member: TeamMember,
      private readonly choice: string,
    ) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body.startsWith("POLL_CLOSED")))
        return [{ type: "finish", summary: "done" }];
      // The wave's execution order isn't fixed by agent-map insertion order,
      // so a voter's first attempt can race ahead of the claimant's claim
      // and bounce; retry on the resulting COMMAND_FAILED rather than
      // assuming the first attempt landed.
      const bounced = turn.observations.some(
        (message) => message.body.startsWith("COMMAND_FAILED") && message.body.includes("vote-cast"),
      );
      if (!this.voted || bounced) {
        this.voted = true;
        return [{ type: "vote-cast", pollId: "p", choice: this.choice }, { type: "wait" }];
      }
      return [{ type: "wait" }];
    }
  }
  const agents = [
    new Claimant(),
    new Voter(members[1], "x"),
    new Voter(members[2], "x"),
    new Voter(members[3], "y"),
  ];
  const result = await new TeamRuntime(
    "silent-quorum",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "start" });

  assert.equal(
    result.settlement.kind,
    "completed",
    "without the fix this deadlocks quiescent with the poll never closed",
  );
  const fullyCast = result.publicTranscript.find((message) =>
    message.body.startsWith("POLL_FULLY_CAST"),
  );
  assert.ok(fullyCast, "runtime announces once every eligible member has cast");
  const closed = result.publicTranscript.find((message) => message.body.startsWith("POLL_CLOSED"));
  assert.ok(closed, "the notice gave someone the chance to close the poll");
  assert.match(closed!.body, /"x":3/);
  assert.match(closed!.body, /"y":1/);
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
      // The second close is rejected, which halts the batch (invariant 26)
      // and discards the finish queued behind it; the bounce wakes this
      // member to finish cleanly on the next turn.
      if (turn.turn === 2)
        return [
          { type: "vote-cast", pollId: "p", choice: "x" },
          { type: "vote-close", pollId: "p" },
          { type: "vote-close", pollId: "p" },
          { type: "finish", summary: "done" },
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
      if (turn.turn === 1) return [{ type: "claim", resource: "p" }];
      // The late cast is rejected, which halts the batch and discards the
      // finish behind it; the bounce wakes this member to finish next turn.
      if (turn.turn === 2)
        return [
          { type: "vote-cast", pollId: "p", choice: "x" },
          { type: "vote-close", pollId: "p" },
          { type: "vote-cast", pollId: "p", choice: "late" },
          { type: "finish", summary: "done" },
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
  assert.equal(result.settlement.kind, "completed");
  const closed = result.publicTranscript.find((message) => message.body.startsWith("POLL_CLOSED"));
  assert.ok(closed);
  assert.match(closed!.body, /"x":1/);
  assert.doesNotMatch(closed!.body, /late/, "the post-close vote never entered the tally");
  assert.ok(
    result.events.some(
      (event) => event.type === "command.failed" && event.data.commandType === "vote-cast",
    ),
  );
});

test("closing a poll no one ever voted in is rejected, and the id is not poisoned for later real use", async () => {
  // Regression: closePoll used to fabricate an empty tally (`?? new Map()`)
  // for a pollId that never existed, letting any member permanently close a
  // guessable id as no-votes without ever holding the claim castVote
  // requires for new ids — bypassing that namespace reservation entirely.
  class Squatter {
    readonly member = { id: "a", name: "A" };
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body.startsWith("POLL_CLOSED")))
        return [{ type: "finish", summary: "done" }];
      if (turn.turn === 1) return [{ type: "vote-close", pollId: "p" }];
      if (turn.observations.some((message) => message.body.startsWith("COMMAND_FAILED")))
        return [{ type: "send", to: "b", body: "go" }, { type: "wait" }];
      return [{ type: "wait" }];
    }
  }
  class LegitimateOwner {
    readonly member = { id: "b", name: "B" };
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body === "go"))
        return [{ type: "claim", resource: "p" }];
      if (turn.observations.some((message) => message.body.startsWith("CLAIM_ACQUIRED")))
        return [
          { type: "vote-cast", pollId: "p", choice: "x" },
          { type: "vote-close", pollId: "p" },
          { type: "finish", summary: "closed" },
        ];
      return [{ type: "wait" }];
    }
  }
  const squatter = new Squatter();
  const owner = new LegitimateOwner();
  const result = await new TeamRuntime(
    "squat",
    new Map([
      [squatter.member.id, squatter],
      [owner.member.id, owner],
    ]),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.ok(
    result.events.some(
      (event) =>
        event.type === "command.failed" &&
        event.memberId === "a" &&
        event.data.commandType === "vote-close",
    ),
    "closing a nonexistent poll bounces instead of fabricating a no-votes result",
  );
  const closed = result.publicTranscript.find((message) => message.body.startsWith("POLL_CLOSED"));
  assert.ok(closed, "the id still works for a later legitimate claim-cast-close");
  assert.match(closed!.body, /"x":1/);
  assert.match(closed!.body, /"kind":"winner"/);
});

test("a poll becomes fully cast when the last outstanding voter finishes instead of casting, not only when they cast", async () => {
  // Reproduces a liveness gap: POLL_FULLY_CAST used to be checked only
  // inside castVote(). eligible/missing are computed from runnable(), which
  // also changes on finish/error — so a poll can become fully cast purely
  // because the one remaining non-voter finished without ever casting. Without
  // rechecking on that transition too, a and b (who both already voted and
  // are waiting for the notice) would never be woken, and the team goes
  // quiescent with the poll open forever.
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
          { type: "send", to: "b", body: "vote now" },
          { type: "wait" },
        ];
      const fullyCast = turn.observations.some((message) =>
        message.body.startsWith("POLL_FULLY_CAST"),
      );
      if (fullyCast) return [{ type: "vote-close", pollId: "p" }, { type: "finish", summary: "closed" }];
      return [{ type: "wait" }];
    }
  }
  class Voter {
    readonly member = members[1];
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body.startsWith("POLL_CLOSED")))
        return [{ type: "finish", summary: "done" }];
      if (turn.observations.some((message) => message.body === "vote now"))
        return [
          { type: "vote-cast", pollId: "p", choice: "x" },
          { type: "send", to: "c", body: "your turn — skip voting" },
          { type: "wait" },
        ];
      return [{ type: "wait" }];
    }
  }
  class NeverVotes {
    readonly member = members[2];
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body === "your turn — skip voting"))
        return [{ type: "finish", summary: "never voted" }];
      return [{ type: "wait" }];
    }
  }
  const agents = [new Coordinator(), new Voter(), new NeverVotes()];
  const result = await new TeamRuntime(
    "finish-triggers-fully-cast",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });

  assert.equal(
    result.settlement.kind,
    "completed",
    "without rechecking on finish, this deadlocks quiescent with the poll never closed",
  );
  const fullyCast = result.publicTranscript.find((message) =>
    message.body.startsWith("POLL_FULLY_CAST"),
  );
  assert.ok(fullyCast, "the last non-voter finishing should still trigger the fully-cast notice");
  assert.match(fullyCast!.body, /voters=\["a","b"\]/, "c never voted and drops out of eligible");
  const closed = result.publicTranscript.find((message) => message.body.startsWith("POLL_CLOSED"));
  assert.ok(closed);
  assert.match(closed!.body, /"x":2/);
});

test("a poll with zero votes is never announced fully cast just because every member finished without voting", async () => {
  // Guards the other edge of the same fix: if nobody ever casts, eligible
  // shrinks to nothing as members finish, and missing (a filter over
  // eligible) trivially becomes empty too — vacuously "fully cast" with zero
  // data. That's not a real quorum event and must not be announced.
  class NeverVotes {
    readonly member = { id: "a", name: "A" };
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "claim", resource: "p" }];
      return [{ type: "finish", summary: "done" }];
    }
  }
  class AlsoNeverVotes {
    readonly member = { id: "b", name: "B" };
    readonly sessionId = crypto.randomUUID();
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const agents = [new NeverVotes(), new AlsoNeverVotes()];
  const result = await new TeamRuntime(
    "zero-votes",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(
    result.publicTranscript.some((message) => message.body.startsWith("POLL_FULLY_CAST")),
    false,
    "an unvoted poll must never be announced fully cast just because everyone finished",
  );
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
