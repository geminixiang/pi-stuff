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
const MAX_REPORT_BYTES = 16 * 1024;
const MAX_MEMBER_FIELD_BYTES = 256;
const MAX_EVENT_SUMMARY_BYTES = 1_000;

export type TeamRunStatus = "running" | "cancelling" | "settled" | "cancelled" | "failed";

export interface TeamRunEvent {
  sequence: number;
  at: number;
  type: "started" | "progress" | "activity" | "prompted" | "cancel-requested" | "settled" | "cancelled" | "failed";
  summary: string;
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
    reflection: TeamResult["members"][number]["reflection"];
  }[];
  messageCounts: { public: number; restricted: number };
  audit: { events: number; head: string };
  userInterventions: number;
}

export interface TeamRunSnapshot {
  runId: string;
  teamId: string;
  status: TeamRunStatus;
  stateChangeSeq: number;
  startedAt: number;
  updatedAt: number;
  progress?: TeamProgress;
  events: readonly TeamRunEvent[];
  result?: TeamRunResultSummary;
  error?: string;
}

export interface ManagedTeamRuntime {
  readonly teamId: string;
  run(
    initial: TeamInitialPost | readonly TeamInitialPost[],
    signal?: AbortSignal,
  ): Promise<TeamResult>;
  intervene(memberId: MemberId, message: string): void;
}

interface RunRecord {
  runtime: ManagedTeamRuntime;
  controller: AbortController;
  status: TeamRunStatus;
  sequence: number;
  startedAt: number;
  updatedAt: number;
  progress?: TeamProgress;
  events: TeamRunEvent[];
  result?: TeamRunResultSummary;
  error?: string;
  waiters: Set<() => void>;
  completion?: Promise<void>;
}

export class TeamRunManager {
  private readonly runs = new Map<string, RunRecord>();

  start(
    runtime: ManagedTeamRuntime,
    initial: TeamInitialPost | readonly TeamInitialPost[],
  ): TeamRunSnapshot {
    const runId = runtime.teamId;
    if (this.runs.has(runId)) throw new Error(`Team run already exists: ${runId}`);
    this.makeRoom();
    const now = Date.now();
    const record: RunRecord = {
      runtime,
      controller: new AbortController(),
      status: "running",
      sequence: 0,
      startedAt: now,
      updatedAt: now,
      events: [],
      waiters: new Set(),
    };
    this.runs.set(runId, record);
    this.bump(record, "started", `team ${runtime.teamId} started`);
    record.completion = runtime.run(initial, record.controller.signal).then(
      (result) => {
        record.status = "settled";
        record.result = summarizeResult(result);
        this.bump(record, "settled", `${result.settlement.kind} (${result.settlement.meaning})`);
      },
      (cause) => {
        const message = truncateUtf8(errorMessage(cause), MAX_EVENT_SUMMARY_BYTES);
        record.error = message;
        record.status = record.controller.signal.aborted ? "cancelled" : "failed";
        this.bump(record, record.status, message);
      },
    );
    return this.snapshot(record);
  }

  get(runId: string): TeamRunSnapshot {
    return this.snapshot(this.requireRun(runId));
  }

  observeProgress(runId: string, progress: TeamProgress): void {
    const record = this.requireActive(runId);
    record.progress = progress;
    this.bump(
      record,
      "progress",
      `${progress.turns} turns; ${progress.finished.length} finished; ${progress.blocked.length} blocked`,
    );
  }

  observeActivity(runId: string, activity: TeamActivity): void {
    const record = this.requireActive(runId);
    this.bump(record, "activity", `${activity.memberId} ${activity.kind}`);
  }

  prompt(runId: string, memberId: MemberId, message: string): TeamRunSnapshot {
    if (!message.trim()) throw new Error("Team prompt message must not be empty");
    if (Buffer.byteLength(message, "utf8") > 8_000)
      throw new Error("Team prompt message must not exceed 8000 bytes");
    const record = this.requireRunning(runId);
    record.runtime.intervene(memberId, message);
    this.bump(record, "prompted", `prompted member ${memberId}`);
    return this.snapshot(record);
  }

  cancel(runId: string, reason = "cancelled by requester"): TeamRunSnapshot {
    if (!reason.trim()) throw new Error("Cancellation reason must not be empty");
    if (Buffer.byteLength(reason, "utf8") > 1_000)
      throw new Error("Cancellation reason must not exceed 1000 bytes");
    const record = this.requireRunning(runId);
    record.status = "cancelling";
    this.bump(record, "cancel-requested", reason);
    record.controller.abort(new Error(reason));
    return this.snapshot(record);
  }

  cancelAll(reason = "parent session shut down"): void {
    for (const [runId, record] of this.runs)
      if (record.status === "running") this.cancel(runId, reason);
  }

  async shutdown(reason = "parent session shut down"): Promise<void> {
    this.cancelAll(reason);
    await Promise.all([...this.runs.values()].map((record) => record.completion));
  }

  async wait(
    runId: string,
    options: { afterSeq?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<TeamRunSnapshot> {
    const record = this.requireRun(runId);
    const afterSeq = options.afterSeq ?? record.sequence;
    if (!Number.isInteger(afterSeq) || afterSeq < 0)
      throw new Error("afterSeq must be a non-negative integer");
    if (afterSeq > record.sequence)
      throw new Error(`afterSeq ${afterSeq} is ahead of current stateChangeSeq ${record.sequence}`);
    if (record.sequence > afterSeq || terminal(record.status)) return this.snapshot(record);
    await this.waitForChange(record, options.timeoutMs, options.signal);
    return this.snapshot(record);
  }

  private async waitForChange(
    record: RunRecord,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
      throw new Error("timeoutMs must be greater than zero");
    if (signal?.aborted) throw signal.reason ?? new Error("Team wait aborted");
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        record.waiters.delete(onChange);
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
      };
      const onChange = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("Team wait aborted"));
      };
      record.waiters.add(onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined)
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for team run ${record.runtime.teamId}`));
        }, timeoutMs);
    });
  }

  private bump(record: RunRecord, type: TeamRunEvent["type"], summary: string): void {
    record.sequence += 1;
    record.updatedAt = Date.now();
    record.events.push({
      sequence: record.sequence,
      at: record.updatedAt,
      type,
      summary: truncateUtf8(summary, MAX_EVENT_SUMMARY_BYTES),
    });
    if (record.events.length > MAX_TEAM_RUN_EVENTS)
      record.events.splice(0, record.events.length - MAX_TEAM_RUN_EVENTS);
    record.waiters.forEach((wake) => wake());
  }

  private makeRoom(): void {
    if (this.runs.size < MAX_TEAM_RUNS) return;
    const oldestTerminal = [...this.runs.entries()]
      .filter(([, record]) => terminal(record.status))
      .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)[0];
    if (!oldestTerminal)
      throw new Error(`Too many active team runs; maximum is ${MAX_TEAM_RUNS}`);
    this.runs.delete(oldestTerminal[0]);
  }

  private requireRun(runId: string): RunRecord {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Unknown team run: ${runId}`);
    return record;
  }

  private requireRunning(runId: string): RunRecord {
    const record = this.requireRun(runId);
    if (record.status !== "running")
      throw new Error(`Team run ${runId} is ${record.status} and no longer accepts mutations`);
    return record;
  }

  private requireActive(runId: string): RunRecord {
    const record = this.requireRun(runId);
    if (terminal(record.status))
      throw new Error(`Team run ${runId} is ${record.status} and no longer active`);
    return record;
  }

  private snapshot(record: RunRecord): TeamRunSnapshot {
    return Object.freeze({
      runId: record.runtime.teamId,
      teamId: record.runtime.teamId,
      status: record.status,
      stateChangeSeq: record.sequence,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      progress: record.progress,
      events: Object.freeze(record.events.map((event) => Object.freeze({ ...event }))),
      result: record.result,
      error: record.error,
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
    report: result.report
      ? Object.freeze({
          reporterId: result.report.reporterId,
          body: truncateUtf8(result.report.body, MAX_REPORT_BYTES),
        })
      : undefined,
    reportError: truncateOptional(result.reportError, MAX_EVENT_SUMMARY_BYTES),
    members: Object.freeze(
      result.members.map((member) =>
        Object.freeze({
          id: truncateUtf8(member.id, 128),
          sessionId: truncateUtf8(member.sessionId, 128),
          sessionRef: truncateOptional(member.sessionRef, 512),
          turns: member.turns,
          state: member.state,
          summary: truncateOptional(member.summary, MAX_MEMBER_FIELD_BYTES),
          error: truncateOptional(member.error, MAX_MEMBER_FIELD_BYTES),
          blockedReason: truncateOptional(member.blockedReason, MAX_MEMBER_FIELD_BYTES),
          reflection:
            member.reflection.status === "failed"
              ? Object.freeze({
                  ...member.reflection,
                  error: truncateUtf8(member.reflection.error, MAX_MEMBER_FIELD_BYTES),
                })
              : member.reflection,
        }),
      ),
    ),
    messageCounts: Object.freeze({
      public: result.publicTranscript.length,
      restricted: result.restrictedMessages.length,
    }),
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
