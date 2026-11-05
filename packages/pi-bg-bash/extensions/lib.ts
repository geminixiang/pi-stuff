import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type JobState = "scheduled" | "running" | "exited" | "killed" | "failed";

export interface JobInfo {
  id: string;
  command: string;
  label?: string;
  cwd: string;
  logPath: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  state: JobState;
  notify: boolean;
  scheduledAt?: number;
  okCodes?: number[];
  failReason?: string;
}

export const DEFAULT_ENV: Record<string, string> = {
  NO_COLOR: "1",
  TERM: "dumb",
  CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
  CLOUDSDK_CORE_DISABLE_COLOR: "1",
  PAGER: "cat",
  GIT_PAGER: "cat",
  GH_PAGER: "cat",
};

export const BUILTIN_FAIL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "gcloud reauthentication failed", re: /Reauthentication failed/ },
  {
    name: "gcloud auth tokens expired",
    re: /There was a problem refreshing your current auth tokens/,
  },
  { name: "gcloud auth login required", re: /Please run:\s*\$ gcloud auth login/ },
  { name: "gh authentication required", re: /authentication required/i },
  { name: "gh bad credentials", re: /HTTP 401: Bad credentials/ },
];

export function buildEnv(
  base: NodeJS.ProcessEnv,
  overrides?: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...base, ...DEFAULT_ENV, ...overrides };
}

const ANSI_RE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function cleanText(text: string): string {
  return stripAnsi(text)
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r+$/, "").split("\r");
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i] !== "") return parts[i];
      return "";
    })
    .join("\n");
}

const keep = (m: string, n: number) => `${m.slice(0, n)}***`;

const REDACTIONS: { re: RegExp; fn: (m: string, ...g: string[]) => string }[] = [
  {
    re: /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g,
    fn: (_m, kind) => `-----BEGIN ${kind}PRIVATE KEY-----***-----END ${kind}PRIVATE KEY-----`,
  },
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, fn: (_m, b) => `${b} ***` },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g, fn: (m) => keep(m, 9) },
  { re: /\bsk-or-v1-[A-Za-z0-9]{16,}/g, fn: (m) => keep(m, 13) },
  {
    re: /\b(sk-(?:proj-|ant-)?)[A-Za-z0-9_-]{16,}/g,
    fn: (m, prefix) => keep(m, prefix.length + 4),
  },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, fn: (m) => keep(m, 15) },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, fn: (m) => keep(m, 8) },
  { re: /\bGOCSPX-[A-Za-z0-9_-]{10,}/g, fn: (m) => keep(m, 11) },
  { re: /\bya29\.[A-Za-z0-9_-]{10,}/g, fn: (m) => keep(m, 9) },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, fn: (m) => keep(m, 8) },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, fn: (m) => keep(m, 8) },
];

export function redact(text: string): string {
  let out = text;
  for (const { re, fn } of REDACTIONS) out = out.replace(re, fn as (m: string) => string);
  return out;
}

export function sanitize(text: string): string {
  return redact(cleanText(text));
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseAt(spec: string, now: number): number {
  const s = spec.trim();
  if (s.startsWith("+")) {
    const body = s.slice(1);
    if (!/^(\d+(?:\.\d+)?[smhd])+$/.test(body))
      throw new Error(`Invalid relative time "${spec}" (use e.g. +90s, +10m, +2h, +1h30m)`);
    let ms = 0;
    for (const m of body.matchAll(/(\d+(?:\.\d+)?)([smhd])/g)) ms += Number(m[1]) * UNIT_MS[m[2]];
    return now + ms;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Invalid time "${spec}" (use ISO-8601 or +10m / +2h)`);
  if (t < now - 60_000) throw new Error(`Time "${spec}" is in the past`);
  return Math.max(t, now);
}

export function waitUntilScript(intervalSec: number, maxWaitSec: number): string {
  return [
    `interval=${intervalSec}; max=${maxWaitSec}; start=$(date +%s); n=0`,
    `while :; do`,
    `  n=$((n+1))`,
    `  out=$(bash -c "$PI_BG_WAIT_CMD" 2>&1); rc=$?`,
    `  first=$(printf '%s\\n' "$out" | head -n 1)`,
    `  printf '%s attempt %d exit %d %s\\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$n" "$rc" "$first"`,
    `  if [ "$rc" -eq 0 ]; then echo "condition met after $n attempts"; exit 0; fi`,
    `  now=$(date +%s); left=$((start + max - now))`,
    `  if [ "$left" -le 0 ]; then echo "gave up after $n attempts ($max s)"; exit 124; fi`,
    `  if [ "$left" -lt "$interval" ]; then sleep "$left"; else sleep "$interval"; fi`,
    `done`,
  ].join("\n");
}

export function contextSnippet(
  lines: string[],
  matches: number[],
  after: number,
  maxLines: number,
): string {
  const picked = new Set<number>();
  for (const i of matches)
    for (let k = i; k <= Math.min(lines.length - 1, i + after); k++) picked.add(k);
  const idx = [...picked].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -2;
  for (const i of idx) {
    if (out.length >= maxLines) {
      out.push(`… ${idx.length - maxLines} more lines`);
      break;
    }
    if (prev >= 0 && i !== prev + 1) out.push("…");
    out.push(`${matches.includes(i) ? ">" : " "} ${lines[i]}`);
    prev = i;
  }
  return out.join("\n");
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

export function tailText(
  text: string,
  maxLines: number,
  maxBytes: number,
): { text: string; truncated: boolean } {
  let truncated = false;
  let out = text;
  if (Buffer.byteLength(out) > maxBytes) {
    out = Buffer.from(out).subarray(-maxBytes).toString("utf8");
    const nl = out.indexOf("\n");
    if (nl >= 0) out = out.slice(nl + 1);
    truncated = true;
  }
  const lines = out.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > maxLines) {
    truncated = true;
    return { text: lines.slice(-maxLines).join("\n"), truncated };
  }
  return { text: lines.join("\n"), truncated };
}

export function readTail(
  path: string,
  maxLines: number,
  maxBytes: number,
): { text: string; truncated: boolean; size: number } {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, size - len);
    const t = tailText(cleanText(buf.toString("utf8")), maxLines, maxBytes);
    return { ...t, truncated: t.truncated || size > len, size };
  } catch {
    return { text: "", truncated: false, size: 0 };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function isOk(job: JobInfo): boolean {
  return (
    job.state === "exited" &&
    typeof job.exitCode === "number" &&
    (job.okCodes ?? [0]).includes(job.exitCode)
  );
}

export function describeJob(job: JobInfo, now: number): string {
  const ran = formatDuration((job.endedAt ?? now) - job.startedAt);
  const name = job.label ? `${job.label} — ` : "";
  const cmd = job.command.length > 80 ? `${job.command.slice(0, 77)}...` : job.command;
  let status: string;
  if (job.state === "scheduled")
    status = `scheduled ${new Date(job.scheduledAt ?? job.startedAt).toISOString()} (in ${formatDuration((job.scheduledAt ?? now) - now)})`;
  else if (job.state === "running") status = `running ${ran}`;
  else if (job.state === "killed")
    status = job.failReason
      ? `stopped after ${ran}: ${job.failReason}`
      : job.signal && job.signal.startsWith("SIG")
        ? `killed by ${job.signal} after ${ran}`
        : `killed after ${ran}`;
  else if (job.state === "failed")
    status = job.failReason ? `failed: ${job.failReason}` : `failed to start`;
  else {
    const code = job.exitCode ?? job.signal;
    const ok = isOk(job);
    const tag = ok && job.exitCode !== 0 ? " (ok)" : !ok && job.okCodes ? " (failure)" : "";
    status = `exit ${code}${tag} after ${ran}`;
  }
  return `${job.id} [${status}] ${name}${cmd}`;
}

function shortLabel(job: JobInfo, max: number): string {
  const name = (job.label || job.command).replace(/\s+/g, " ").trim();
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export function statusText(running: JobInfo[], now: number, scheduled = 0): string {
  const age = (j: JobInfo) => formatDuration(now - j.startedAt);
  const sched = scheduled ? ` · ${scheduled} scheduled` : "";
  if (!running.length) return `bg: ${scheduled} scheduled`;
  if (running.length === 1) {
    const j = running[0];
    return `bg: ${j.id} ${shortLabel(j, 40)} · ${age(j)}${sched}`;
  }
  const items = running.map((j) => `${j.id} ${shortLabel(j, 18)} ${age(j)}`);
  return `bg: ${running.length} running: ${items.join(" | ")}${sched}`;
}

export function collapseMessage(content: string, tailLines: number): string {
  const lines = content.split("\n");
  const header = lines[0] ?? "";
  const rest = lines
    .slice(1)
    .filter((l) => l.trim() !== "" && !/^log: |^\(last \d+ lines\)$/.test(l));
  if (!rest.length) return header;
  const shown = rest.slice(-tailLines);
  const more = rest.length - shown.length;
  return [
    header,
    ...(more > 0 ? [`… ${more} more line${more === 1 ? "" : "s"}`] : []),
    ...shown,
  ].join("\n");
}
