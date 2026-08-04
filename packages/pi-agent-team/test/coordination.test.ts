import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand, TeamMember, TeamTurn } from "../src/domain.js";
import { TeamRuntime, verifyAudit } from "../src/runtime.js";

function runtimeOf(agents: { member: TeamMember; sessionId: string; act: any }[], options = {}) {
  return new TeamRuntime(
    "coordinate",
    new Map(agents.map((agent) => [agent.member.id, agent as any])),
    options,
  );
}

test("reactionDelayMs staggers each wake by the configured range and defaults to off", async () => {
  class Finisher {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const agentsOf = () => [new Finisher({ id: "a", name: "A" }), new Finisher({ id: "b", name: "B" })];

  const withoutDelay = Date.now();
  await runtimeOf(agentsOf()).run({ channel: { kind: "public" }, body: "start" });
  const fastElapsed = Date.now() - withoutDelay;

  const withDelay = Date.now();
  const result = await runtimeOf(agentsOf(), { reactionDelayMs: { min: 40, max: 40 } }).run({
    channel: { kind: "public" },
    body: "start",
  });
  const delayedElapsed = Date.now() - withDelay;

  assert.equal(result.settlement.kind, "completed");
  assert.ok(delayedElapsed >= 40, `expected at least one 40ms stagger, got ${delayedElapsed}ms`);
  assert.ok(
    delayedElapsed > fastElapsed,
    `configured delay (${delayedElapsed}ms) should be slower than the default (${fastElapsed}ms)`,
  );
});

test("flush wake delivers queued public speech so a waiting coordinator can finish", async () => {
  const digestsSeen: TeamTurn["digest"][] = [];
  class Hub {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "hub", name: "Hub" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "send", to: "worker", body: "go" }];
      if (turn.observations.some((message) => message.body === "done")) {
        digestsSeen.push(turn.digest);
        return [{ type: "finish", summary: "confirmed" }];
      }
      return [{ type: "wait" }];
    }
  }
  class Worker {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "worker", name: "Worker" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body === "go"))
        return [
          { type: "say", body: "done" },
          { type: "finish", summary: "worked" },
        ];
      return [{ type: "wait" }];
    }
  }
  const result = await runtimeOf([new Hub(), new Worker()]).run({
    channel: { kind: "public" },
    body: "start",
  });
  assert.equal(result.settlement.kind, "completed");
  assert.ok(result.events.some((event) => event.type === "member.flushWoke"));
  assert.equal(digestsSeen[0]?.states.worker, "finished");
  assert.equal(verifyAudit(result.events), true);
});

test("commands to unknown or finished recipients bounce instead of crashing the team", async () => {
  class Alpha {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "alpha", name: "Alpha" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1)
        return [
          { type: "send", to: "beta", body: "bye" },
          { type: "finish", summary: "left" },
        ];
      return [{ type: "wait" }];
    }
  }
  class Beta {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "beta", name: "Beta" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "send", to: "alpha", body: "hello" }];
      if (turn.observations.some((message) => message.body === "bye"))
        return [{ type: "send", to: "alpha", body: "again" }];
      const failure = turn.observations.find((message) =>
        message.body.startsWith("COMMAND_FAILED"),
      );
      if (failure) return [{ type: "finish", summary: failure.body }];
      return [{ type: "wait" }];
    }
  }
  const result = await runtimeOf([new Alpha(), new Beta()]).run({
    channel: { kind: "direct", memberId: "beta" },
    body: "start",
  });
  assert.equal(result.settlement.kind, "completed");
  assert.ok(result.events.some((event) => event.type === "command.failed"));
  const beta = result.members.find((member) => member.id === "beta");
  assert.match(beta?.summary ?? "", /COMMAND_FAILED.*finished/);
});

test("a throwing member degrades to errored and the rest of the team is alerted", async () => {
  class Bad {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "bad", name: "Bad" };
    async act(): Promise<readonly TeamCommand[]> {
      throw new Error("boom");
    }
  }
  class Good {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "good", name: "Good" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      const alert = turn.observations.find((message) =>
        message.body.startsWith("MEMBER_ERRORED"),
      );
      if (alert) return [{ type: "finish", summary: alert.body }];
      return [{ type: "wait" }];
    }
  }
  const result = await runtimeOf([new Bad(), new Good()]).run({
    channel: { kind: "public" },
    body: "start",
  });
  assert.deepEqual(result.settlement, { kind: "quiescent", meaning: "errored-members-remain" });
  const bad = result.members.find((member) => member.id === "bad");
  assert.equal(bad?.state, "errored");
  assert.equal(bad?.error, "boom");
  assert.ok(result.events.some((event) => event.type === "member.errored"));
  const good = result.members.find((member) => member.id === "good");
  assert.match(good?.summary ?? "", /MEMBER_ERRORED member=bad/);
  assert.equal(verifyAudit(result.events), true);
});

test("a genuinely stuck idle member (not errored) is reported as no-runnable-members", async () => {
  class NeverFinishes {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "stuck", name: "Stuck" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "wait" }];
    }
  }
  class Finisher {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "finisher", name: "Finisher" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const result = await runtimeOf([new NeverFinishes(), new Finisher()]).run({
    channel: { kind: "direct", memberId: "finisher" },
    body: "start",
  });
  assert.deepEqual(result.settlement, { kind: "quiescent", meaning: "no-runnable-members" });
  assert.equal(result.members.find((member) => member.id === "stuck")?.state, "idle");
});

test("a message loop settles as exhausted with a partial result instead of throwing", async () => {
  class PingPong {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember, private readonly peer: string) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "send", to: this.peer, body: "again" }];
    }
  }
  const result = await runtimeOf(
    [new PingPong({ id: "a", name: "A" }, "b"), new PingPong({ id: "b", name: "B" }, "a")],
    { maxTurns: 4 },
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  assert.equal(result.settlement.kind, "exhausted");
  assert.equal(
    result.members.reduce((sum, member) => sum + member.turns, 0),
    4,
  );
  assert.ok(result.events.some((event) => event.type === "team.exhausted"));
});

test("a released claim can be acquired by another member and finish auto-releases", async () => {
  class Owner {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "owner", name: "Owner" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "claim", resource: "token" }];
      if (turn.observations.some((message) => message.body.startsWith("CLAIM_ACQUIRED")))
        return [
          { type: "release", resource: "token" },
          { type: "send", to: "next", body: "your turn" },
        ];
      return [{ type: "finish", summary: "rotated" }];
    }
  }
  class Next {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "next", name: "Next" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body.startsWith("CLAIM_ACQUIRED")))
        return [{ type: "finish", summary: "acquired" }];
      if (turn.observations.some((message) => message.body === "your turn"))
        return [{ type: "claim", resource: "token" }];
      return [{ type: "wait" }];
    }
  }
  const result = await runtimeOf([new Owner(), new Next()]).run({
    channel: { kind: "public" },
    body: "start",
  });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(result.events.filter((event) => event.type === "member.claimed").length, 2);
  assert.ok(result.events.filter((event) => event.type === "claim.released").length >= 2);
  assert.equal(result.events.some((event) => event.type === "member.claimRejected"), false);
});

test("per-turn command budget truncates a storm and notifies the member", async () => {
  class Storm {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "storm", name: "Storm" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1)
        return Array.from({ length: 20 }, (_, index) => ({
          type: "say" as const,
          body: `burst ${index}`,
        }));
      const notice = turn.observations.find((message) =>
        message.body.startsWith("COMMAND_BUDGET_EXCEEDED"),
      );
      if (notice) return [{ type: "finish", summary: notice.body }];
      return [{ type: "wait" }];
    }
  }
  class Bystander {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "bystander", name: "Bystander" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.observations.some((message) => message.body.startsWith("burst")))
        return [{ type: "finish", summary: "heard" }];
      return [{ type: "wait" }];
    }
  }
  const result = await runtimeOf([new Storm(), new Bystander()], { maxCommandsPerTurn: 5 }).run({
    channel: { kind: "public" },
    body: "start",
  });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(
    result.publicTranscript.filter((message) => message.body.startsWith("burst")).length,
    5,
  );
  assert.match(
    result.members.find((member) => member.id === "storm")?.summary ?? "",
    /applied=5 dropped=15/,
  );
});
