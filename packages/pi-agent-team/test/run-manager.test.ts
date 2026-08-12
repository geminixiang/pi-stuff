import assert from "node:assert/strict";
import test from "node:test";
import type { TeamActivity, TeamProgress, TeamResult } from "../src/domain.js";
import {
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

  constructor(readonly teamId: string) {}

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

test("detached runs return immediately, wait by sequence without polling, and expose a bounded result", async () => {
  const manager = new TeamRunManager();
  const runtime = new FakeRuntime("run-1");
  const started = manager.start(runtime, { channel: { kind: "public" }, body: "start" });
  assert.equal(started.status, "running");
  assert.equal(started.runId, "run-1");

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

test("cancel has its own signal, wakes waiters, and terminal or invalid mutations fail explicitly", async () => {
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
  assert.equal(manager.get("run-cancel").status, "cancelled");
  assert.throws(() => manager.prompt("run-cancel", "a", "resume"), /no longer accepts/);
  assert.throws(() => manager.cancel("run-cancel"), /no longer accepts/);
  assert.throws(() => manager.get("missing"), /Unknown team run/);
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
