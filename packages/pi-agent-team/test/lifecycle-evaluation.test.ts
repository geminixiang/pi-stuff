import assert from "node:assert/strict";
import test from "node:test";
import type { TeamActivity, TeamResult } from "../src/domain.js";
import { renderFinalContent } from "../src/extension.js";
import * as retainedApi from "../src/run-manager.js";
import {
  TeamRunManager,
  type ManagedTeamRuntime,
  type TeamRunSnapshot,
} from "../src/run-manager.js";

/**
 * Black-box lifecycle evaluation for docs/lifecycle-improvement-evaluation.md.
 *
 * These adapters deliberately accept either a nested `latestRound`/`currentRound`
 * TeamHandle representation or an equivalent flat latest-round representation.
 * Assertions below concern lifecycle semantics, not incidental property nesting.
 */
type EvaluationRound = {
  roundId?: string;
  roundIndex?: number;
  objective?: string;
  status?: string;
  outcome?: unknown;
  result?: unknown;
  cancellation?: { requested?: boolean; reason?: string };
  cancellationRequested?: boolean;
  cancellationReason?: string;
};

type EvaluationHandle = TeamRunSnapshot & {
  teamStatus?: string;
  currentRound?: EvaluationRound;
  latestRound?: EvaluationRound;
  round?: EvaluationRound;
  rounds?: readonly EvaluationRound[];
  roundHistory?: readonly EvaluationRound[];
  members?: readonly { id: string; sessionId: string; sessionRef?: string }[];
};

function handle(snapshot: TeamRunSnapshot): EvaluationHandle {
  return snapshot as EvaluationHandle;
}

function latest(snapshot: TeamRunSnapshot): EvaluationRound {
  const value = handle(snapshot).latestRound ?? handle(snapshot).currentRound ?? handle(snapshot).round;
  assert.ok(value, "retained TeamHandle snapshot must expose explicit latest/current RoundRun identity");
  return value;
}

function history(snapshot: TeamRunSnapshot): readonly EvaluationRound[] {
  const value = handle(snapshot).roundHistory ?? handle(snapshot).rounds;
  assert.ok(value, "retained TeamHandle snapshot must expose bounded round summaries");
  return value;
}

function roundOutcome(round: EvaluationRound): unknown {
  return round.outcome ?? round.result ?? round.status;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const sessions = Object.freeze([
  { id: "a", sessionId: "session-a", sessionRef: "/sessions/a.jsonl" },
  { id: "b", sessionId: "session-b", sessionRef: "/sessions/b.jsonl" },
]);

function completedResult(teamId: string, label: string): TeamResult {
  return {
    teamId,
    settlement: { kind: "completed", meaning: "all-members-finished" },
    objectiveVerification: "unverified",
    report: { reporterId: "a", body: `${label} complete` },
    members: sessions.map((member) => ({ ...member, turns: 1, state: "finished", summary: label })),
    publicTranscript: [],
    restrictedMessages: [],
    events: [],
    userInterventions: 0,
    auditHead: "0".repeat(64),
  };
}

class ScriptedRound implements ManagedTeamRuntime {
  readonly pending = deferred<TeamResult>();
  readonly aborts: unknown[] = [];
  continuation?: ScriptedRound;

  constructor(
    readonly teamId: string,
    readonly objective: string,
    private readonly abortMode: "reject" | "ignore" = "reject",
  ) {}

  run(_initial: unknown, signal?: AbortSignal): Promise<TeamResult> {
    signal?.addEventListener("abort", () => {
      this.aborts.push(signal.reason);
      if (this.abortMode === "reject") this.pending.reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
    return this.pending.promise;
  }

  intervene(): void {}

  hasMember(memberId: string): boolean {
    return sessions.some((member) => member.id === memberId);
  }

  next(objective: string): ScriptedRound {
    return (this.continuation = new ScriptedRound(this.teamId, objective));
  }
}

async function settle(
  manager: TeamRunManager,
  runtime: ScriptedRound,
  label: string,
): Promise<TeamRunSnapshot> {
  const before = manager.get(runtime.teamId).stateChangeSeq;
  runtime.pending.resolve(completedResult(runtime.teamId, label));
  return manager.wait(runtime.teamId, { afterSeq: before, timeoutMs: 1_000 });
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("lifecycle evaluation: three rounds retain team and member identity with distinct history", async () => {
  const manager = new TeamRunManager();
  const first = new ScriptedRound("team-three", "objective one");
  manager.start(first, { channel: { kind: "public" }, body: "begin" });
  await settle(manager, first, "one");

  manager.prompt(first.teamId, "a", "objective two");
  const second = first.continuation!;
  await settle(manager, second, "two");

  manager.prompt(first.teamId, "a", "objective three");
  const third = second.continuation!;
  const final = await settle(manager, third, "three");
  const rounds = history(final);

  assert.equal(final.teamId, "team-three");
  assert.deepEqual(rounds.map((round) => round.roundIndex), [1, 2, 3]);
  assert.equal(new Set(rounds.map((round) => round.roundId)).size, 3);
  assert.ok(rounds.every((round) => typeof round.roundId === "string" && round.roundId.length > 0));
  assert.equal(latest(final).roundId, rounds[2].roundId);
  assert.deepEqual(rounds.map((round) => round.objective), ["objective one", "objective two", "objective three"]);

  const retainedMembers = handle(final).members ?? (latest(final).result as TeamResult | undefined)?.members;
  assert.deepEqual(
    retainedMembers?.map(({ id, sessionId, sessionRef }) => ({ id, sessionId, sessionRef })),
    sessions,
    "continuations must retain the original member sessions rather than create replacements",
  );
});

test("lifecycle evaluation: cancel makes the team available and continuation settles", async () => {
  const manager = new TeamRunManager();
  const first = new ScriptedRound("team-cancel", "cancel me");
  manager.start(first, { channel: { kind: "public" }, body: "begin" });
  manager.cancel(first.teamId, "requester changed direction");
  await nextTick();

  const cancelled = manager.get(first.teamId);
  assert.equal(handle(cancelled).teamStatus ?? cancelled.status, "available");
  assert.match(JSON.stringify(latest(cancelled)), /requester changed direction/);
  assert.match(JSON.stringify(roundOutcome(latest(cancelled))), /cancel/i);

  const continued = manager.prompt(first.teamId, "a", "replacement objective");
  assert.equal(handle(continued).teamStatus ?? continued.status, "running");
  const second = first.continuation!;
  const settled = await settle(manager, second, "replacement");
  assert.equal(settled.teamId, first.teamId);
  assert.equal(latest(settled).roundIndex, 2);
  assert.match(JSON.stringify(roundOutcome(latest(settled))), /completed|settled/);
  assert.deepEqual(second.aborts, []);
});

test("lifecycle evaluation: cancelled-round completion cannot mutate its successor", async () => {
  const manager = new TeamRunManager();
  const first = new ScriptedRound("team-race", "stale objective", "ignore");
  manager.start(first, { channel: { kind: "public" }, body: "begin" });
  manager.cancel(first.teamId, "replace round");

  // The lifecycle contract must terminalize cancellation independently of an
  // uncooperative old promise, allowing the retained team to continue.
  await nextTick();
  const cancelledRoundId = latest(manager.get(first.teamId)).roundId;
  manager.prompt(first.teamId, "a", "live objective");
  const second = first.continuation!;
  const liveRoundId = latest(manager.get(first.teamId)).roundId;
  assert.notEqual(liveRoundId, cancelledRoundId);

  first.pending.resolve(completedResult(first.teamId, "STALE-ROUND-CANARY"));
  await nextTick();
  const afterLateCompletion = manager.get(first.teamId);
  assert.equal(latest(afterLateCompletion).roundId, liveRoundId);
  assert.equal(JSON.stringify(latest(afterLateCompletion)).includes("STALE-ROUND-CANARY"), false);

  const settled = await settle(manager, second, "live");
  assert.equal(latest(settled).roundId, liveRoundId);
  assert.match(JSON.stringify(roundOutcome(latest(settled))), /completed|settled/);
});

test("lifecycle evaluation: wait observes strictly monotonic cancel, settlement, and restart", async () => {
  const manager = new TeamRunManager();
  const first = new ScriptedRound("team-sequence", "first");
  const started = manager.start(first, { channel: { kind: "public" }, body: "begin" });

  const cancelWait = manager.wait(first.teamId, { afterSeq: started.stateChangeSeq, timeoutMs: 1_000 });
  manager.cancel(first.teamId, "stop");
  const cancelRequested = await cancelWait;

  const terminal = await manager.wait(first.teamId, {
    afterSeq: cancelRequested.stateChangeSeq,
    timeoutMs: 1_000,
  });
  const restart = manager.prompt(first.teamId, "a", "second");

  assert.ok(started.stateChangeSeq < cancelRequested.stateChangeSeq);
  assert.ok(cancelRequested.stateChangeSeq < terminal.stateChangeSeq);
  assert.ok(terminal.stateChangeSeq < restart.stateChangeSeq);
  assert.equal(latest(restart).roundIndex, 2);

  const repeated = manager.cancel(first.teamId, "stop second");
  const repeatedAgain = manager.cancel(first.teamId, "stop second");
  assert.equal(latest(repeatedAgain).roundId, latest(repeated).roundId, "repeated cancel creates no round");
});

test("lifecycle evaluation: round summaries have an explicit cap and evict oldest first", async () => {
  const exportedCap = (retainedApi as Record<string, unknown>).MAX_TEAM_ROUND_SUMMARIES;
  assert.equal(typeof exportedCap, "number", "round-summary history must publish an explicit fixed cap");
  const cap = exportedCap as number;
  assert.ok(Number.isInteger(cap) && cap > 0 && cap <= 512);

  const manager = new TeamRunManager();
  let runtime = new ScriptedRound("team-history-cap", "objective 1");
  manager.start(runtime, { channel: { kind: "public" }, body: "begin" });
  await settle(manager, runtime, "round 1");
  for (let index = 2; index <= cap + 1; index++) {
    manager.prompt(runtime.teamId, "a", `objective ${index}`);
    runtime = runtime.continuation!;
    await settle(manager, runtime, `round ${index}`);
  }

  const snapshot = manager.get(runtime.teamId);
  const rounds = history(snapshot);
  assert.equal(rounds.length, cap);
  assert.deepEqual(rounds.map((round) => round.roundIndex), Array.from({ length: cap }, (_, i) => i + 2));
  assert.equal(latest(snapshot).roundIndex, cap + 1);
  assert.equal(snapshot.teamId, "team-history-cap");
});

test("lifecycle evaluation: round metadata never leaks direct or restricted-group plaintext", () => {
  const manager = new TeamRunManager();
  const runtime = new ScriptedRound("team-private", "safe objective");
  manager.start(runtime, { channel: { kind: "public" }, body: "begin" });

  const directCanary = "DIRECT-PLAINTEXT-CANARY-7df08a";
  const groupCanary = "GROUP-PLAINTEXT-CANARY-45c991";
  const activities: TeamActivity[] = [
    {
      sequence: 1,
      memberId: "a",
      kind: "message",
      text: directCanary,
      body: directCanary,
      visibility: "restricted",
      channel: { kind: "direct", memberId: "b" },
      targetIds: ["b"],
    },
    {
      sequence: 2,
      memberId: "a",
      kind: "message",
      text: groupCanary,
      body: groupCanary,
      visibility: "restricted",
      channel: { kind: "group", channelId: "secret" },
      targetIds: ["b"],
    },
  ];
  for (const activity of activities) manager.observeActivity(runtime.teamId, activity);

  const serialized = JSON.stringify(manager.get(runtime.teamId));
  assert.equal(serialized.includes(directCanary), false);
  assert.equal(serialized.includes(groupCanary), false);
});

test("lifecycle evaluation: foreground manifest names stable handle and latest round outcome", () => {
  const foregroundResult = {
    ...completedResult("team-foreground", "foreground"),
    roundId: "round-3",
    roundIndex: 3,
    objective: "third objective",
  } as TeamResult;
  const manifest = renderFinalContent(foregroundResult, [
    { id: "a", name: "Agent A" },
    { id: "b", name: "Agent B" },
  ]);

  assert.match(manifest, /team(?: handle)?: team-foreground/i);
  assert.match(manifest, /round(?: id)?: round-3/i);
  assert.match(manifest, /round(?: index)?: 3/i);
  assert.match(manifest, /objective: third objective/i);
  assert.match(manifest, /completed/i);
  assert.match(manifest, /session-a/);
  assert.match(manifest, /\/sessions\/a\.jsonl/);
});
