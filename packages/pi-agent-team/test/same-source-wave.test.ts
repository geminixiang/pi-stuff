import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand, TeamMember, TeamTurn } from "../src/domain.js";
import { TeamRuntime } from "../src/runtime.js";

test("a wave woken by one shared broadcast runs sequentially: later members see earlier members' claims already applied", async () => {
  const digestsAtWake: { id: string; claims: Record<string, string> }[] = [];
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
    { id: "d", name: "D" },
  ];

  class ClaimOrWait {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      digestsAtWake.push({ id: this.member.id, claims: { ...turn.digest.claims } });
      if (turn.turn === 1) return [{ type: "claim", resource: "canonical" }];
      return [{ type: "finish", summary: "done" }];
    }
  }

  const agents = members.map((member) => new ClaimOrWait(member));
  const result = await new TeamRuntime(
    "broadcast",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "start" });

  assert.equal(result.settlement.kind, "completed");
  const claimedEvents = result.events.filter((event) => event.type === "member.claimed");
  const rejectedEvents = result.events.filter((event) => event.type === "member.claimRejected");
  assert.equal(claimedEvents.length, 1, "exactly one member wins the claim");
  assert.equal(rejectedEvents.length, 3, "the other three are rejected, not left racing");

  const winner = claimedEvents[0].memberId;
  const firstWake = digestsAtWake[0];
  const laterWakes = digestsAtWake.slice(1);
  assert.deepEqual(firstWake.claims, {}, "the first member in the wave sees no prior claim yet");
  for (const wake of laterWakes)
    assert.equal(
      wake.claims.canonical,
      winner,
      `member ${wake.id} should already see ${winner}'s claim before acting, proving sequential (not concurrent) execution`,
    );
});

test("team_broadcast is the sole member-originated public interrupt: it wakes everyone from one shared envelope", async () => {
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  class Asker {
    readonly sessionId = crypto.randomUUID();
    readonly member = members[0];
    async act(): Promise<readonly TeamCommand[]> {
      return [
        { type: "broadcast", body: "everyone answer now" },
        { type: "finish", summary: "asked" },
      ];
    }
  }
  class Answerer {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      assert.ok(
        turn.observations.some((message) => message.body === "everyone answer now"),
        `${this.member.id} should have been woken by the broadcast`,
      );
      return [{ type: "finish", summary: "answered" }];
    }
  }
  const agents = [new Asker(), new Answerer(members[1]), new Answerer(members[2])];
  const result = await new TeamRuntime(
    "broadcast-wake",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(
    result.members.find((member) => member.id === "b")?.turns,
    1,
    "b needed only one turn — the broadcast woke it directly, no per-recipient DM required",
  );
  assert.equal(result.members.find((member) => member.id === "c")?.turns, 1);
});

test("a wave woken by distinct envelopes (different direct messages) is unaffected — still completes normally", async () => {
  class Direct {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const agents = members.map((member) => new Direct(member));
  const result = await new TeamRuntime(
    "mixed",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run([
    { channel: { kind: "direct", memberId: "a" }, body: "go" },
    { channel: { kind: "direct", memberId: "b" }, body: "go" },
  ]);
  assert.equal(result.settlement.kind, "completed");
});
