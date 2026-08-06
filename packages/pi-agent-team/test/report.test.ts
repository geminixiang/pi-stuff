import assert from "node:assert/strict";
import test from "node:test";
import type { TeamAgent, TeamCommand, TeamMember, TeamTurn } from "../src/domain.js";
import { REPORTER_RESOURCE, TeamRuntime, verifyAudit } from "../src/runtime.js";

/** Claims "reporter" on its first turn, finishes on the next, then reports. */
class VolunteerReporter {
  readonly sessionId = crypto.randomUUID();
  readonly sessionRef: string;
  reportPromptSeen?: string;
  constructor(readonly member: TeamMember) {
    this.sessionRef = `/sessions/${member.id}.jsonl`;
  }
  async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
    if (turn.turn === 1) return [{ type: "claim", resource: REPORTER_RESOURCE }];
    return [{ type: "finish", summary: "coordinated the work" }];
  }
  async report(prompt: string): Promise<string> {
    this.reportPromptSeen = prompt;
    return "FINAL: the wolves won";
  }
}

class Worker {
  readonly sessionId = crypto.randomUUID();
  constructor(readonly member: TeamMember) {}
  async act(): Promise<readonly TeamCommand[]> {
    return [{ type: "finish", summary: "worked" }];
  }
  async report(): Promise<string> {
    return "worker report (should never be requested)";
  }
}

function teamOf(agents: readonly TeamAgent[]): Map<string, TeamAgent> {
  return new Map(agents.map((agent) => [agent.member.id, agent]));
}

test("claiming the reporter resource earns the post-settlement report turn, and finishing does not renounce it", async () => {
  const reporter = new VolunteerReporter({ id: "rex", name: "Rex" });
  const worker = new Worker({ id: "wren", name: "Wren" });
  const result = await new TeamRuntime("do the thing", teamOf([reporter, worker])).run({
    channel: { kind: "public" },
    body: "go",
  });
  assert.equal(result.settlement.kind, "completed");
  assert.equal(result.report?.reporterId, "rex");
  assert.equal(result.report?.body, "FINAL: the wolves won");
  assert.equal(result.reportError, undefined);
  // The report prompt tells the reporter the team settled and that this
  // turn addresses the requester, not teammates.
  assert.match(reporter.reportPromptSeen ?? "", /TEAM SETTLED: completed/);
  assert.match(reporter.reportPromptSeen ?? "", /requester/);
  // The report is audited (requested then submitted) and the chain still verifies.
  const types = result.events.map((event) => event.type);
  assert.ok(types.includes("report.requested"));
  assert.ok(types.includes("report.submitted"));
  assert.ok(verifyAudit(result.events));
});

test("a caller-supplied reportPrompt reaches the reporter verbatim", async () => {
  const reporter = new VolunteerReporter({ id: "rex", name: "Rex" });
  const worker = new Worker({ id: "wren", name: "Wren" });
  await new TeamRuntime("do the thing", teamOf([reporter, worker]), {
    reporterId: "rex",
    reportPrompt: "以繁體中文輸出 report.md",
  }).run({ channel: { kind: "public" }, body: "go" });
  assert.match(reporter.reportPromptSeen ?? "", /以繁體中文輸出 report\.md/);
});

test("a designated reporterId reports without ever claiming, and wins over any claim", async () => {
  // Rex claims the reporter resource during play, but the caller designated
  // Wren — explicit designation is not overridable from inside the team.
  const rex = new VolunteerReporter({ id: "rex", name: "Rex" });
  const wren = new Worker({ id: "wren", name: "Wren" });
  const result = await new TeamRuntime("do the thing", teamOf([rex, wren]), {
    reporterId: "wren",
  }).run({ channel: { kind: "public" }, body: "go" });
  assert.equal(result.report?.reporterId, "wren");
});

test("voluntarily releasing the reporter claim renounces the duty: no report, honestly no reportError", async () => {
  class RenouncingReporter extends VolunteerReporter {
    override async act(turn: TeamTurn): Promise<readonly TeamCommand[]> {
      if (turn.turn === 1) return [{ type: "claim", resource: REPORTER_RESOURCE }];
      return [
        { type: "release", resource: REPORTER_RESOURCE },
        { type: "finish", summary: "renounced" },
      ];
    }
  }
  const reporter = new RenouncingReporter({ id: "rex", name: "Rex" });
  const worker = new Worker({ id: "wren", name: "Wren" });
  const result = await new TeamRuntime("do the thing", teamOf([reporter, worker])).run({
    channel: { kind: "public" },
    body: "go",
  });
  assert.equal(result.report, undefined);
  assert.equal(result.reportError, undefined);
});

test("an errored reporter yields reportError instead of a fabricated report", async () => {
  class ExplodingReporter {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      throw new Error("provider died");
    }
    async report(): Promise<string> {
      throw new Error("must never be called");
    }
  }
  const reporter = new ExplodingReporter({ id: "rex", name: "Rex" });
  const worker = new Worker({ id: "wren", name: "Wren" });
  const result = await new TeamRuntime("do the thing", teamOf([reporter, worker]), {
    reporterId: "rex",
  }).run({ channel: { kind: "public" }, body: "go" });
  assert.equal(result.report, undefined);
  assert.match(result.reportError ?? "", /errored before reporting/);
  assert.ok(result.events.every((event) => event.type !== "report.requested"));
});

test("a reporter whose agent lacks report support yields reportError, not a crash", async () => {
  class NoReportAgent {
    readonly sessionId = crypto.randomUUID();
    constructor(readonly member: TeamMember) {}
    async act(): Promise<readonly TeamCommand[]> {
      return [{ type: "finish", summary: "done" }];
    }
  }
  const rex = new NoReportAgent({ id: "rex", name: "Rex" });
  const wren = new NoReportAgent({ id: "wren", name: "Wren" });
  const result = await new TeamRuntime("do the thing", teamOf([rex, wren]), {
    reporterId: "rex",
  }).run({ channel: { kind: "public" }, body: "go" });
  assert.match(result.reportError ?? "", /does not support a report turn/);
});

test("with no designation and no claim there is simply no report", async () => {
  const rex = new Worker({ id: "rex", name: "Rex" });
  const wren = new Worker({ id: "wren", name: "Wren" });
  const result = await new TeamRuntime("do the thing", teamOf([rex, wren])).run({
    channel: { kind: "public" },
    body: "go",
  });
  assert.equal(result.report, undefined);
  assert.equal(result.reportError, undefined);
});

test("an unknown reporterId is rejected at construction, before any member acts", () => {
  const rex = new Worker({ id: "rex", name: "Rex" });
  const wren = new Worker({ id: "wren", name: "Wren" });
  assert.throws(
    () => new TeamRuntime("do the thing", teamOf([rex, wren]), { reporterId: "ghost" }),
    /Unknown reporterId: ghost/,
  );
});

test("member sessionRef pointers flow through to the result untouched", async () => {
  const reporter = new VolunteerReporter({ id: "rex", name: "Rex" });
  const worker = new Worker({ id: "wren", name: "Wren" });
  const result = await new TeamRuntime("do the thing", teamOf([reporter, worker])).run({
    channel: { kind: "public" },
    body: "go",
  });
  assert.equal(
    result.members.find((member) => member.id === "rex")?.sessionRef,
    "/sessions/rex.jsonl",
  );
  // Workers persist nothing in this fake; absence is represented, not invented.
  assert.equal(result.members.find((member) => member.id === "wren")?.sessionRef, undefined);
});
