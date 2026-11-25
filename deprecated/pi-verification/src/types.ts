import type { TaskRecord, TaskSpec } from "@geminixiang/pi-task-protocol";

export type CheckRequirement = "required" | "optional";
export type CheckStatus = "passed" | "failed" | "timeout" | "error";

export type VerificationCheck = {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  requirement: CheckRequirement;
  timeoutMs: number;
};

export type VerificationPlan = {
  version: 1;
  checks: VerificationCheck[];
  concurrency: number;
  freshness: "git";
  repairBudget: number;
};

export type VerificationFingerprint = {
  head: string;
  worktreeDiffSha256: string;
  cachedDiffSha256: string;
  untrackedSha256: string;
  planSha256: string;
  sha256: string;
};

export type TaskLogLocator = { taskId: string; stream: "stdout" | "stderr" };

export type CheckEvidence = {
  checkId: string;
  requirement: CheckRequirement;
  status: CheckStatus;
  command: string;
  args: string[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  stdoutSummary: string;
  stderrSummary: string;
  logs: { stdout: TaskLogLocator; stderr: TaskLogLocator };
  error?: string;
};

export type VerificationEvidence = {
  version: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  fingerprint: VerificationFingerprint;
  status: "passed" | "failed";
  checks: CheckEvidence[];
};

export type VerificationStatus = {
  plan: VerificationPlan | null;
  evidence: VerificationEvidence | null;
  state: "unconfigured" | "never-run" | "passed" | "failed" | "stale" | "inconclusive";
  currentFingerprint?: VerificationFingerprint;
  error?: string;
};

/** Public request surface implemented by @geminixiang/pi-supervisor's TaskClient. */
export interface SupervisorTaskClient {
  request<T>(
    request:
      | { method: "start"; params: TaskSpec }
      | { method: "wait"; params: { taskId: string; timeoutMs?: number } }
      | {
          method: "output";
          params: { taskId: string; stream?: "stdout" | "stderr"; offset?: number; limit?: number };
        }
      | { method: "get"; params: { taskId: string } }
      | { method: "stop"; params: { taskId: string; timeoutMs?: number } },
  ): Promise<T>;
}

export type StartedTask = Pick<TaskRecord, "id" | "state" | "exitCode" | "error">;
