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

test("the opening broadcast wave gives every member an independent first take before revealing peers' drafts together", async () => {
  // Reproduces an anchoring bug: same-source sequencing (needed for
  // claim/group/poll convergence) also meant an earlier member's passive
  // team_say landed in a later member's mailbox before that later member
  // had taken even its own first turn — its first take was never
  // independent, it was already informed by a peer's conclusion. The fix
  // holds public passive speech posted during the opening wave back from
  // any not-yet-drafted member, then reveals it all at once right after.
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const firstTurnObservations = new Map<string, string[]>();
  const secondTurnObservations = new Map<string, TeamTurn>();
  class Drafter {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) {
        firstTurnObservations.set(
          this.member.id,
          turn.observations.map((message) => message.body),
        );
        return [{ type: "say", body: `${this.member.id}'s first take` }];
      }
      secondTurnObservations.set(this.member.id, structuredClone(turn));
      return [{ type: "finish", summary: "done" }];
    }
  }
  const agents = members.map((member) => new Drafter(member));
  const result = await new TeamRuntime(
    "opening-draft",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "objective" });

  assert.equal(result.settlement.kind, "completed");
  for (const member of members) {
    assert.deepEqual(
      firstTurnObservations.get(member.id) ?? [],
      ["objective"],
      `${member.id}'s first turn should see only the initial objective, never a peer's opening speech`,
    );
  }
  for (const member of members) {
    const expectedPeerDrafts = members
      .filter((peer) => peer.id !== member.id)
      .map((peer) => `${peer.id}'s first take`);
    const secondTurn = secondTurnObservations.get(member.id);
    assert.ok(secondTurn, `${member.id} should be woken for the opening reveal`);
    const bodies = secondTurn.observations.map((message) => message.body);
    assert.deepEqual(
      [...bodies].sort(),
      [...expectedPeerDrafts].sort(),
      `${member.id} should receive every peer's opening draft exactly once`,
    );
    assert.deepEqual(
      secondTurn.observations.map((message) => message.sequence),
      [...secondTurn.observations]
        .sort((left, right) => left.sequence - right.sequence)
        .map((message) => message.sequence),
      `${member.id}'s revealed drafts should preserve envelope order`,
    );
  }
});

test("a one-element initial-post array gets the same opening barrier as scalar syntax", async () => {
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const firstTurns = new Map<string, string[]>();
  class Drafter {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) {
        firstTurns.set(
          this.member.id,
          turn.observations.map((message) => message.body),
        );
        return [{ type: "say", body: `${this.member.id}'s first take` }];
      }
      return [{ type: "finish", summary: "done" }];
    }
  }
  const agents = members.map((member) => new Drafter(member));
  await new TeamRuntime(
    "array opening draft",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run([{ channel: { kind: "public" }, body: "objective" }]);

  for (const member of members)
    assert.deepEqual(
      firstTurns.get(member.id),
      ["objective"],
      `${member.id}'s array-form start should remain independent`,
    );
});

test("an interrupt reveals earlier held-back public context to its recipient in sequence order", async () => {
  // A common conversational turn is say(context), then DM(peer, "reply").
  // The opening-independence barrier must not deliver the explicit prompt
  // before the public context it refers to. An interrupt deliberately lifts
  // the barrier for its recipient; opening members who are not interrupted
  // remain protected by the ordinary barrier test above.
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ];
  const observed = new Map<string, TeamTurn[]>();
  class ConversationalAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      observed.set(this.member.id, [...(observed.get(this.member.id) ?? []), structuredClone(turn)]);
      if (turn.turn === 1) {
        const peer = this.member.id === "a" ? "b" : "a";
        return [
          { type: "say", body: `context:${this.member.id}` },
          { type: "send", to: peer, body: `ping:${this.member.id}` },
          { type: "wait" },
        ];
      }
      return [{ type: "finish", summary: "done" }];
    }
  }
  const agents = members.map((member) => new ConversationalAgent(member));
  await new TeamRuntime(
    "ordered conversation",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "objective" });

  for (const turns of observed.values()) {
    for (const turn of turns) {
      const peerPing = turn.observations.find((message) => message.body.startsWith("ping:"));
      if (!peerPing) continue;
      const sender = peerPing.body.slice("ping:".length);
      const bodies = turn.observations.map((message) => message.body);
      assert.ok(
        bodies.includes(`context:${sender}`),
        "an interrupt must reveal the earlier public context in the same observation batch",
      );
      assert.deepEqual(
        turn.observations.map((message) => message.sequence),
        [...turn.observations]
          .sort((a, b) => a.sequence - b.sequence)
          .map((message) => message.sequence),
        "mixed held-back and ordinary observations must preserve envelope sequence",
      );
    }
  }
});

test("a directed single-member start is unaffected by the opening-wave barrier", async () => {
  // With only one member interrupted by the initial post, there is no
  // sameSource wave and nobody else's speech could ever be held back for
  // it — the barrier bookkeeping should simply be a no-op here.
  class Starter {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "a", name: "A" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "send", to: "b", body: "go" }, { type: "wait" }];
      return [{ type: "finish", summary: "done" }];
    }
  }
  class Other {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "b", name: "B" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      return [{ type: "send", to: "a", body: "ack" }, { type: "finish", summary: "done" }];
    }
  }
  const starter = new Starter();
  const other = new Other();
  const result = await new TeamRuntime(
    "directed-start",
    new Map([
      [starter.member.id, starter],
      [other.member.id, other],
    ]),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
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

