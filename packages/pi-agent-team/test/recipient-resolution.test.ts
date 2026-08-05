import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand, TeamMember, TeamTurn } from "../src/domain.js";
import { TeamRuntime } from "../src/runtime.js";

test("a display name resolves to its member id when it names exactly one member", async () => {
  class Sender {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "ember", name: "Harry Potter" };
    async act(): Promise<readonly TeamCommand[]> {
      return [
        { type: "send", to: "Hermione Granger", body: "hi" },
        { type: "finish", summary: "done" },
      ];
    }
  }
  class Recipient {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "quill", name: "Hermione Granger" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      assert.ok(turn.observations.some((message) => message.body === "hi"));
      return [{ type: "finish", summary: "received" }];
    }
  }
  const sender = new Sender();
  const recipient = new Recipient();
  const result = await new TeamRuntime(
    "resolve",
    new Map([
      [sender.member.id, sender],
      [recipient.member.id, recipient],
    ]),
  ).run({ channel: { kind: "direct", memberId: "ember" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(result.events.some((event) => event.type === "command.failed"), false);
});

test("a name shared by two members bounces instead of guessing which one is meant", async () => {
  const members: TeamMember[] = [
    { id: "a", name: "Neville" },
    { id: "b", name: "Neville" },
    { id: "c", name: "Sender" },
  ];
  class Sender {
    readonly sessionId = crypto.randomUUID();
    readonly member = members[2];
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "send", to: "Neville", body: "hi" }];
      const failure = turn.observations.find((message) => message.body.startsWith("COMMAND_FAILED"));
      assert.ok(failure, "the ambiguous send should bounce back to the sender");
      assert.match(failure!.body, /ambiguous recipient/);
      return [{ type: "finish", summary: "done" }];
    }
  }
  class Bystander {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const sender = new Sender();
  const result = await new TeamRuntime(
    "ambiguous",
    new Map([
      [members[0].id, new Bystander(members[0])],
      [members[1].id, new Bystander(members[1])],
      [sender.member.id, sender],
    ]),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
});

test("a name matching no member bounces with a clear unknown-recipient error", async () => {
  class Sender {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "a", name: "A" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "send", to: "Nobody Here", body: "hi" }];
      const failure = turn.observations.find((message) => message.body.startsWith("COMMAND_FAILED"));
      assert.ok(failure);
      assert.match(failure!.body, /unknown recipient/);
      return [{ type: "finish", summary: "done" }];
    }
  }
  class Other {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "b", name: "B" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const sender = new Sender();
  const other = new Other();
  const result = await new TeamRuntime(
    "unknown",
    new Map([
      [sender.member.id, sender],
      [other.member.id, other],
    ]),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
});

test("a direct message or handoff to yourself bounces instead of silently disappearing", async () => {
  // Before this fix, post() enqueues an envelope for every audience member
  // except the sender (`recipient === from` is skipped) — so a self-send
  // looked like it went out (posted, recorded, shown in activity) but was
  // never enqueued, never woke anyone, and never bounced either. That's a
  // silent black hole, which invariant 5 forbids for any undeliverable
  // command.
  const bounces: string[] = [];
  class SelfSender {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "a", name: "A" };
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      bounces.push(
        ...turn.observations
          .filter((message) => message.body.startsWith("COMMAND_FAILED"))
          .map((message) => message.body),
      );
      if (turn.turn === 1) return [{ type: "send", to: "a", body: "note to self" }];
      if (turn.turn === 2) return [{ type: "handoff", to: "a", body: "hand off to myself" }];
      return [{ type: "finish", summary: "done" }];
    }
  }
  class Other {
    readonly sessionId = crypto.randomUUID();
    readonly member = { id: "b", name: "B" };
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const selfSender = new SelfSender();
  const other = new Other();
  const result = await new TeamRuntime(
    "self-send",
    new Map([
      [selfSender.member.id, selfSender],
      [other.member.id, other],
    ]),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(result.events.filter((event) => event.type === "command.failed").length, 2);
  assert.equal(bounces.length, 2, "both the self-send and self-handoff should bounce");
  assert.match(bounces[0], /cannot send to yourself/);
  assert.match(bounces[1], /cannot handoff to yourself/);
});

test("PEERS excludes the waking member itself", async () => {
  const members: TeamMember[] = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ];
  const peersSeen = new Map<string, string[]>();
  class Reporter {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      peersSeen.set(
        this.member.id,
        turn.peers.map((peer) => peer.id),
      );
      return [{ type: "finish", summary: "done" }];
    }
  }
  const agents = members.map((member) => new Reporter(member));
  const result = await new TeamRuntime(
    "peers",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "public" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  for (const member of members) {
    const peers = peersSeen.get(member.id) ?? [];
    assert.ok(!peers.includes(member.id), `${member.id} should not see itself in its own PEERS`);
    assert.equal(peers.length, members.length - 1);
  }
});

test("team_group_create accepts a mix of ids and unambiguous names in its members list", async () => {
  const members: TeamMember[] = [
    { id: "a", name: "Creator" },
    { id: "b", name: "ById" },
    { id: "c", name: "ByName" },
  ];
  class Creator {
    readonly sessionId = crypto.randomUUID();
    readonly member = members[0];
    async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "claim", resource: "room" }];
      if (turn.turn === 2)
        return [
          { type: "create-group", channelId: "room", name: "Room", members: ["b", "ByName"] },
          { type: "finish", summary: "done" },
        ];
      return [{ type: "finish", summary: "done" }];
    }
  }
  class Waiter {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const creator = new Creator();
  const result = await new TeamRuntime(
    "group-by-name",
    new Map([
      [creator.member.id, creator],
      [members[1].id, new Waiter(members[1])],
      [members[2].id, new Waiter(members[2])],
    ]),
  ).run({ channel: { kind: "direct", memberId: "a" }, body: "start" });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(result.events.some((event) => event.type === "command.failed"), false);
  const created = result.events.find((event) => event.type === "channel.created");
  assert.ok(created);
});
