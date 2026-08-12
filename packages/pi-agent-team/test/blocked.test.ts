import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand, TeamMember, TeamTurn } from "../src/domain.js";
import { TeamRuntime, verifyAudit } from "../src/runtime.js";

/**
 * A promise the test awaits to know the execute loop has reached its
 * quiescent intervention wait (waitForIntervention). The runtime emits an
 * activity naming the wait the moment it parks; a 2s unref'd fail-safe
 * rejects instead of hanging the suite if the team settles instead.
 */
function parkSignal(): { promise: Promise<void>; fire: () => void } {
  let fire: () => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    fire = resolve;
    const timer = setTimeout(
      () => reject(new Error("team never reached the quiescent intervention wait")),
      2_000,
    );
    timer.unref();
  });
  return { promise, fire };
}

function isParkNotice(activity: { text: string }): boolean {
  return activity.text.includes("waiting for external intervention");
}

class BlockingAgent {
  readonly sessionId = crypto.randomUUID();
  constructor(readonly member: TeamMember) {}
  async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
    if (turn.turn === 1) return [{ type: "block", reason: "awaiting budget approval" }];
    return [{ type: "finish", summary: "resumed" }];
  }
}

class Finisher {
  readonly sessionId = crypto.randomUUID();
  constructor(readonly member: TeamMember) {}
  async act(): Promise<readonly TeamCommand[]> {
    return [{ type: "finish", summary: "done" }];
  }
}

test("team_block saves the reason, pauses the member, and settles quiescent blocked-members-remain", async () => {
  const progressSnapshots: string[] = [];
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const agents = [new BlockingAgent(members[0]), new Finisher(members[1])];
  const result = await new TeamRuntime(
    "budget",
    new Map(agents.map((agent) => [agent.member.id, agent])),
    {
      onProgress: (progress) =>
        progressSnapshots.push(
          `${progress.states.a}:${progress.states.b}:blocked=${progress.blocked.join(",")}`,
        ),
    },
  ).run({ channel: { kind: "public" }, body: "start" });

  assert.deepEqual(result.settlement, { kind: "quiescent", meaning: "blocked-members-remain" });
  const memberA = result.members.find((member) => member.id === "a");
  assert.equal(memberA?.state, "blocked");
  assert.equal(memberA?.blockedReason, "awaiting budget approval");
  assert.equal(memberA?.turns, 1, "a blocked member is never woken again before settle");
  assert.ok(
    progressSnapshots.some((snapshot) => snapshot === "blocked:finished:blocked=a"),
    "progress clearly exposes the blocked member alongside its state",
  );
  assert.ok(
    result.publicTranscript.some((message) => message.body.startsWith("MEMBER_BLOCKED member=a")),
    "the team is publicly notified the member paused",
  );
  const blocked = result.events.find((event) => event.type === "member.blocked");
  assert.equal(blocked?.memberId, "a");
  assert.equal(typeof blocked?.data.reasonHash, "string");
  assert.equal(
    JSON.stringify(result.events).includes("awaiting budget approval"),
    false,
    "audit carries only the reason hash, never the reason plaintext (invariant 11)",
  );
  assert.equal(verifyAudit(result.events), true);
});

test("block ends the turn in the batch like wait/finish: say before it applies, commands after it are discarded", async () => {
  const bSaw: string[] = [];
  class A {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "a", name: "A" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1)
        return [
          { type: "say", body: "need help" },
          { type: "block", reason: "stuck on step 2" },
          { type: "send", to: "b", body: "should never arrive" },
        ];
      return [{ type: "finish", summary: "resumed" }];
    }
  }
  class B {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "b", name: "B" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      bSaw.push(...turn.observations.map((message) => message.body));
      return [{ type: "finish", summary: "done" }];
    }
  }
  const a = new A();
  const b = new B();
  const result = await new TeamRuntime(
    "truncate-block",
    new Map([
      [a.member.id, a],
      [b.member.id, b],
    ]),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });

  assert.ok(
    result.publicTranscript.some((message) => message.body === "need help"),
    "the say queued before block still applies",
  );
  assert.equal(
    result.publicTranscript.some((message) => message.body === "should never arrive"),
    false,
    "the send queued after block is discarded by the core",
  );
  assert.equal(bSaw.includes("should never arrive"), false);
  assert.equal(result.members.find((member) => member.id === "a")?.state, "blocked");
  assert.equal(result.members.find((member) => member.id === "a")?.blockedReason, "stuck on step 2");
});

test("mail to a blocked member is enqueued passively, never wakes it, and is delivered on intervention", async () => {
  const aObservationBodies: string[][] = [];
  const park = parkSignal();
  class A {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "a", name: "A" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      aObservationBodies.push(turn.observations.map((message) => message.body));
      if (turn.turn === 1) return [{ type: "block", reason: "need human input" }];
      return [{ type: "finish", summary: "done after intervention" }];
    }
  }
  class B {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "b", name: "B" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  class C {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "c", name: "C" };
    async act(): Promise<readonly TeamCommand[]> {
      return [
        { type: "send", to: "a", body: "your draft was rejected — see notes" },
        { type: "finish", summary: "notified" },
      ];
    }
  }
  const a = new A();
  const b = new B();
  const c = new C();
  const runtime = new TeamRuntime(
    "resume",
    new Map([
      [a.member.id, a],
      [b.member.id, b],
      [c.member.id, c],
    ]),
    {
      waitForIntervention: true,
      onActivity: (activity) => {
        if (isParkNotice(activity)) park.fire();
      },
    },
  );
  const runPromise = runtime.run({ channel: { kind: "direct", memberId: "a" }, body: "start" });

  await park.promise;
  assert.equal(runtime.progress().states.a, "blocked");
  assert.equal(runtime.progress().active.length, 0, "nothing is scheduled while parked — quiescent, not busy-looping");
  assert.equal(
    aObservationBodies.flat().includes("your draft was rejected — see notes"),
    false,
    "the DM while blocked must not wake a",
  );

  runtime.intervene("a", "approved — proceed");
  const result = await runPromise;

  assert.equal(result.settlement.kind, "completed");
  assert.equal(result.members.find((member) => member.id === "a")?.turns, 2);
  const resumed = aObservationBodies.at(-1)!;
  assert.ok(
    resumed.includes("your draft was rejected — see notes"),
    "mail queued while blocked is delivered on the intervention wake",
  );
  assert.ok(resumed.includes("approved — proceed"), "the intervention guidance wakes the member");
  const intervened = result.events.find((event) => event.type === "member.intervened");
  assert.equal(intervened?.memberId, "a");
  assert.equal(intervened?.data.unblocked, true);
  assert.equal(result.userInterventions, 1);
  assert.ok(
    result.restrictedMessages.some((message) => message.from === "user"),
    "requester intervention is attributed honestly rather than disguised as runtime speech",
  );
  assert.equal(verifyAudit(result.events), true);
});

test("opening-wave speech held for blocked members survives until requester intervention", async () => {
  const park = parkSignal();
  const secondTurnBodies = new Map<string, string[]>();
  class Member {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1)
        return [
          { type: "say", body: `first-take:${this.member.id}` },
          { type: "block", reason: "need requester review" },
        ];
      secondTurnBodies.set(
        this.member.id,
        turn.observations.map((message) => message.body),
      );
      return [{ type: "finish", summary: "reviewed" }];
    }
  }
  const agents = ["a", "b", "c"].map(
    (id) => new Member({ id, name: id.toUpperCase() }),
  );
  const runtime = new TeamRuntime(
    "opening block",
    new Map(agents.map((agent) => [agent.member.id, agent])),
    {
      waitForIntervention: true,
      onActivity: (activity) => {
        if (isParkNotice(activity)) park.fire();
      },
    },
  );
  const runPromise = runtime.run({ channel: { kind: "public" }, body: "start" });

  await park.promise;
  for (const agent of agents) runtime.intervene(agent.member.id, "review complete");
  const result = await runPromise;

  const observedPeerTakes = [...secondTurnBodies.values()].reduce(
    (count, bodies) => count + bodies.filter((body) => body.startsWith("first-take:")).length,
    0,
  );
  assert.equal(
    observedPeerTakes,
    6,
    "every member receives both peer takes after intervention; held reveals are never dropped for blocked recipients",
  );
  assert.equal(result.userInterventions, 3);
  assert.equal(result.settlement.kind, "completed");
});

test("intervene() refuses pre-run, post-settle, unknown, terminal, and empty calls explicitly", async () => {
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const agents = [new BlockingAgent(members[0]), new Finisher(members[1])];
  const runtime = new TeamRuntime("obj", new Map(agents.map((agent) => [agent.member.id, agent])));
  assert.throws(() => runtime.intervene("a", "hi"), /may only be called while run/);
  const result = await runtime.run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.meaning, "blocked-members-remain");
  assert.throws(() => runtime.intervene("a", "hi"), /already settled/);
});

test("mid-run intervene() rejects unknown members, terminal members, and empty messages", async () => {
  const park = parkSignal();
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const agents = [new BlockingAgent(members[0]), new Finisher(members[1])];
  const runtime = new TeamRuntime("obj", new Map(agents.map((agent) => [agent.member.id, agent])), {
    waitForIntervention: true,
    onActivity: (activity) => {
      if (isParkNotice(activity)) park.fire();
    },
  });
  const runPromise = runtime.run({ channel: { kind: "public" }, body: "start" });

  await park.promise;
  assert.throws(() => runtime.intervene("nobody", "hi"), /Unknown member/);
  assert.throws(() => runtime.intervene("b", "hi"), /terminal/, "a finished member cannot be intervened");
  assert.throws(() => runtime.intervene("a", "   "), /must not be empty/);

  runtime.intervene("a", "go");
  const result = await runPromise;
  assert.equal(result.settlement.kind, "completed");
});

test("aborting while parked rejects the run instead of hanging forever", async () => {
  const park = parkSignal();
  const controller = new AbortController();
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const agents = [new BlockingAgent(members[0]), new Finisher(members[1])];
  const runtime = new TeamRuntime("obj", new Map(agents.map((agent) => [agent.member.id, agent])), {
    waitForIntervention: true,
    onActivity: (activity) => {
      if (isParkNotice(activity)) park.fire();
    },
  });
  const runPromise = runtime.run({ channel: { kind: "public" }, body: "start" }, controller.signal);

  await park.promise;
  controller.abort(new Error("operator gave up"));
  await assert.rejects(() => runPromise, /operator gave up/);
  assert.throws(
    () => runtime.intervene("a", "too late"),
    /already settled/,
    "an aborted round closes its intervention channel while retaining agent sessions",
  );
});

test("a blocked member stays in the poll electorate: polls keep waiting for its vote", async () => {
  class A {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "a", name: "A" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "block", reason: "paused" }];
    }
  }
  class B {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "b", name: "B" };
    acts = 0;
    async act(): Promise<readonly TeamCommand[]> {
      this.acts += 1;
      if (this.acts === 1) return [{ type: "claim", resource: "poll-1" }];
      return [
        { type: "vote-cast", pollId: "poll-1", choice: "x" },
        { type: "vote-close", pollId: "poll-1" },
        { type: "finish", summary: "closed" },
      ];
    }
  }
  class C {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "c", name: "C" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const a = new A();
  const b = new B();
  const c = new C();
  const result = await new TeamRuntime(
    "poll",
    new Map([
      [a.member.id, a],
      [b.member.id, b],
      [c.member.id, c],
    ]),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });

  const closed = result.events.find((event) => event.type === "poll.closed");
  assert.ok(closed, "the poll is closed");
  assert.deepEqual(
    closed!.data.missing,
    ["a"],
    "the blocked member is still an expected voter, not silently dropped from quorum",
  );
  assert.equal(
    result.publicTranscript.some((message) => message.body.startsWith("POLL_FULLY_CAST")),
    false,
    "the poll is never declared fully cast while the blocked member's vote is outstanding",
  );
  assert.equal(result.settlement.meaning, "blocked-members-remain");
});

test("a blocked member keeps its claims; they release only when it finishes", async () => {
  const bRejections: string[] = [];
  const park = parkSignal();
  class A {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "a", name: "A" };
    acts = 0;
    async act(): Promise<readonly TeamCommand[]> {
      this.acts += 1;
      if (this.acts === 1) return [{ type: "claim", resource: "coordinator" }];
      if (this.acts === 2) return [{ type: "block", reason: "waiting for requester" }];
      return [{ type: "finish", summary: "done" }];
    }
  }
  class B {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "b", name: "B" };
    acts = 0;
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      this.acts += 1;
      if (this.acts === 1) return [{ type: "claim", resource: "coordinator" }];
      bRejections.push(
        ...turn.observations
          .filter((message) => message.body.startsWith("CLAIM_REJECTED"))
          .map((message) => message.body),
      );
      return [{ type: "finish", summary: "done" }];
    }
  }
  const a = new A();
  const b = new B();
  const runtime = new TeamRuntime(
    "claims",
    new Map([
      [a.member.id, a],
      [b.member.id, b],
    ]),
    {
      waitForIntervention: true,
      onActivity: (activity) => {
        if (isParkNotice(activity)) park.fire();
      },
    },
  );
  const runPromise = runtime.run({ channel: { kind: "direct", memberId: "a" }, body: "start" });

  await park.promise;
  assert.ok(
    bRejections.length >= 1,
    "blocking is a pause, not a departure: the blocked member still holds its claim",
  );
  runtime.intervene("a", "resume");
  const result = await runPromise;
  assert.equal(result.settlement.kind, "completed");
  assert.equal(result.members.find((member) => member.id === "a")?.turns, 3);
});
