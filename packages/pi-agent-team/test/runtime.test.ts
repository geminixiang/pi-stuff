import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand, TeamMember, TeamTurn } from "../src/domain.js";
import { TeamRuntime, verifyAudit } from "../src/runtime.js";

class ClaimAgent {
  readonly sessionId = crypto.randomUUID();
  constructor(readonly member: TeamMember) {}
  async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
    if (turn.observations.some((message) => message.from === "runtime"))
      return [{ type: "finish", summary: "done" }];
    return [{ type: "claim", resource: "shared-task" }];
  }
}

test("claim is a synchronization fence that discards speculative same-turn actions", async () => {
  class SpeculativeAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1)
        return [
          { type: "claim", resource: "coordinator" },
          { type: "say", body: "I won before CAS result" },
          { type: "finish", summary: "speculative finish" },
        ];
      return [{ type: "finish", summary: "observed CAS result" }];
    }
  }
  const members = [
    { id: "amber", name: "Amber" },
    { id: "quartz", name: "Quartz" },
  ];
  const agents = members.map((member) => new SpeculativeAgent(member));
  const result = await new TeamRuntime(
    "elect",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "elect" });
  assert.equal(result.settlement.kind, "completed");
  assert.ok(!result.publicTranscript.some((message) => message.body === "I won before CAS result"));
  assert.ok(result.members.every((member) => member.summary === "observed CAS result"));
});

test("claim contenders receive private CAS outcomes and public broadcast does not wake peers", async () => {
  const seen = new Map<string, TeamTurn[]>();
  class CoordinatingAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      const turns = seen.get(this.member.id) ?? [];
      turns.push(structuredClone(turn));
      seen.set(this.member.id, turns);
      if (turn.turn === 1)
        return [
          { type: "claim", resource: "leader" },
          { type: "say", body: `candidate ${this.member.id}` },
        ];
      const outcome = turn.observations.find((message) => message.from === "runtime")?.body;
      assert.match(outcome ?? "", /^CLAIM_(ACQUIRED|REJECTED)/);
      return [{ type: "finish", summary: outcome! }];
    }
  }
  const members = [
    { id: "amber", name: "Amber" },
    { id: "quartz", name: "Quartz" },
  ];
  const agents = members.map((member) => new CoordinatingAgent(member));
  const result = await new TeamRuntime(
    "elect",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "elect" });
  assert.equal(result.settlement.kind, "completed");
  assert.deepEqual(
    result.members.map((member) => member.turns),
    [2, 2],
  );
  for (const turns of seen.values()) {
    assert.equal(turns.length, 2);
    assert.equal(turns[1].observations.filter((message) => message.from === "runtime").length, 1);
  }
});

test("exactly maxTurns may complete without a false overflow", async () => {
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  class FinishAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const agents = members.map((member) => new FinishAgent(member));
  const result = await new TeamRuntime(
    "finish",
    new Map(agents.map((agent) => [agent.member.id, agent])),
    { maxTurns: 2 },
  ).run({ channel: { kind: "public" }, body: "finish" });
  assert.equal(result.settlement.kind, "completed");
  assert.deepEqual(
    result.members.map((member) => member.turns),
    [1, 1],
  );
});

test("activity callback exposes each member reaction in order", async () => {
  const activities: string[] = [];
  const agents = [new ClaimAgent({ id: "a", name: "A" }), new ClaimAgent({ id: "b", name: "B" })];
  await new TeamRuntime("claim once", new Map(agents.map((agent) => [agent.member.id, agent])), {
    onActivity: (activity) =>
      activities.push(`${activity.memberId}:${activity.kind}:${activity.text}`),
  }).run({ channel: { kind: "public" }, body: "claim" });
  assert.ok(activities.some((activity) => activity.startsWith("a:wake:")));
  assert.ok(activities.some((activity) => activity === "a:finish:done"));
  assert.ok(activities.some((activity) => activity.startsWith("b:claim:")));
});

test("message activities carry chat speaker, recipient, and body metadata", async () => {
  class ChatAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (this.member.id === "a")
        return [
          { type: "send", to: "b", body: "hello privately" },
          { type: "finish", summary: "sent" },
        ];
      assert.equal(turn.observations[0]?.body, "hello privately");
      return [
        { type: "say", body: "hello everyone" },
        { type: "finish", summary: "replied" },
      ];
    }
  }
  const members = [
    { id: "a", name: "Amber" },
    { id: "b", name: "Blue" },
  ];
  const agents = members.map((member) => new ChatAgent(member));
  const chat: {
    memberId: string;
    channel: { kind: string };
    targetIds: readonly string[];
    body?: string;
    visibility: "public" | "restricted";
  }[] = [];
  await new TeamRuntime("chat", new Map(agents.map((agent) => [agent.member.id, agent])), {
    onActivity(activity) {
      if (activity.kind === "message") chat.push(activity);
    },
  }).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  assert.ok(
    chat.some(
      (item) =>
        item.memberId === "a" &&
        item.channel.kind === "direct" &&
        item.targetIds.includes("b") &&
        item.body === "hello privately" &&
        item.visibility === "restricted",
    ),
  );
  assert.ok(
    chat.some(
      (item) =>
        item.memberId === "b" &&
        item.channel.kind === "public" &&
        item.body === "hello everyone" &&
        item.visibility === "public",
    ),
  );
});

test("restricted group messages reach only members and wake each recipient once", async () => {
  const seen = new Map<string, TeamTurn[]>();
  class GroupAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      seen.set(this.member.id, [...(seen.get(this.member.id) ?? []), structuredClone(turn)]);
      // The claim-then-create path still works: a claim the creator already
      // holds is honored rather than re-arbitrated.
      if (this.member.id === "a" && turn.turn === 1) return [{ type: "claim", resource: "wolves" }];
      if (this.member.id === "a" && turn.turn === 2)
        return [
          { type: "create-group", channelId: "wolves", name: "Wolves", members: ["b"] },
          { type: "group-send", channelId: "wolves", body: "secret plan" },
          { type: "finish", summary: "sent" },
        ];
      if (this.member.id === "b" && turn.turn > 1) {
        assert.equal(
          turn.observations.some((message) => message.body === "secret plan"),
          true,
        );
        return [{ type: "finish", summary: "received" }];
      }
      if (this.member.id === "b") return [{ type: "wait" }];
      return [{ type: "finish", summary: "outsider" }];
    }
  }
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const agents = members.map((member) => new GroupAgent(member));
  const result = await new TeamRuntime(
    "group",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  // 2 restricted envelopes: the CLAIM_ACQUIRED notice for claiming "wolves",
  // plus the one group-send carrying "secret plan".
  assert.equal(result.restrictedMessages.length, 2);
  assert.equal(JSON.stringify(result).includes("secret plan"), false);
  assert.equal(
    seen
      .get("c")
      ?.some((turn) => turn.observations.some((message) => message.body === "secret plan")),
    false,
  );
});

test("creating a group atomically claims an unclaimed channelId in one turn", async () => {
  // No separate claim turn: create-group on an unclaimed id claims it and
  // creates the room in the same turn. The old two-turn protocol left a
  // window in which members needing the room were awake with no private
  // channel yet.
  const seen = new Map<string, TeamTurn[]>();
  class AtomicGroupAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      seen.set(this.member.id, [...(seen.get(this.member.id) ?? []), structuredClone(turn)]);
      if (this.member.id === "a" && turn.turn === 1)
        return [
          { type: "create-group", channelId: "wolves", name: "Wolves", members: ["b"] },
          { type: "group-send", channelId: "wolves", body: "secret plan" },
          { type: "finish", summary: "sent" },
        ];
      if (this.member.id === "b" && turn.observations.some((m) => m.body === "secret plan"))
        return [{ type: "finish", summary: "received" }];
      if (this.member.id === "b") return [{ type: "wait" }];
      return [{ type: "finish", summary: "outsider" }];
    }
  }
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const agents = members.map((member) => new AtomicGroupAgent(member));
  const result = await new TeamRuntime(
    "atomic-group",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  // The implicit claim is recorded like an explicit one, so it shows in
  // held-claims digests and releases on finish.
  const claimed = result.events.filter((event) => event.type === "member.claimed");
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].memberId, "a");
  assert.deepEqual(claimed[0].data, { resource: "wolves" });
  // Only the group-send is restricted; the implicit claim posts no
  // CLAIM_ACQUIRED round-trip — that round-trip was the exposure window.
  assert.equal(result.restrictedMessages.length, 1);
  assert.equal(JSON.stringify(result).includes("secret plan"), false);
  assert.equal(
    seen.get("c")?.some((turn) => turn.observations.some((m) => m.body === "secret plan")),
    false,
  );
});

test("creating a group whose id another member claims is rejected like a lost claim race", async () => {
  const seen = new Map<string, TeamTurn[]>();
  class RaceAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      seen.set(this.member.id, [...(seen.get(this.member.id) ?? []), structuredClone(turn)]);
      if (this.member.id === "a" && turn.turn === 1) return [{ type: "claim", resource: "wolves" }];
      // a keeps holding the claim (finishing would release it and let b's
      // create win the id legitimately).
      if (this.member.id === "a")
        return [{ type: "say", body: "claimed it", to: ["b"] }, { type: "wait" }];
      if (this.member.id === "b" && turn.observations.some((m) => m.body === "claimed it"))
        return [{ type: "create-group", channelId: "wolves", name: "Wolves", members: ["a"] }];
      return [{ type: "finish", summary: "done" }];
    }
  }
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const agents = members.map((member) => new RaceAgent(member));
  const result = await new TeamRuntime(
    "group-race",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  // b's create bounces with a COMMAND_FAILED naming the holder; no group
  // ever exists.
  const bounce = seen
    .get("b")!
    .flatMap((turn) => turn.observations)
    .find((m) => m.body?.startsWith("COMMAND_FAILED type=create-group"));
  assert.ok(bounce, "b is woken with a COMMAND_FAILED for the rejected create");
  assert.match(bounce!.body ?? "", /claimed by a/);
  assert.equal(
    result.events.some((event) => event.type === "channel.created"),
    false,
  );
});

test("finish summary is control state and never public speech", async () => {
  class FinishOnlyAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: `answer from ${this.member.id}` }];
    }
  }
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const agents = members.map((member) => new FinishOnlyAgent(member));
  const result = await new TeamRuntime(
    "speak",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.deepEqual(
    result.publicTranscript.map((message) => message.body),
    ["start"],
  );
});

test("a wait command truncates the rest of the batch at the core level, for any TeamAgent", async () => {
  // TeamAgent is a public interface; invariant 16 (turn-ending protocol)
  // must hold for any implementation, not only PiTeamAgent's TurnState-
  // gated one. A raw agent that returns [wait, send] should have the send
  // dropped by the core itself, not just by the Pi adapter.
  let otherSawForbiddenMessage = false;
  class Rogue {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "rogue", name: "Rogue" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "wait" }, { type: "send", to: "other", body: "should never arrive" }];
    }
  }
  class Other {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "other", name: "Other" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body === "should never arrive"))
        otherSawForbiddenMessage = true;
      return [{ type: "finish", summary: "done" }];
    }
  }
  const rogue = new Rogue();
  const other = new Other();
  const result = await new TeamRuntime(
    "truncate-wait",
    new Map([
      [rogue.member.id, rogue],
      [other.member.id, other],
    ]),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(
    otherSawForbiddenMessage,
    false,
    "the send after wait should have been discarded by the core",
  );
  assert.deepEqual(
    result.settlement,
    { kind: "quiescent", meaning: "no-runnable-members" },
    "rogue waits forever after its truncated turn — nothing ever wakes it again",
  );
});

test("a finish command truncates the rest of the batch at the core level, for any TeamAgent", async () => {
  class Rogue {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "rogue", name: "Rogue" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }, { type: "say", body: "should never post" }];
    }
  }
  class Other {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "other", name: "Other" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const rogue = new Rogue();
  const other = new Other();
  const result = await new TeamRuntime(
    "truncate-finish",
    new Map([
      [rogue.member.id, rogue],
      [other.member.id, other],
    ]),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(
    result.publicTranscript.some((message) => message.body === "should never post"),
    false,
    "the say after finish should have been discarded by the core",
  );
});

test("run() may only be called once per TeamRuntime instance", async () => {
  class Finisher {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const agents = members.map((member) => new Finisher(member));
  const runtime = new TeamRuntime("once", new Map(agents.map((agent) => [agent.member.id, agent])));
  const first = await runtime.run({ channel: { kind: "public" }, body: "start" });
  assert.equal(first.settlement.kind, "completed");
  await assert.rejects(
    () => runtime.run({ channel: { kind: "public" }, body: "start again" }),
    /may only be called once/,
  );
});

test("claims are atomic and audit chain detects tampering", async () => {
  const agents = [new ClaimAgent({ id: "a", name: "A" }), new ClaimAgent({ id: "b", name: "B" })];
  const result = await new TeamRuntime(
    "claim once",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "claim" });
  assert.equal(result.events.filter((event) => event.type === "member.claimed").length, 1);
  assert.equal(result.events.filter((event) => event.type === "member.claimRejected").length, 1);
  assert.equal(verifyAudit(result.events), true);
  const tampered = result.events.map((event) => ({ ...event, data: { ...event.data } }));
  tampered[1].data = { changed: true };
  assert.equal(verifyAudit(tampered), false);
});

test("a public say mentioning a teammate wakes exactly them; the rest receive it passively", async () => {
  // a is started alone, speaks publicly mentioning b (and itself — a
  // self-mention is a harmless no-op, dropped rather than bouncing the
  // whole message). b must wake immediately from the mention, observing
  // the public envelope itself; c is never interrupted and only sees the
  // speech on the pre-quiescence flush, strictly after b's turn.
  const actOrder: string[] = [];
  const seen = new Map<string, TeamTurn[]>();
  class MentionAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      actOrder.push(this.member.id);
      seen.set(this.member.id, [...(seen.get(this.member.id) ?? []), structuredClone(turn)]);
      if (this.member.id === "a")
        return [
          { type: "say", body: "opening", to: ["a", "b"] },
          { type: "finish", summary: "spoke" },
        ];
      return [{ type: "finish", summary: "done" }];
    }
  }
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const agents = members.map((member) => new MentionAgent(member));
  const result = await new TeamRuntime(
    "chat",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.deepEqual(actOrder, ["a", "b", "c"], "the mention wakes b before c's flush");
  const bTurn = seen.get("b")![0];
  const observedSay = bTurn.observations.find((message) => message.body === "opening");
  assert.ok(observedSay, "b observes the public speech itself, not a restatement");
  assert.equal(observedSay.channel.kind, "public");
  assert.deepEqual(observedSay.mentions, ["b"], "the self-mention is dropped, b's kept");
  assert.ok(
    !seen
      .get("a")!
      .flatMap((turn) => turn.observations)
      .some((message) => message.from === "runtime"),
    "a self-mention never bounces the say",
  );
  const cTurn = seen.get("c")![0];
  assert.ok(
    cTurn.observations.some((message) => message.body === "opening"),
    "c still receives the public speech passively before quiescence",
  );
});

test("a public say mentioning a terminal teammate bounces instead of silently never waking them", async () => {
  const seen = new Map<string, TeamTurn[]>();
  class BounceAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      seen.set(this.member.id, [...(seen.get(this.member.id) ?? []), structuredClone(turn)]);
      if (this.member.id === "b") return [{ type: "finish", summary: "gone" }];
      if (this.member.id === "a" && turn.turn === 1)
        return [
          { type: "say", body: "opening", to: ["b"] },
          { type: "finish", summary: "spoke" },
        ];
      if (turn.turn === 1) return [{ type: "say", body: "late ping", to: ["b"] }, { type: "wait" }];
      return [{ type: "finish", summary: "saw the bounce" }];
    }
  }
  const members = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const agents = members.map((member) => new BounceAgent(member));
  const result = await new TeamRuntime(
    "chat",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  const bounce = seen
    .get("c")!
    .flatMap((turn) => turn.observations)
    .find((message) => message.from === "runtime");
  assert.match(bounce?.body ?? "", /COMMAND_FAILED type=say/);
  assert.match(bounce?.body ?? "", /finished/);
  assert.ok(
    !result.publicTranscript.some((message) => message.body === "late ping"),
    "a bounced say is rejected before it is posted, not published without its wake",
  );
});

test("a rejected command halts the batch so a same-batch finish cannot seal the member terminal", async () => {
  // Regression for the terminal trap invariant 26 closes: under the old
  // ordered best-effort batches, a send to a bad recipient bounced but the
  // finish queued behind it still applied, leaving the member finished
  // before it could ever observe the bounce — and no wake can reach a
  // terminal member to let it correct course.
  const secondTurnObservations: string[] = [];
  class Hasty {
    readonly member = { id: "a", name: "A" };
    readonly sessionId = crypto.randomUUID();
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1)
        return [
          { type: "send", to: "nobody-by-this-name", body: "hello?" },
          { type: "finish", summary: "premature" },
        ];
      secondTurnObservations.push(...turn.observations.map((message) => message.body));
      return [{ type: "finish", summary: "recovered" }];
    }
  }
  class Bystander {
    readonly member = { id: "b", name: "B" };
    readonly sessionId = crypto.randomUUID();
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const hasty = new Hasty();
  const bystander = new Bystander();
  const result = await new TeamRuntime(
    "halt",
    new Map([
      [hasty.member.id, hasty],
      [bystander.member.id, bystander],
    ]),
  ).run({ channel: { kind: "public" }, body: "start" });

  assert.equal(result.settlement.kind, "completed");
  assert.ok(
    result.events.some(
      (event) =>
        event.type === "command.failed" &&
        event.memberId === "a" &&
        event.data.commandType === "send",
    ),
  );
  assert.ok(
    secondTurnObservations.some((body) => body.startsWith("COMMAND_FAILED")),
    "the member is woken with the structured error instead of being sealed terminal",
  );
  assert.ok(
    secondTurnObservations.some((body) => body.startsWith("COMMAND_BATCH_HALTED")),
    "the member is told its post-rejection commands (including the finish) were discarded",
  );
  const finishes = result.events.filter(
    (event) => event.type === "member.finished" && event.memberId === "a",
  );
  assert.equal(finishes.length, 1, "the discarded premature finish never applied");
});

test("a throwing presentation observer is disabled and diagnosed, never allowed to change domain outcomes", async () => {
  // Regression: onActivity used to be invoked bare inside executeCommand, so
  // an observer throw was indistinguishable from the command itself failing
  // (bouncing valid commands, even erroring the member); a bare onProgress
  // throw rejected the whole run. Presentation observers are guests — their
  // failure is diagnosed and the observer disabled, nothing more.
  class Finisher {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const agents = [new Finisher({ id: "a", name: "A" }), new Finisher({ id: "b", name: "B" })];
  const result = await new TeamRuntime(
    "guests",
    new Map(agents.map((agent) => [agent.member.id, agent])),
    {
      onActivity: () => {
        throw new Error("activity observer exploded");
      },
      onProgress: () => {
        throw new Error("progress observer exploded");
      },
    },
  ).run({ channel: { kind: "public" }, body: "start" });

  assert.equal(result.settlement.kind, "completed");
  assert.equal(
    result.events.some((event) => event.type === "command.failed"),
    false,
    "an observer throw must not masquerade as a command failure",
  );
  assert.equal(
    result.events.some((event) => event.type === "member.errored"),
    false,
    "an observer throw must not error the member it was watching",
  );
  const observerFailures = result.events.filter((event) => event.type === "observer.failed");
  assert.deepEqual(
    observerFailures.map((event) => event.data.observer).sort(),
    ["onActivity", "onProgress"],
    "each observer's first throw is recorded once, then the observer is disabled",
  );
  assert.ok(verifyAudit(result.events), "diagnostic events chain into the audit like any other");
});
