import { randomUUID } from "node:crypto";
import type { TaskRecord } from "@geminixiang/pi-task-protocol";
import { fingerprint, resolveProjectCwd } from "./fingerprint.js";
import type {
  CheckEvidence,
  SupervisorTaskClient,
  VerificationEvidence,
  VerificationPlan,
} from "./types.js";

const SUMMARY_BYTES = 16 * 1024;
const SECRET_PATTERNS = [
  /\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}\b/g,
  /\b(?:api[_-]?key|token|authorization|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[^\s]+/gi,
];

export function redactAndBound(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  const buffer = Buffer.from(redacted);
  if (buffer.length <= SUMMARY_BYTES) return redacted;
  return `[truncated ${buffer.length - SUMMARY_BYTES} bytes]\n${buffer.subarray(buffer.length - SUMMARY_BYTES).toString("utf8")}`;
}

async function readOutput(
  client: SupervisorTaskClient,
  taskId: string,
  stream: "stdout" | "stderr",
): Promise<string> {
  const result = await client.request<{ text: string }>({
    method: "output",
    params: { taskId, stream, offset: 0, limit: 1024 * 1024 },
  });
  return redactAndBound(result.text);
}

async function runCheck(
  projectRoot: string,
  check: VerificationPlan["checks"][number],
  client: SupervisorTaskClient,
  signal?: AbortSignal,
): Promise<CheckEvidence> {
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  let taskId = "not-started";
  let record: TaskRecord | undefined;
  let timedOut = false;
  let error: string | undefined;
  const abort = () => {
    if (taskId !== "not-started")
      void client.request({ method: "stop", params: { taskId } }).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const cwd = await resolveProjectCwd(projectRoot, check.cwd);
    record = await client.request<TaskRecord>({
      method: "start",
      params: { command: check.command, args: check.args, cwd, runTimeoutMs: check.timeoutMs },
    });
    taskId = record.id;
    if (signal?.aborted) {
      await client.request({ method: "stop", params: { taskId } });
      throw new Error("aborted");
    }
    try {
      await client.request<TaskRecord>({
        method: "wait",
        params: { taskId, timeoutMs: check.timeoutMs + 2_000 },
      });
    } catch (waitError) {
      timedOut = /timed out/i.test(
        waitError instanceof Error ? waitError.message : String(waitError),
      );
      if (timedOut) await client.request({ method: "stop", params: { taskId } });
      else throw waitError;
    }
    record = await client.request<TaskRecord>({ method: "get", params: { taskId } });
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const [stdoutSummary, stderrSummary] =
    taskId === "not-started"
      ? ["", ""]
      : await Promise.all([
          readOutput(client, taskId, "stdout").catch(() => "[output unavailable]"),
          readOutput(client, taskId, "stderr").catch(() => "[output unavailable]"),
        ]);
  const end = Date.now();
  const exitCode = record?.exitCode ?? null;
  const status =
    timedOut || record?.terminationReason === "run_timed_out"
      ? "timeout"
      : error || record?.error
        ? "error"
        : record?.state === "succeeded" || exitCode === 0
          ? "passed"
          : "failed";
  return {
    checkId: check.id,
    requirement: check.requirement,
    status,
    command: check.command,
    args: check.args,
    startedAt,
    completedAt: new Date(end).toISOString(),
    durationMs: end - start,
    exitCode,
    stdoutSummary,
    stderrSummary,
    logs: { stdout: { taskId, stream: "stdout" }, stderr: { taskId, stream: "stderr" } },
    ...(error || record?.error ? { error: error ?? record?.error } : {}),
  };
}

export async function runVerification(
  projectRoot: string,
  plan: VerificationPlan,
  client: SupervisorTaskClient,
  signal?: AbortSignal,
): Promise<VerificationEvidence> {
  const startedAt = new Date().toISOString();
  const fp = await fingerprint(projectRoot, plan);
  const evidence: CheckEvidence[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (!signal?.aborted) {
      const index = cursor++;
      const check = plan.checks[index];
      if (!check) return;
      evidence[index] = await runCheck(projectRoot, check, client, signal);
    }
  }
  await Promise.all(Array.from({ length: Math.min(plan.concurrency, plan.checks.length) }, worker));
  const checks = evidence.filter((item): item is CheckEvidence => item !== undefined);
  const status =
    checks.length !== plan.checks.length ||
    checks.some((check) => check.requirement === "required" && check.status !== "passed")
      ? "failed"
      : "passed";
  return {
    version: 1,
    runId: randomUUID(),
    startedAt,
    completedAt: new Date().toISOString(),
    fingerprint: fp,
    status,
    checks,
  };
}
