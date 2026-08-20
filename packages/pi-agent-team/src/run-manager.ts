import { randomUUID } from "node:crypto";
import type {
  MemberId,
  TeamActivity,
  TeamProgress,
  TeamResult,
  TeamSettlement,
} from "./domain.js";
import type { TeamInitialPost } from "./runtime.js";

export const MAX_TEAM_RUN_EVENTS = 512;
export const MAX_TEAM_RUNS = 64;
/** Completed/cancelled round summaries retained per stable team handle. */
export const MAX_TEAM_ROUND_SUMMARIES = 16;
const MAX_REPORT_BYTES = 16 * 1024;
const MAX_MEMBER_FIELD_BYTES = 256;
const MAX_EVENT_SUMMARY_BYTES = 1_000;
const MAX_OBJECTIVE_BYTES = 8_000;

export type TeamRunStatus = "running" | "cancelling" | "settled" | "cancelled" | "failed";
export type TeamLifecycleStatus = "available" | "running" | "closing" | "closed";

export interface TeamRunEvent {
  sequence: number;
  at: number;
  type: "started" | "progress" | "activity" | "prompted" | "cancel-requested" | "settled" | "cancelled" | "failed";
  summary: string;
  roundId: string;
  roundIndex: number;
}

export interface TeamRunResultSummary {
  settlement: TeamSettlement;
  objectiveVerification: "unverified";
  report?: { reporterId: MemberId; body: string };
  reportError?: string;
  members: readonly {
    id: MemberId;
    sessionId: string;
    sessionRef?: string;
    turns: number;
    state: TeamResult["members"][number]["state"];
    summary?: string;
    error?: string;
    blockedReason?: string;
  }[];
  messageCounts: { public: number; restricted: number };
  audit: { events: number; head: string };
  userInterventions: number;
}

export interface TeamRoundSummary {
  teamId: string;
  roundId: string;
  roundIndex: number;
  objective: string;
  status: TeamRunStatus;
  startedAt: number;
  updatedAt: number;
  cancellation?: { requested: true; requestedAt: number; reason: string };
  result?: TeamRunResultSummary;
  error?: string;
}

/**
 * Snapshot of a stable retained team. `runId` remains as a compatibility
 * alias for `teamId`; `roundId` identifies only the current/latest round.
 */
export interface TeamRunSnapshot {
  runId: string;
  teamId: string;
  lifecycle: TeamLifecycleStatus;
  /** Explicit team-level lifecycle alias for operator-facing consumers. */
  teamStatus: TeamLifecycleStatus;
  /** Explicit current/latest RoundRun; flat fields below remain compatibility aliases. */
  latestRound: TeamRoundSummary;
  currentRound: TeamRoundSummary;
  members: TeamRunResultSummary["members"];
  roundId: string;
  roundIndex: number;
  objective: string;
  status: TeamRunStatus;
  stateChangeSeq: number;
  startedAt: number;
  updatedAt: number;
  cancellation?: { requested: true; requestedAt: number; reason: string };
  progress?: TeamProgress;
  events: readonly TeamRunEvent[];
  result?: TeamRunResultSummary;
  error?: string;
  rounds: readonly TeamRoundSummary[];
}

export interface ManagedTeamRuntime {
  readonly teamId: string;
  readonly objective: string;
  run(initial: TeamInitialPost | readonly TeamInitialPost[], signal?: AbortSignal): Promise<TeamResult>;
  intervene(memberId: MemberId, message: string): void;
  hasMember(memberId: MemberId): boolean;
  next(
    objective: string,
    options?: {
      waitForIntervention?: boolean;
      reporterId?: MemberId;
      reportPrompt?: string;
      onActivity?: (activity: TeamActivity) => void;
      onProgress?: (progress: TeamProgress) => void;
    },
    requesterInitiated?: boolean,
  ): ManagedTeamRuntime;
  close?(): Promise<void> | void;
}

interface TeamRecord {
  teamId: string;
  runtime: ManagedTeamRuntime;
  controller: AbortController;
  status: TeamRunStatus;
  roundId: string;
  roundIndex: number;
  objective: string;
  generation: number;
  sequence: number;
  startedAt: number;
  updatedAt: number;
  cancellation?: { requested: true; requestedAt: number; reason: string };
  progress?: TeamProgress;
  events: TeamRunEvent[];
  result?: TeamRunResultSummary;
  error?: string;
  rounds: TeamRoundSummary[];
  waiters: Set<() => void>;
  completion?: Promise<void>;
}

export class TeamRunManager {
  private readonly teams = new Map<string, TeamRecord>();

  start(
    runtime: ManagedTeamRuntime,
    initial: TeamInitialPost | readonly TeamInitialPost[],
    options: { roundId?: string } = {},
  ): TeamRunSnapshot {
    const teamId = runtime.teamId;
    if (this.teams.has(teamId)) throw new Error(`Team run already exists: ${teamId}`);
    this.makeRoom();
    const record = this.newRecord(runtime, "running", options.roundId);
    this.teams.set(teamId, record);
    this.bump(record, "started", `team ${teamId} round 1 started`);
    this.launch(record, initial);
    return this.snapshot(record);
  }

  /** Retain a synchronously completed first round for later continuation. */
  retain(runtime: ManagedTeamRuntime, result: TeamResult): TeamRunSnapshot {
    const teamId = runtime.teamId;
    if (this.teams.has(teamId)) throw new Error(`Team run already exists: ${teamId}`);
    this.makeRoom();
    const record = this.newRecord(runtime, "settled");
    record.result = summarizeResult(result);
    record.completion = Promise.resolve();
    this.teams.set(teamId, record);
    this.bump(record, "settled", `${result.settlement.kind} (${result.settlement.meaning})`);
    this.archiveRound(record);
    return this.snapshot(record);
  }

  get(runId: string): TeamRunSnapshot {
    return this.snapshot(this.requireTeam(runId));
  }

  observeProgress(runId: string, progress: TeamProgress, roundId?: string): void {
    const record = this.requireTeam(runId);
    if (roundId !== undefined && record.roundId !== roundId) return;
    if (record.status !== "running") return;
    record.progress = progress;
    this.bump(record, "progress", `${progress.turns} turns; ${progress.finished.length} finished; ${progress.blocked.length} blocked`);
  }

  observeActivity(runId: string, activity: TeamActivity, roundId?: string): void {
    const record = this.requireTeam(runId);
    if (roundId !== undefined && record.roundId !== roundId) return;
    if (record.status !== "running") return;
    this.bump(record, "activity", `${activity.memberId} ${activity.kind}`);
  }

  prompt(runId: string, memberId: MemberId, message: string): TeamRunSnapshot {
    if (!message.trim()) throw new Error("Prompt message must not be empty");
    if (Buffer.byteLength(message, "utf8") > MAX_OBJECTIVE_BYTES)
      throw new Error(`Prompt message exceeds ${MAX_OBJECTIVE_BYTES} UTF-8 bytes`);
    const record = this.requireTeam(runId);
    if (record.status === "running") {
      record.runtime.intervene(memberId, message);
      this.bump(record, "prompted", `prompted member ${memberId}`);
      return this.snapshot(record);
    }
    if (record.status === "cancelling")
      throw new Error(`Team run ${runId} is cancelling and no longer accepts mutations`);
    if (!record.runtime.hasMember(memberId)) throw new Error(`Unknown member: ${memberId}`);

    const nextRoundId = randomUUID();
    const next = record.runtime.next(
      message,
      {
        waitForIntervention: false,
        reporterId: memberId,
        reportPrompt: "Reply directly to the requester guidance that started this continuation round. Return a complete, standalone response.",
        onActivity: (activity) => this.observeActivity(record.teamId, activity, nextRoundId),
        onProgress: (progress) => this.observeProgress(record.teamId, progress, nextRoundId),
      },
      true,
    );
    record.runtime = next;
    record.controller = new AbortController();
    record.status = "running";
    record.roundId = nextRoundId;
    record.roundIndex += 1;
    record.objective = message;
    record.generation += 1;
    record.startedAt = Date.now();
    record.updatedAt = record.startedAt;
    record.cancellation = undefined;
    record.progress = undefined;
    record.result = undefined;
    record.error = undefined;
    this.bump(record, "started", `continued team by prompting member ${memberId}`);
    this.launch(record, { channel: { kind: "direct", memberId }, body: message });
    return this.snapshot(record);
  }

  cancel(runId: string, reason = "cancelled by requester", expectedRoundId?: string): TeamRunSnapshot {
    const record = this.requireTeam(runId);
    if (expectedRoundId !== undefined && expectedRoundId !== record.roundId) return this.snapshot(record);
    if (!reason.trim()) throw new Error("Cancellation reason must not be empty");
    if (record.status === "cancelling" || record.status === "cancelled") return this.snapshot(record);
    if (record.status !== "running")
      throw new Error(`Team run ${runId} is ${record.status} and no longer active`);
    record.status = "cancelling";
    record.cancellation = Object.freeze({ requested: true, requestedAt: Date.now(), reason: truncateUtf8(reason, MAX_EVENT_SUMMARY_BYTES) });
    this.bump(record, "cancel-requested", record.cancellation.reason);
    record.controller.abort(new Error(record.cancellation.reason));
    queueMicrotask(() => this.finalizeCancellation(record, record.generation));
    return this.snapshot(record);
  }

  async wait(runId: string, options: { afterSeq?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TeamRunSnapshot> {
    const record = this.requireTeam(runId);
    const afterSeq = options.afterSeq ?? record.sequence;
    if (!Number.isInteger(afterSeq) || afterSeq < 0)
      throw new Error("afterSeq must be a non-negative integer");
    if (afterSeq > record.sequence)
      throw new Error(`afterSeq ${afterSeq} is ahead of current stateChangeSeq ${record.sequence}`);
    if (record.sequence > afterSeq || terminal(record.status)) return this.snapshot(record);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        record.waiters.delete(wake);
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(options.signal?.reason ?? new Error("Wait aborted")); };
      record.waiters.add(wake);
      if (options.timeoutMs !== undefined)
        timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for team run ${runId}`)); }, options.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      else if (record.sequence > afterSeq) wake();
    });
    return this.snapshot(record);
  }

  async shutdown(reason = "parent session ended"): Promise<void> {
    const completions: Promise<void>[] = [];
    for (const record of this.teams.values()) {
      if (record.status === "running") this.cancel(record.teamId, reason);
      if (record.completion) completions.push(record.completion);
    }
    await Promise.allSettled(completions);
    await Promise.allSettled([...this.teams.values()].map((record) => record.runtime.close?.()));
    this.teams.clear();
  }

  private newRecord(runtime: ManagedTeamRuntime, status: TeamRunStatus, roundId: string = randomUUID()): TeamRecord {
    const now = Date.now();
    return {
      teamId: runtime.teamId, runtime, controller: new AbortController(), status,
      roundId, roundIndex: 1, objective: runtime.objective,
      generation: 1, sequence: 0, startedAt: now, updatedAt: now,
      events: [], rounds: [], waiters: new Set(),
    };
  }

  private launch(record: TeamRecord, initial: TeamInitialPost | readonly TeamInitialPost[]): void {
    const generation = record.generation;
    const runtime = record.runtime;
    const controller = record.controller;
    record.completion = runtime.run(initial, controller.signal).then(
      (result) => {
        if (record.generation !== generation || record.runtime !== runtime) return;
        if (controller.signal.aborted) {
          this.finalizeCancellation(record, generation);
          return;
        }
        record.status = "settled";
        record.result = summarizeResult(result);
        this.bump(record, "settled", `${result.settlement.kind} (${result.settlement.meaning})`);
        this.archiveRound(record);
      },
      (cause) => {
        if (record.generation !== generation || record.runtime !== runtime) return;
        if (controller.signal.aborted) {
          this.finalizeCancellation(record, generation, cause);
          return;
        }
        const message = truncateUtf8(errorMessage(cause), MAX_EVENT_SUMMARY_BYTES);
        record.error = message;
        record.status = "failed";
        this.bump(record, "failed", message);
        this.archiveRound(record);
      },
    );
  }

  private finalizeCancellation(record: TeamRecord, generation: number, cause?: unknown): void {
    if (record.generation !== generation || record.status !== "cancelling") return;
    const cancellationCause = cause ?? record.controller.signal.reason ?? new Error("cancelled");
    record.error = truncateUtf8(errorMessage(cancellationCause), MAX_EVENT_SUMMARY_BYTES);
    record.status = "cancelled";
    this.bump(record, "cancelled", record.error);
    this.archiveRound(record);
  }

  private archiveRound(record: TeamRecord): void {
    const summary: TeamRoundSummary = Object.freeze({
      teamId: record.teamId,
      roundId: record.roundId,
      roundIndex: record.roundIndex,
      objective: truncateUtf8(record.objective, MAX_OBJECTIVE_BYTES),
      status: record.status,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      cancellation: record.cancellation,
      result: record.result,
      error: record.error,
    });
    record.rounds.push(summary);
    if (record.rounds.length > MAX_TEAM_ROUND_SUMMARIES)
      record.rounds.splice(0, record.rounds.length - MAX_TEAM_ROUND_SUMMARIES);
  }

  private bump(record: TeamRecord, type: TeamRunEvent["type"], summary: string): void {
    record.sequence += 1;
    record.updatedAt = Date.now();
    record.events.push({ sequence: record.sequence, at: record.updatedAt, type, summary: truncateUtf8(summary, MAX_EVENT_SUMMARY_BYTES), roundId: record.roundId, roundIndex: record.roundIndex });
    if (record.events.length > MAX_TEAM_RUN_EVENTS)
      record.events.splice(0, record.events.length - MAX_TEAM_RUN_EVENTS);
    record.waiters.forEach((wake) => wake());
  }

  private makeRoom(): void {
    if (this.teams.size < MAX_TEAM_RUNS) return;
    const oldestAvailable = [...this.teams.entries()]
      .filter(([, record]) => terminal(record.status))
      .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)[0];
    if (!oldestAvailable) throw new Error(`Too many active team runs; maximum is ${MAX_TEAM_RUNS}`);
    this.teams.delete(oldestAvailable[0]);
    void Promise.resolve(oldestAvailable[1].runtime.close?.()).catch(() => {});
  }

  private requireTeam(runId: string): TeamRecord {
    const record = this.teams.get(runId);
    if (!record) throw new Error(`Unknown team run: ${runId}`);
    return record;
  }


  private snapshot(record: TeamRecord): TeamRunSnapshot {
    const lifecycle: TeamLifecycleStatus = record.status === "running" ? "running" : record.status === "cancelling" ? "closing" : "available";
    const latestRound: TeamRoundSummary = Object.freeze({
      teamId: record.teamId,
      roundId: record.roundId,
      roundIndex: record.roundIndex,
      objective: truncateUtf8(record.objective, MAX_OBJECTIVE_BYTES),
      status: record.status,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      cancellation: record.cancellation,
      result: record.result,
      error: record.error,
    });
    const retainedMembers = record.result?.members ?? [...record.rounds].reverse().find((round) => round.result)?.result?.members ?? Object.freeze([]);
    return Object.freeze({
      runId: record.teamId,
      teamId: record.teamId,
      lifecycle,
      teamStatus: lifecycle,
      latestRound,
      currentRound: latestRound,
      members: retainedMembers,
      roundId: record.roundId,
      roundIndex: record.roundIndex,
      objective: truncateUtf8(record.objective, MAX_OBJECTIVE_BYTES),
      status: record.status,
      stateChangeSeq: record.sequence,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      cancellation: record.cancellation,
      progress: record.progress,
      events: Object.freeze(record.events.map((event) => Object.freeze({ ...event }))),
      result: record.result,
      error: record.error,
      rounds: Object.freeze([...record.rounds]),
    });
  }
}

function terminal(status: TeamRunStatus): boolean {
  return status === "settled" || status === "cancelled" || status === "failed";
}

function summarizeResult(result: TeamResult): TeamRunResultSummary {
  return Object.freeze({
    settlement: result.settlement,
    objectiveVerification: result.objectiveVerification,
    report: result.report ? Object.freeze({ reporterId: result.report.reporterId, body: truncateUtf8(result.report.body, MAX_REPORT_BYTES) }) : undefined,
    reportError: truncateOptional(result.reportError, MAX_EVENT_SUMMARY_BYTES),
    members: Object.freeze(result.members.map((member) => Object.freeze({
      id: truncateUtf8(member.id, 128), sessionId: truncateUtf8(member.sessionId, 128),
      sessionRef: truncateOptional(member.sessionRef, 512), turns: member.turns, state: member.state,
      summary: truncateOptional(member.summary, MAX_MEMBER_FIELD_BYTES),
      error: truncateOptional(member.error, MAX_MEMBER_FIELD_BYTES),
      blockedReason: truncateOptional(member.blockedReason, MAX_MEMBER_FIELD_BYTES),
    }))),
    messageCounts: Object.freeze({ public: result.publicTranscript.length, restricted: result.restrictedMessages.length }),
    audit: Object.freeze({ events: result.events.length, head: result.auditHead }),
    userInterventions: result.userInterventions,
  });
}

function truncateOptional(value: string | undefined, maxBytes: number): string | undefined {
  return value === undefined ? undefined : truncateUtf8(value, maxBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n\n[truncated in background snapshot]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") + suffixBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low) + suffix;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
