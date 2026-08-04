import assert from "node:assert/strict";
import test from "node:test";
import type { TeamCommand, TeamMember, TeamTurn } from "../../src/domain.js";
import { TeamRuntime } from "../../src/runtime.js";
import { IsolatedAgent } from "./isolated-agent.js";

type Role = "wolf" | "seer" | "witch" | "villager";

class PlayerAgent extends IsolatedAgent {
  protected decide(turn: TeamTurn): readonly TeamCommand[] {
    const commands: TeamCommand[] = [];
    for (const message of turn.observations) {
      if (message.body.startsWith("ROLE ")) continue;
      const roleLine = turn.observations
        .concat(...this.seen.flatMap((seen) => seen.observations))
        .find((item) => item.body.startsWith("ROLE "))?.body;
      const role = roleLine?.match(/^ROLE (\w+)/)?.[1] as Role | undefined;
      const alive = parseList(message.body, "alive");
      if (message.body.startsWith("NIGHT") && role === "wolf") {
        const partner = roleLine?.match(/partners=([^;]+)/)?.[1]?.split(",") ?? [];
        const target = alive.find((id) => id !== this.member.id && !partner.includes(id))!;
        commands.push({ type: "send", to: "moderator", body: `KILL ${target}` });
      } else if (message.body.startsWith("NIGHT") && role === "seer") {
        commands.push({
          type: "send",
          to: "moderator",
          body: `INSPECT ${alive.find((id) => id !== this.member.id)!}`,
        });
      } else if (message.body.startsWith("NIGHT") && role === "witch") {
        commands.push({ type: "send", to: "moderator", body: "WITCH pass" });
      } else if (message.body.startsWith("INSPECTION")) {
        const [, target, result] = message.body.split(" ");
        commands.push({
          type: "say",
          body: `CLAIM ${this.member.id} inspected ${target} as ${result}`,
        });
      } else if (message.body.startsWith("DAY")) {
        const knownWolf = this.seen
          .flatMap((seen) => seen.observations)
          .map((item) => item.body.match(/^INSPECTION (\S+) wolf$/)?.[1])
          .find(Boolean);
        const discussionWolf = turn.observations
          .map((item) => item.body.match(/inspected (\S+) as wolf/)?.[1])
          .find(Boolean);
        const target = knownWolf ?? discussionWolf ?? alive.find((id) => id !== this.member.id)!;
        commands.push({ type: "say", body: `DISCUSS ${this.member.id} votes ${target}` });
        commands.push({ type: "send", to: "moderator", body: `VOTE ${target}` });
      } else if (message.body.startsWith("GAMEOVER")) {
        commands.push({ type: "finish", summary: message.body });
      }
    }
    return commands.length ? commands : [{ type: "wait" }];
  }
}

class ModeratorAgent extends IsolatedAgent {
  private readonly roles: Map<string, Role>;
  private alive: string[];
  private phase: "boot" | "night" | "day" = "boot";
  private day = 1;
  private nightActions: string[] = [];
  private votes: string[] = [];
  winner?: string;

  constructor(member: TeamMember, canary: string, players: readonly TeamMember[], seed: number) {
    super(member, canary);
    const roles: Role[] = shuffle(
      ["wolf", "wolf", "seer", "witch", "villager", "villager", "villager", "villager"],
      seed,
    );
    this.roles = new Map(players.map((player, index) => [player.id, roles[index]]));
    this.alive = players.map((player) => player.id);
  }

  protected decide(turn: TeamTurn): readonly TeamCommand[] {
    if (this.phase === "boot") {
      this.phase = "night";
      const wolves = [...this.roles].filter(([, role]) => role === "wolf").map(([id]) => id);
      return [...this.roles].flatMap(([id, role]) => [
        {
          type: "send",
          to: id,
          body: `ROLE ${role};canary=${crypto.randomUUID()}${role === "wolf" ? `;partners=${wolves.filter((wolf) => wolf !== id).join(",")}` : ""}`,
        } as TeamCommand,
        {
          type: "send",
          to: id,
          body: `NIGHT ${this.day};alive=${this.alive.join(",")}`,
        } as TeamCommand,
      ]);
    }
    for (const message of turn.observations) {
      if (/^(KILL|INSPECT|WITCH) /.test(message.body))
        this.nightActions.push(`${message.from}:${message.body}`);
      if (message.body.startsWith("VOTE ")) this.votes.push(message.body.slice(5));
    }
    if (this.phase === "night" && this.hasNightActions()) {
      const commands: TeamCommand[] = [];
      const inspect = this.nightActions.find((action) => action.includes(":INSPECT "));
      if (inspect) {
        const [seer, target] = inspect.split(/:INSPECT | /);
        commands.push({
          type: "send",
          to: seer,
          body: `INSPECTION ${target} ${this.roles.get(target) === "wolf" ? "wolf" : "not-wolf"}`,
        });
      }
      const victim = plurality(
        this.nightActions
          .filter((action) => action.includes(":KILL "))
          .map((action) => action.split(":KILL ")[1]),
      );
      if (victim) this.alive = this.alive.filter((id) => id !== victim);
      this.phase = "day";
      commands.push(
        ...this.alive.map((id) => ({
          type: "send" as const,
          to: id,
          body: `DAY ${this.day};alive=${this.alive.join(",")}`,
        })),
      );
      return commands;
    }
    if (this.phase === "day" && this.votes.length >= this.alive.length) {
      const eliminated = plurality(this.votes.splice(0));
      this.alive = this.alive.filter((id) => id !== eliminated);
      this.winner = this.outcome();
      if (this.winner)
        return [
          ...turn.peers
            .filter((member) => member.id !== this.member.id)
            .map((member) => ({
              type: "send" as const,
              to: member.id,
              body: `GAMEOVER ${this.winner};eliminated=${eliminated}`,
            })),
          { type: "finish", summary: `GAMEOVER ${this.winner}` },
        ];
      this.day++;
      this.phase = "night";
      this.nightActions = [];
      return this.alive.map((id) => ({
        type: "send" as const,
        to: id,
        body: `NIGHT ${this.day};alive=${this.alive.join(",")}`,
      }));
    }
    return [{ type: "wait" }];
  }

  private hasNightActions(): boolean {
    const livingRoles = this.alive.map((id) => this.roles.get(id));
    const expected =
      livingRoles.filter((role) => role === "wolf").length +
      Number(livingRoles.includes("seer")) +
      Number(livingRoles.includes("witch"));
    return this.nightActions.length >= expected;
  }
  private outcome(): string | undefined {
    const wolves = this.alive.filter((id) => this.roles.get(id) === "wolf").length;
    if (!wolves) return "village";
    if (wolves >= this.alive.length - wolves) return "wolves";
  }
}

test("eight opaque players complete werewolf through messages while runtime knows no game rules", async () => {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0];
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: crypto.randomUUID(),
    name: `opaque-player-${index}`,
  }));
  const moderator = { id: "moderator", name: "external-referee" };
  const playerAgents = players.map((player) => new PlayerAgent(player, crypto.randomUUID()));
  const referee = new ModeratorAgent(moderator, crypto.randomUUID(), players, seed);
  const all = [referee, ...playerAgents];
  const result = await new TeamRuntime(
    "Play a complete hidden-role werewolf game using only team messages",
    new Map(all.map((agent) => [agent.member.id, agent])),
    { maxTurns: 300 },
  ).run({ channel: { kind: "direct", memberId: moderator.id }, body: "START" });

  assert.equal(result.settlement.kind, "completed");
  assert.match(referee.winner ?? "", /^(wolves|village)$/);
  assert.equal(result.userInterventions, 0);
  assert.equal(new Set(result.members.map((member) => member.sessionId)).size, 9);
  assert.ok(playerAgents.every((agent) => agent.seen.length >= 2));
  assert.ok(result.events.some((event) => event.type === "message.observed"));
  assert.ok(result.publicTranscript.some((message) => message.body?.startsWith("DISCUSS")));
  assert.equal(result.restrictedMessages.length > 0, true);
  assert.ok(!JSON.stringify(result).includes("ROLE wolf"));
});

function parseList(body: string, key: string): string[] {
  return body.match(new RegExp(`${key}=([^;]+)`))?.[1]?.split(",") ?? [];
}
function plurality(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b))[0]?.[0];
}
function shuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed || 1;
  for (let i = result.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
