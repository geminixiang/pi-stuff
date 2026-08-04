import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand, TeamMember, TeamTurn } from "../../src/domain.js";
import { TeamRuntime } from "../../src/runtime.js";
import { IsolatedAgent } from "./isolated-agent.js";

type Operation = { kind: "add" | "multiply" | "xor"; operand: number };

class TransformAgent extends IsolatedAgent {
  constructor(
    member: TeamMember,
    canary: string,
    private readonly operation: Operation,
    private readonly successor?: string,
  ) {
    super(member, canary);
  }
  protected decide(turn: TeamTurn): readonly TeamCommand[] {
    const valueMessage = turn.observations.find((message) => message.body.startsWith("value="));
    if (!valueMessage) return [{ type: "wait" }];
    const input = Number(valueMessage.body.match(/value=(-?\d+)/)?.[1]);
    assert.ok(Number.isFinite(input), `${this.member.id} received no value`);
    const value = apply(input, this.operation);
    const proof = `${this.member.id}:${this.operation.kind}:${this.operation.operand}`;
    return this.successor
      ? [
          {
            type: "send",
            to: this.successor,
            body: `value=${value};proof=${proof}`,
          },
          { type: "finish", summary: `relayed ${value}` },
        ]
      : [
          { type: "say", body: `FINAL value=${value};proof=${proof}` },
          { type: "finish", summary: `final ${value}` },
        ];
  }
}

test("random private transformations causally relay across eight isolated agents", async () => {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const start = 10 + (seed % 97);
  const operations: Operation[] = Array.from({ length: 8 }, (_, index) => {
    const value = (((seed >>> (index % 16)) + index * 17) % 9) + 2;
    return index % 3 === 0
      ? { kind: "add", operand: value }
      : index % 3 === 1
        ? { kind: "multiply", operand: value }
        : { kind: "xor", operand: value };
  });
  const members = Array.from({ length: 8 }, (_, index) => ({
    id: crypto.randomUUID(),
    name: `member-${index + 1}`,
  }));
  const canaries = members.map(() => crypto.randomUUID());
  const agentList = members.map(
    (member, index) =>
      new TransformAgent(member, canaries[index], operations[index], members[index + 1]?.id),
  );
  const result = await new TeamRuntime(
    "Pass a numeric value through each member's private transformation",
    new Map(agentList.map((agent) => [agent.member.id, agent])),
  ).run([
    ...members.map((member, index) => ({
      channel: { kind: "direct" as const, memberId: member.id },
      body: `PRIVATE_CANARY ${canaries[index]}`,
    })),
    { channel: { kind: "direct", memberId: members[0].id }, body: `value=${start}` },
  ]);

  const expected = operations.reduce(apply, start);
  const publicFinal = result.publicTranscript.find((message) => message.body.startsWith("FINAL"));
  assert.equal(
    publicFinal?.body,
    `FINAL value=${expected};proof=${members[7].id}:${operations[7].kind}:${operations[7].operand}`,
  );
  assert.equal(result.settlement.kind, "completed");
  assert.equal(result.userInterventions, 0);
  assert.equal(new Set(result.members.map((member) => member.sessionId)).size, 8);
  assert.deepEqual(
    result.members.map((member) => member.turns),
    [1, 2, 2, 2, 2, 2, 2, 2],
  );

  for (let index = 0; index < agentList.length; index++) {
    const seenText = JSON.stringify(agentList[index].seen);
    for (let other = 0; other < canaries.length; other++)
      if (other !== index) assert.ok(!seenText.includes(canaries[other]));
    assert.equal(
      agentList[index].seen
        .flatMap((turn) => turn.observations)
        .filter((message) => message.body.startsWith("value=")).length,
      1,
    );
    const relayMessage = agentList[index].seen
      .flatMap((turn) => turn.observations)
      .find((message) => message.body.startsWith("value="))!;
    assert.equal(relayMessage.from, index === 0 ? "user" : members[index - 1].id);
  }
  assert.ok(
    result.publicTranscript.filter(() => false).every((message) => message.body === undefined),
  );
  assertCausalChain(
    result.events,
    members.map((member) => member.id),
  );
});

test("removing one relay member prevents completion instead of runtime filling the answer", async () => {
  const members = Array.from({ length: 3 }, (_, index) => ({
    id: `opaque-${index}`,
    name: `member-${index}`,
  }));
  const agents = [
    new TransformAgent(members[0], "a", { kind: "add", operand: 7 }, members[1].id),
    new TransformAgent(members[1], "b", { kind: "multiply", operand: 3 }),
  ];
  const result = await new TeamRuntime(
    "opaque challenge",
    new Map(agents.map((agent) => [agent.member.id, agent])),
  ).run({ channel: { kind: "direct", memberId: members[0].id }, body: "value=11" });
  assert.equal(result.settlement.kind, "completed");
  assert.ok(!result.publicTranscript.some((message) => message.body?.includes("FINAL value=59")));
});

function apply(value: number, operation: Operation): number {
  if (operation.kind === "add") return value + operation.operand;
  if (operation.kind === "multiply") return value * operation.operand;
  return value ^ operation.operand;
}

function assertCausalChain(
  events: readonly { type: string; memberId?: string; messageId?: string }[],
  members: readonly string[],
): void {
  for (let index = 1; index < members.length; index++) {
    const priorWake = events.findIndex(
      (event) => event.type === "member.woke" && event.memberId === members[index - 1],
    );
    const sent = events.find(
      (event, eventIndex) =>
        eventIndex > priorWake &&
        event.type === "message.posted" &&
        event.memberId === members[index - 1],
    );
    const delivery = events.findIndex(
      (event) =>
        event.type === "message.observed" &&
        event.memberId === members[index] &&
        event.messageId === sent?.messageId,
    );
    const wake = events.findIndex(
      (event, eventIndex) =>
        eventIndex > delivery && event.type === "member.woke" && event.memberId === members[index],
    );
    assert.ok(priorWake < delivery && delivery < wake, `missing causal edge ${index - 1}→${index}`);
  }
}
