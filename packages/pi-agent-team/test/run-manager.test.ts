import assert from "node:assert/strict";
import test from "node:test";
import type { TeamActivity, TeamProgress, TeamResult } from "../src/domain.js";
import {
  MAX_TEAM_ROUND_SUMMARIES,
  MAX_TEAM_RUN_EVENTS,
  TeamRunManager,
  type ManagedTeamRuntime,
} from "../src/run-manager.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (cause: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function result(teamId: string, reportBody = "done"): TeamResult {
  return {
    teamId,
    settlement: { kind: "completed", meaning: "all-members-finished" },
    objectiveVerification: "unverified",
    report: { reporterId: "a", body: reportBody },
    members: [
      {
        id: "a",
        sessionId: "session-a",
        turns: 1,
        state: "finished",
        summary: "done",
      },
    ],
    publicTranscript: [],
    restrictedMessages: [],
    events: [],
    userInterventions: 1,
    auditHead: "0".repeat(64),
  };
}

function progress(teamId: string): TeamProgress {
  return {
    teamId,
    active: [],
    finished: [],
    blocked: ["a"],
    blockedReasons: { a: "needs approval" },
    states: { a: "blocked", b: "waiting" },
    queuedMessages: 0,
    turns: 2,
    recent: "waiting",
  };
}

class FakeRuntime implements ManagedTeamRuntime {
  readonly pending = deferred<TeamResult>();
  readonly prompts: { memberId: string; message: string }[] = [];
  continuation?: FakeRuntime;

  constructor(
    readonly teamId: string,
    readonly objective = "initial",
    readonly continuationOptions?: Parameters<ManagedTeamRuntime["next"]>[1],
  ) {}

  run(_initial: unknown, signal?: AbortSignal): Promise<TeamResult> {
    signal?.addEventListener(
      "abort",
      () => this.pending.reject(signal.reason ?? new Error("aborted")),
      { once: true },
    );
    return this.pending.promise;
  }

  intervene(memberId: string, message: string): void {
    this.prompts.push({ memberId, message });
  }

  hasMember(memberId: string): boolean {
    return memberId === "a";
  }

  next(
    objective: string,
    options?: Parameters<ManagedTeamRuntime["next"]>[1],
  ): FakeRuntime {
    return (this.continuation = new FakeRuntime(this.teamId, objective, options));
  }
}

const activity: TeamActivity = {
  sequence: 1,
  memberId: "a",
  kind: "wake",
  text: "raw text must not enter manager summaries",
  visibility: "public",
  channel: { kind: "direct", memberId: "a" },
  targetIds: ["a"],
};

test("three rounds retain stable identity, sessions, and monotonic round identities", async () => {
  const manager = new TeamRunManager();
  const runtime = new FakeRuntime("stable-team");
  const first = manager.start(runtime, { channel: { kind: "public" }, body: "one" });
  runtime.pending.resolve(result("stable-team", "one"));
  const one = await manager.wait("stable-team", { afterSeq: first.stateChangeSeq, timeoutMs: 1_000 });
  const twoStarted = manager.prompt("stable-team", "a", "two");
  runtime.continuation!.pending.resolve(result("stable-team", "two"));
  const two = await manager.wait("stable-team", { afterSeq: twoStarted.stateChangeSeq, timeoutMs: 1_000 });
  const threeStarted = manager.prompt("stable-team", "a", "three");
  runtime.continuation!.continuation!.pending.resolve(result("stable-team", "three"));
  const three = await manager.wait("stable-team", { afterSeq: threeStarted.stateChangeSeq, timeoutMs: 1_000 });

  assert.equal(three.teamId, first.teamId);
  assert.deepEqual(three.rounds.map((round) => round.roundIndex), [1, 2, 3]);
  assert.equal(new Set(three.rounds.map((round) => round.roundId)).size, 3);
  assert.deepEqual(three.rounds.map((round) => round.result?.members[0].sessionId), ["session-a", "session-a", "session-a"]);
  assert.ok(two.stateChangeSeq < threeStarted.stateChangeSeq);
});

test("round history is capped without invalidating the stable handle", async () => {
  const manager = new TeamRunManager();
  let runtime = new FakeRuntime("history-team");
  let snapshot = manager.start(runtime, { channel: { kind: "public" }, body: "one" });
  runtime.pending.resolve(result("history-team"));
  snapshot = await manager.wait("history-team", { afterSeq: snapshot.stateChangeSeq, timeoutMs: 1_000 });
  for (let index = 2; index <= MAX_TEAM_ROUND_SUMMARIES + 2; index++) {
    snapshot = manager.prompt("history-team", "a", `round ${index}`);
    runtime = runtime.continuation!;
    runtime.pending.resolve(result("history-team"));
    snapshot = await manager.wait("history-team", { afterSeq: snapshot.stateChangeSeq, timeoutMs: 1_000 });
  }
  assert.equal(snapshot.rounds.length, MAX_TEAM_ROUND_SUMMARIES);
  assert.equal(snapshot.rounds[0].roundIndex, 3);
  assert.equal(snapshot.rounds.at(-1)?.roundId, snapshot.roundId);
  assert.equal(manager.get("history-team").teamId, "history-team");
});

test("late callbacks and completion from a cancelled round cannot mutate its continuation", async () => {
  class LateRuntime extends FakeRuntime {
    override run(): Promise<TeamResult> { return this.pending.promise; }
  }
  const manager = new TeamRunManager();
  const runtime = new LateRuntime("race-team");
  const first = manager.start(runtime, { channel: { kind: "public" }, body: "one" });
  manager.cancel("race-team", "stop");
  runtime.pending.reject(new Error("cancelled late"));
  await manager.wait("race-team", { afterSeq: first.stateChangeSeq, timeoutMs: 1_000 });
  const second = manager.prompt("race-team", "a", "two");
  manager.observeProgress("race-team", progress("race-team"), first.roundId);
  assert.equal(manager.get("race-team").progress, undefined);
  assert.equal(manager.get("race-team").roundId, second.roundId);
});
test("detached runs return immediately, wait by sequence without polling, and expose a bounded result", async () => {
  const manager = new TeamRunManager();
  const runtime = new FakeRuntime("run-1");
  const started = manager.start(runtime, { channel: { kind: "public" }, body: "start" });
  assert.equal(started.status, "running");
  assert.equal(started.runId, "run-1");
  assert.equal(started.teamId, "run-1");
  assert.equal(started.roundIndex, 1);
  assert.notEqual(started.roundId, started.teamId);

  const waiting = manager.wait("run-1", { afterSeq: started.stateChangeSeq, timeoutMs: 1_000 });
  manager.observeProgress("run-1", progress("run-1"));
  const changed = await waiting;
  assert.equal(changed.progress?.blockedReasons.a, "needs approval");
  assert.ok(changed.stateChangeSeq > started.stateChangeSeq);

  const prompted = manager.prompt("run-1", "a", "approved");
  assert.deepEqual(runtime.prompts, [{ memberId: "a", message: "approved" }]);
  assert.equal(prompted.events.at(-1)?.summary, "prompted member a");

  const beforeSettle = prompted.stateChangeSeq;
  runtime.pending.resolve(result("run-1"));
  const settled = await manager.wait("run-1", { afterSeq: beforeSettle, timeoutMs: 1_000 });
  assert.equal(settled.status, "settled");
  assert.equal(settled.result?.report?.body, "done");
  assert.deepEqual(settled.result?.messageCounts, { public: 0, restricted: 0 });
  assert.equal("publicTranscript" in (settled.result ?? {}), false, "raw transcript is never exposed");
});

test("a settled team accepts a new prompt as a fresh round over the same handle", async () => {
  const manager = new TeamRunManager();
  const runtime = new FakeRuntime("run-continue");
  const started = manager.start(runtime, { channel: { kind: "public" }, body: "first" });
  runtime.pending.resolve(result("run-continue", "first done"));
  const settled = await manager.wait("run-continue", {
    afterSeq: started.stateChangeSeq,
    timeoutMs: 1_000,
  });

  const continued = manager.prompt("run-continue", "a", "do a different task");
  assert.equal(continued.status, "running");
  assert.equal(continued.runId, "run-continue");
  assert.equal(continued.teamId, settled.teamId);
  assert.equal(continued.roundIndex, 2);
  assert.notEqual(continued.roundId, settled.roundId);
  assert.equal(runtime.continuation?.objective, "do a different task");
  assert.equal(runtime.continuation?.continuationOptions?.reporterId, "a");
  assert.match(runtime.continuation?.continuationOptions?.reportPrompt ?? "", /Reply directly/);
  assert.equal(continued.result, undefined, "the previous round result is not presented as current");

  const beforeSecondSettlement = continued.stateChangeSeq;
  runtime.continuation!.pending.resolve(result("run-continue", "second done"));
  const second = await manager.wait("run-continue", {
    afterSeq: beforeSecondSettlement,
    timeoutMs: 1_000,
  });
  assert.equal(second.status, "settled");
  assert.equal(second.result?.report?.body, "second done");
  assert.deepEqual(second.rounds.map((round) => round.roundIndex), [1, 2]);
  assert.ok(second.events.some((event) => event.summary === "continued team by prompting member a"));
});

test("a synchronously settled team can be retained and continued", () => {
  const manager = new TeamRunManager();
  const runtime = new FakeRuntime("run-retained");
  const retained = manager.retain(runtime, result("run-retained"));
  assert.equal(retained.status, "settled");

  const continued = manager.prompt("run-retained", "a", "follow up");
  assert.equal(continued.status, "running");
  assert.equal(runtime.continuation?.objective, "follow up");
});

test("oversized reports are truncated in snapshots while the reporter session pointer remains", async () => {
  const manager = new TeamRunManager();
  const runtime = new FakeRuntime("run-report-cap");
  const started = manager.start(runtime, { channel: { kind: "public" }, body: "start" });
  runtime.pending.resolve(result("run-report-cap", "界".repeat(20_000)));
  const settled = await manager.wait("run-report-cap", {
    afterSeq: started.stateChangeSeq,
    timeoutMs: 1_000,
  });
  assert.ok(Buffer.byteLength(settled.result!.report!.body, "utf8") <= 16 * 1024);
  assert.match(settled.result!.report!.body, /truncated in background snapshot/);
  assert.equal(settled.result!.members[0].sessionId, "session-a");
});

test("event history is capped and activity bodies are reduced to lightweight summaries", () => {
  const manager = new TeamRunManager();
  const runtime = new FakeRuntime("run-cap");
  manager.start(runtime, { channel: { kind: "public" }, body: "start" });
  for (let index = 0; index < MAX_TEAM_RUN_EVENTS + 20; index++)
    manager.observeActivity("run-cap", { ...activity, sequence: index + 1 });

  const snapshot = manager.get("run-cap");
  assert.equal(snapshot.events.length, MAX_TEAM_RUN_EVENTS);
  assert.equal(JSON.stringify(snapshot.events).includes(activity.text), false);
  assert.equal(snapshot.events.at(-1)?.summary, "a wake");
});

test("cancel has its own signal, wakes waiters, is idempotent, and permits continuation", async () => {
  const manager = new TeamRunManager();
  const runtime = new FakeRuntime("run-cancel");
  const started = manager.start(runtime, { channel: { kind: "public" }, body: "start" });
  const waiting = manager.wait("run-cancel", {
    afterSeq: started.stateChangeSeq,
    timeoutMs: 1_000,
  });
  assert.equal(manager.cancel("run-cancel", "stop now").status, "cancelling");
  assert.ok(
    ["cancelling", "cancelled"].includes((await waiting).status),
    "wait observes cancellation request or its immediately-following terminal transition",
  );

  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = manager.get("run-cancel");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.lifecycle, "available");
  assert.equal(manager.cancel("run-cancel").roundId, cancelled.roundId);
  const continued = manager.prompt("run-cancel", "a", "resume");
  assert.equal(continued.status, "running");
  assert.equal(continued.roundIndex, 2);
  assert.notEqual(continued.roundId, cancelled.roundId);
  assert.throws(() => manager.get("missing"), /Unknown team/);
});

test("wait times out and caller abort does not cancel the detached run", async () => {
  const manager = new TeamRunManager();
  const runtime = new FakeRuntime("run-wait");
  const started = manager.start(runtime, { channel: { kind: "public" }, body: "start" });
  await assert.rejects(
    manager.wait("run-wait", { afterSeq: started.stateChangeSeq, timeoutMs: 5 }),
    /Timed out/,
  );

  const controller = new AbortController();
  const waiting = manager.wait("run-wait", {
    afterSeq: manager.get("run-wait").stateChangeSeq,
    signal: controller.signal,
  });
  controller.abort(new Error("caller stopped waiting"));
  await assert.rejects(waiting, /caller stopped waiting/);
  assert.equal(manager.get("run-wait").status, "running");
});
