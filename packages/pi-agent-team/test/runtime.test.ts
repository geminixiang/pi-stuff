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
      if (this.member.id === "a" && turn.turn === 1)
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
  assert.equal(result.restrictedMessages.length, 1);
  assert.equal(JSON.stringify(result).includes("secret plan"), false);
  assert.equal(
    seen
      .get("c")
      ?.some((turn) => turn.observations.some((message) => message.body === "secret plan")),
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
