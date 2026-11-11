import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  BUILTIN_FAIL_PATTERNS,
  buildEnv,
  cleanText,
  collapseMessage,
  contextSnippet,
  describeJob,
  formatDuration,
  isOk,
  type JobInfo,
  parseAt,
  readTail,
  redact,
  sanitize,
  statusText,
  waitUntilScript,
} from "./lib.ts";

const STATUS_KEY = "bg-bash";
const MESSAGE_TYPE = "bg-bash";
const KILL_GRACE_MS = 5000;
const STATUS_REFRESH_MS = 15_000;
const COLLAPSED_LINES = 3;
const NOTIFY_LINES = 30;
const NOTIFY_BYTES = 8 * 1024;
const OUTPUT_DEFAULT_LINES = 60;
const OUTPUT_MAX_BYTES = 40 * 1024;
const RECENT_MS = 60 * 60_000;
const RETAIN_MS = 24 * 60 * 60_000;
const READ_CHUNK = 1 << 20;
const CONTEXT_AFTER = 3;
const BATCH_MAX_LINES = 40;
const BATCH_BUFFER_LINES = 400;
const PREFLIGHT_TIMEOUT_MS = 120_000;
const PREFLIGHT_MAX_BYTES = 16 * 1024;
const IDLE_LINES = 10;
const YIELD_MAX_MS = 60_000;
const YIELD_LINES = 200;
const YIELD_PARTIAL_LINES = 10;
const YIELD_POLL_MS = 25;

export interface BgBashOptions {
  stateDir?: string;
  tickMs?: number;
  batchMs?: number;
  minGapMs?: number;
  maxNotifyPerHour?: number;
}

interface Persisted extends JobInfo {
  owner: number;
  /** Session id of the owning pi session; several sessions (e.g. subagents) can share one pid. */
  session?: string;
  env?: Record<string, string>;
  timeoutSec?: number;
  timeoutAt?: number;
  notifyOn?: string;
  idleWarnSec?: number;
  failOn?: string;
  builtinFail: boolean;
  preflight?: string;
  waitUntil?: { interval: number; maxWait: number };
  killRequested?: boolean;
  notified?: boolean;
  offset?: number;
}

interface Batch {
  lines: string[];
  matches: number[];
  firstAt: number;
  startOffset: number;
  extra: number;
}

interface Runtime {
  child?: ChildProcess;
  killTimer?: ReturnType<typeof setTimeout>;
  readOffset: number;
  doneOffset: number;
  partial: string;
  lastOutputAt: number;
  idleWarned: boolean;
  batch?: Batch;
  sentAt: number[];
  suppressed: number;
  starting?: boolean;
  notifyRe?: RegExp;
  failRe?: RegExp;
}

interface Registry {
  seq: number;
  jobs: Persisted[];
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function compile(src: string | undefined): RegExp | undefined {
  if (!src) return undefined;
  return new RegExp(src);
}

function runCapture(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawn("bash", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ code: null, output: String((e as Error).message) });
      return;
    }
    const add = (b: Buffer) => {
      if (out.length < PREFLIGHT_MAX_BYTES) out += b.toString("utf8");
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), PREFLIGHT_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ code: null, output: out + String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, output: out });
    });
  });
}

export function createBgBash(options: BgBashOptions = {}) {
  return function (pi: ExtensionAPI) {
    const stateDir =
      options.stateDir ?? process.env.PI_BG_BASH_DIR ?? join(homedir(), ".pi", "bg-bash");
    const registryPath = join(stateDir, "jobs.json");
    const logDir = join(stateDir, "logs");
    const tickMs = options.tickMs ?? 500;
    const batchMs = options.batchMs ?? 5000;
    const minGapMs = options.minGapMs ?? 30_000;
    const maxPerHour = options.maxNotifyPerHour ?? 20;
    const owner = process.pid;
    let session: string | undefined;

    function sessionOf(ctx: ExtensionContext | undefined): string | undefined {
      try {
        return ctx?.sessionManager?.getSessionId?.() || undefined;
      } catch {
        return undefined;
      }
    }

    const jobs = new Map<string, Persisted>();
    const rt = new Map<string, Runtime>();
    let lastCtx: ExtensionContext | undefined;
    let disposed = false;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let statusTicker: ReturnType<typeof setInterval> | undefined;

    const running = () => [...jobs.values()].filter((j) => j.state === "running");
    const scheduled = () => [...jobs.values()].filter((j) => j.state === "scheduled");
    const active = () =>
      [...jobs.values()].filter((j) => j.state === "running" || j.state === "scheduled");

    function readRegistry(): Registry {
      try {
        const data = JSON.parse(readFileSync(registryPath, "utf8"));
        return { seq: Number(data.seq) || 0, jobs: Array.isArray(data.jobs) ? data.jobs : [] };
      } catch {
        return { seq: 0, jobs: [] };
      }
    }

    function writeRegistry(reg: Registry) {
      mkdirSync(stateDir, { recursive: true });
      const tmp = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(reg, null, 1), { mode: 0o600 });
      renameSync(tmp, registryPath);
    }

    function snapshot(job: Persisted): Persisted {
      const r = rt.get(job.id);
      if (!r) return job;
      return { ...job, offset: r.batch ? r.batch.startOffset : r.doneOffset };
    }

    function save() {
      if (disposed) return;
      try {
        const reg = readRegistry();
        const others = reg.jobs.filter((j) => !jobs.has(j.id));
        writeRegistry({ seq: reg.seq, jobs: [...others, ...[...jobs.values()].map(snapshot)] });
      } catch {}
    }

    function nextId(): string {
      const reg = readRegistry();
      let seq = reg.seq;
      for (const j of reg.jobs) {
        const n = Number(/^bg(\d+)$/.exec(j.id)?.[1]);
        if (n > seq) seq = n;
      }
      for (const id of jobs.keys()) {
        const n = Number(/^bg(\d+)$/.exec(id)?.[1]);
        if (n > seq) seq = n;
      }
      seq += 1;
      try {
        writeRegistry({ seq, jobs: reg.jobs });
      } catch {}
      return `bg${seq}`;
    }

    function refreshStatus() {
      if (disposed) return;
      const run = running();
      const sched = scheduled().length;
      const any = run.length + sched > 0;
      if (any && !statusTicker) {
        statusTicker = setInterval(refreshStatus, STATUS_REFRESH_MS);
        statusTicker.unref?.();
      } else if (!any && statusTicker) {
        clearInterval(statusTicker);
        statusTicker = undefined;
      }
      try {
        lastCtx?.ui.setStatus(
          STATUS_KEY,
          any ? redact(statusText(run, Date.now(), sched)) : undefined,
        );
      } catch {}
    }

    function ensureTicker() {
      if (ticker || disposed) return;
      ticker = setInterval(tick, tickMs);
      ticker.unref?.();
    }

    function send(content: string, details: Record<string, unknown>) {
      if (disposed) return;
      const busy = lastCtx ? !lastCtx.isIdle() : false;
      try {
        pi.sendMessage(
          { customType: MESSAGE_TYPE, content: redact(content), display: true, details },
          busy ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true },
        );
      } catch {}
    }

    function signalGroup(job: Persisted, sig: NodeJS.Signals) {
      if (!job.pid) return;
      try {
        process.kill(-job.pid, sig);
      } catch {
        try {
          process.kill(job.pid, sig);
        } catch {}
      }
    }

    function kill(job: Persisted, reason?: string) {
      if (job.state === "scheduled") {
        job.state = "killed";
        job.endedAt = Date.now();
        job.notified = true;
        save();
        refreshStatus();
        return true;
      }
      if (job.state !== "running") return false;
      if (reason && !job.failReason) job.failReason = reason;
      job.killRequested = true;
      signalGroup(job, "SIGTERM");
      const r = rt.get(job.id);
      if (r && !r.killTimer) {
        r.killTimer = setTimeout(() => signalGroup(job, "SIGKILL"), KILL_GRACE_MS);
        r.killTimer.unref?.();
      }
      save();
      return true;
    }

    function runtimeFor(job: Persisted): Runtime {
      let r = rt.get(job.id);
      if (!r) {
        let mtime = Date.now();
        try {
          mtime = statSync(job.logPath).mtimeMs;
        } catch {}
        r = {
          readOffset: job.offset ?? 0,
          doneOffset: job.offset ?? 0,
          partial: "",
          lastOutputAt: Math.max(mtime, job.startedAt),
          idleWarned: false,
          sentAt: [],
          suppressed: 0,
        };
        try {
          r.notifyRe = compile(job.notifyOn);
        } catch {}
        try {
          r.failRe = compile(job.failOn);
        } catch {}
        rt.set(job.id, r);
      }
      return r;
    }

    function handleLine(job: Persisted, r: Runtime, raw: string, endOffset: number) {
      const line = cleanText(raw);
      if (job.state === "running" && !job.killRequested) {
        const builtin = job.builtinFail
          ? BUILTIN_FAIL_PATTERNS.find((p) => p.re.test(line))
          : undefined;
        const custom = !builtin && r.failRe?.test(line);
        if (builtin || custom) {
          kill(
            job,
            `matched fail pattern${builtin ? ` (${builtin.name})` : ` /${job.failOn}/`}: ${line.trim().slice(0, 200)}`,
          );
        }
      }
      const matched = !!r.notifyRe && r.notifyRe.test(line);
      if (matched && !r.batch)
        r.batch = {
          lines: [],
          matches: [],
          firstAt: Date.now(),
          startOffset: endOffset - Buffer.byteLength(raw) - 1,
          extra: 0,
        };
      if (r.batch) {
        if (r.batch.lines.length < BATCH_BUFFER_LINES) {
          if (matched) r.batch.matches.push(r.batch.lines.length);
          r.batch.lines.push(line);
        } else if (matched) r.batch.extra++;
      }
    }

    function readNew(job: Persisted, r: Runtime) {
      let fd: number | undefined;
      try {
        fd = openSync(job.logPath, "r");
        const size = fstatSync(fd).size;
        if (size < r.readOffset) {
          r.readOffset = 0;
          r.doneOffset = 0;
        }
        while (r.readOffset < size) {
          const len = Math.min(READ_CHUNK, size - r.readOffset);
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, r.readOffset);
          r.readOffset += len;
          r.lastOutputAt = Date.now();
          r.idleWarned = false;
          const text = r.partial + buf.toString("utf8");
          const parts = text.split("\n");
          r.partial = parts.pop() ?? "";
          let pos = r.readOffset - Buffer.byteLength(text);
          for (const p of parts) {
            pos += Buffer.byteLength(p) + 1;
            handleLine(job, r, p, pos);
            r.doneOffset = pos;
          }
        }
      } catch {
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }

    function batchText(r: Runtime): string {
      const b = r.batch!;
      const more = b.extra ? `\n(+${b.extra} more matching lines)` : "";
      return contextSnippet(b.lines, b.matches, CONTEXT_AFTER, BATCH_MAX_LINES) + more;
    }

    function maybeFlush(job: Persisted, r: Runtime, now: number) {
      const b = r.batch;
      if (!b || now - b.firstAt < batchMs) return;
      r.sentAt = r.sentAt.filter((t) => now - t < 3_600_000);
      const last = r.sentAt[r.sentAt.length - 1] ?? 0;
      if (now - last < minGapMs) return;
      const count = b.matches.length + b.extra;
      if (r.sentAt.length >= maxPerHour) {
        r.suppressed += count;
        r.batch = undefined;
        return;
      }
      r.sentAt.push(now);
      const text = batchText(r);
      r.batch = undefined;
      if (!job.notify) return;
      const head = `Background job ${job.id}${job.label ? ` (${job.label})` : ""}: ${count} line${count === 1 ? "" : "s"} matched notify_on /${job.notifyOn}/ — still running`;
      send(`${head}\nlog: ${job.logPath}\n${text}`, {
        id: job.id,
        kind: "match",
        state: job.state,
        summary: head,
      });
    }

    /** number = exit code, string = signal name trapped by the wrapper, undefined = not finished/lost. */
    function exitCodeFile(job: Persisted): number | string | null | undefined {
      try {
        const t = readFileSync(`${job.logPath}.exit`, "utf8").trim();
        if (t === "") return undefined;
        if (/^SIG[A-Z0-9]+$/.test(t)) return t;
        const n = Number(t);
        return Number.isFinite(n) ? n : null;
      } catch {
        return undefined;
      }
    }

    function finish(job: Persisted) {
      const r = runtimeFor(job);
      readNew(job, r);
      if (r.partial) {
        handleLine(job, r, r.partial, r.readOffset);
        r.partial = "";
      }
      const result = exitCodeFile(job);
      const sig = typeof result === "string" ? result : undefined;
      const code = typeof result === "string" ? undefined : result;
      job.endedAt = job.endedAt ?? Date.now();
      job.exitCode = code ?? null;
      job.state = job.killRequested || code === undefined ? "killed" : "exited";
      if (!job.killRequested) {
        if (sig) job.signal = sig;
        else if (code === undefined) job.signal = job.signal ?? "lost (no exit code)";
      }
      if (r.killTimer) clearTimeout(r.killTimer);
      const pending = r.batch ? batchText(r) : "";
      r.batch = undefined;
      const suppressed = r.suppressed;
      if (job.notify && !job.notified) notifyDone(job, pending, suppressed);
      job.notified = true;
      rt.delete(job.id);
      save();
      refreshStatus();
    }

    function notifyDone(job: Persisted, pending = "", suppressed = 0) {
      const now = Date.now();
      const tail = readTail(job.logPath, NOTIFY_LINES, NOTIFY_BYTES);
      const ok = isOk(job);
      const body = [
        `Background job ${describeJob(job, now)}`,
        `log: ${job.logPath}`,
        ...(suppressed ? [`(notify_on: ${suppressed} matches suppressed by rate limit)`] : []),
        ...(pending ? [`\nUnreported notify_on matches:\n${pending}`] : []),
        tail.text
          ? `\n${tail.truncated ? `(last ${NOTIFY_LINES} lines)\n` : ""}${tail.text}`
          : "\n(no output)",
      ].join("\n");
      send(body, {
        id: job.id,
        kind: "exit",
        exitCode: job.exitCode,
        state: job.state,
        ok,
        summary: redact(describeJob(job, now)),
      });
    }

    function failJob(job: Persisted, reason: string, output: string, viaMessage: boolean) {
      job.state = "failed";
      job.failReason = reason;
      job.endedAt = Date.now();
      job.exitCode = null;
      if (viaMessage && job.notify && !job.notified) {
        const head = `Background job ${describeJob(job, Date.now())}`;
        send(`${head}\n${sanitize(output).trim() || "(no output)"}`, {
          id: job.id,
          kind: "exit",
          state: job.state,
          ok: false,
          summary: redact(head),
        });
      }
      job.notified = true;
      save();
      refreshStatus();
    }

    function spawnJob(job: Persisted) {
      mkdirSync(logDir, { recursive: true });
      try {
        unlinkSync(`${job.logPath}.exit`);
      } catch {}
      const fd = openSync(job.logPath, "a");
      const env = buildEnv(process.env, job.env);
      env.PI_BG_EXIT = `${job.logPath}.exit`;
      if (job.waitUntil) {
        env.PI_BG_CMD = waitUntilScript(job.waitUntil.interval, job.waitUntil.maxWait);
        env.PI_BG_WAIT_CMD = job.command;
      } else env.PI_BG_CMD = job.command;
      // Record the exit code, or the name of a signal that hit the wrapper (SIGKILL cannot be trapped).
      const wrapper = [
        'done_() { printf "%s" "$1" > "$PI_BG_EXIT.tmp" && mv "$PI_BG_EXIT.tmp" "$PI_BG_EXIT"; }',
        ...["INT", "TERM", "HUP", "QUIT", "PIPE", "USR1", "USR2"].map(
          (s) => `trap 'done_ SIG${s}; trap - ${s}; kill -${s} $$' ${s}`,
        ),
        'bash -c "$PI_BG_CMD"; rc=$?; done_ "$rc"; exit $rc',
      ].join("\n");
      job.startedAt = Date.now();
      job.state = "running";
      if (job.timeoutSec && job.timeoutSec > 0)
        job.timeoutAt = job.startedAt + job.timeoutSec * 1000;
      try {
        const child = spawn("bash", ["-c", wrapper], {
          cwd: job.cwd,
          detached: true,
          stdio: ["ignore", fd, fd],
          env,
        });
        job.pid = child.pid;
        const r = runtimeFor(job);
        r.child = child;
        r.lastOutputAt = Date.now();
        child.unref();
        child.on("error", (err) => {
          if (job.state !== "running" || disposed) return;
          failJob(job, `spawn error: ${err.message}`, "", true);
          rt.delete(job.id);
        });
        child.on("exit", () => {
          if (disposed || job.state !== "running") return;
          finish(job);
        });
      } catch (e) {
        job.state = "failed";
        job.failReason = String((e as Error).message);
        job.endedAt = Date.now();
        job.notified = true;
      } finally {
        closeSync(fd);
      }
      save();
      refreshStatus();
      ensureTicker();
    }

    async function launch(job: Persisted, viaMessage: boolean): Promise<string | undefined> {
      if (job.preflight) {
        const r = await runCapture(job.preflight, job.cwd, buildEnv(process.env, job.env));
        if (disposed) return undefined;
        if (job.state === "killed") return undefined;
        if (r.code !== 0) {
          const out = sanitize(r.output).trim();
          failJob(job, `preflight failed (exit ${r.code})`, out, viaMessage);
          return out;
        }
      }
      spawnJob(job);
      return undefined;
    }

    function tick() {
      if (disposed) return;
      const now = Date.now();
      for (const job of jobs.values()) {
        if (job.state === "scheduled") {
          const r = runtimeFor(job);
          if (now >= (job.scheduledAt ?? 0) && !r.starting) {
            r.starting = true;
            void launch(job, true).finally(() => {
              r.starting = false;
            });
          }
          continue;
        }
        if (job.state !== "running") continue;
        const r = runtimeFor(job);
        readNew(job, r);
        if (job.state !== "running") continue;
        maybeFlush(job, r, now);
        if (job.timeoutAt && now >= job.timeoutAt && !job.killRequested) kill(job);
        if (
          job.idleWarnSec &&
          job.idleWarnSec > 0 &&
          !r.idleWarned &&
          now - r.lastOutputAt >= job.idleWarnSec * 1000
        ) {
          r.idleWarned = true;
          if (job.notify) {
            const quiet = formatDuration(now - r.lastOutputAt);
            const tail = readTail(job.logPath, IDLE_LINES, NOTIFY_BYTES);
            const head = `Background job ${job.id}${job.label ? ` (${job.label})` : ""}: no output for ${quiet} — still running ${formatDuration(now - job.startedAt)}`;
            send(
              `${head}\nlog: ${job.logPath}\n${tail.text ? `last lines:\n${tail.text}` : "(no output yet)"}`,
              { id: job.id, kind: "idle", state: job.state, summary: head },
            );
          }
        }
        const exited = exitCodeFile(job) !== undefined || !alive(job.pid);
        if (exited) {
          const child = r.child;
          if (child && child.exitCode === null && child.signalCode === null && alive(job.pid))
            continue;
          finish(job);
        }
      }
      if (!active().length && ticker) {
        clearInterval(ticker);
        ticker = undefined;
      }
    }

    function prune() {
      const now = Date.now();
      for (const [id, j] of jobs) {
        if (
          j.state !== "running" &&
          j.state !== "scheduled" &&
          now - (j.endedAt ?? j.startedAt) > RETAIN_MS
        ) {
          jobs.delete(id);
          rt.delete(id);
        }
      }
    }

    function adopt() {
      const reg = readRegistry();
      const now = Date.now();
      const keep: Persisted[] = [];
      let changed = false;
      for (const j of reg.jobs) {
        const ended = j.state !== "running" && j.state !== "scheduled";
        if (ended && now - (j.endedAt ?? j.startedAt) > RETAIN_MS) {
          changed = true;
          for (const p of [j.logPath, `${j.logPath}.exit`])
            try {
              unlinkSync(p);
            } catch {}
          continue;
        }
        if (
          !ended &&
          j.owner !== owner &&
          !alive(j.owner) &&
          !alive(j.pid) &&
          now - j.startedAt > RETAIN_MS
        ) {
          changed = true;
          continue;
        }
        keep.push(j);
        if (j.owner !== owner || jobs.has(j.id)) continue;
        // Same pid is not enough: in-process subagent sessions share it. Only adopt
        // our own session's jobs; legacy records without a session go to the first
        // session that adopts them and are claimed so no other session touches them.
        if (j.session === undefined && session !== undefined) {
          j.session = session;
          changed = true;
        }
        if (j.session === session) jobs.set(j.id, j);
      }
      if (changed) {
        try {
          writeRegistry({ seq: reg.seq, jobs: keep });
        } catch {}
      }
      for (const j of jobs.values())
        if (j.state === "running" || j.state === "scheduled") runtimeFor(j);
      if (active().length) ensureTicker();
      tick();
    }

    function visible(all: boolean): Persisted[] {
      prune();
      const now = Date.now();
      return [...jobs.values()].filter(
        (j) =>
          all ||
          j.state === "running" ||
          j.state === "scheduled" ||
          now - (j.endedAt ?? j.startedAt) <= RECENT_MS,
      );
    }

    function output(id: string | undefined, lines: number, all = false): string {
      if (!id) {
        const list = visible(all);
        const hidden = jobs.size - list.length;
        const more =
          hidden > 0
            ? `\n(${hidden} older finished job${hidden === 1 ? "" : "s"} hidden; pass all: true)`
            : "";
        return redact(
          list.length
            ? list.map((j) => describeJob(j, Date.now())).join("\n") + more
            : `No background jobs.${more}`,
        );
      }
      const job = jobs.get(id);
      if (!job) throw new Error(`No background job ${id}`);
      const tail = readTail(job.logPath, Math.max(1, lines), OUTPUT_MAX_BYTES);
      return redact(
        [
          describeJob(job, Date.now()),
          `log: ${job.logPath} (${tail.size} bytes)`,
          tail.text
            ? `${tail.truncated ? `(showing last ${lines} lines)\n` : ""}${tail.text}`
            : job.state === "scheduled"
              ? "(not started yet)"
              : "(no output yet)",
        ].join("\n"),
      );
    }

    pi.registerMessageRenderer<{
      state?: string;
      exitCode?: number | null;
      summary?: string;
      ok?: boolean;
      kind?: string;
    }>(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
      const content = typeof message.content === "string" ? message.content : "";
      const d = message.details;
      const color =
        d?.kind === "match"
          ? "accent"
          : d?.kind === "idle"
            ? "warning"
            : (d?.ok ?? (d?.state === "exited" && d?.exitCode === 0))
              ? "success"
              : "warning";
      const label = theme.fg(color, "[bg-bash]");
      const body = expanded ? content : collapseMessage(content, COLLAPSED_LINES);
      const hint = expanded || body === content ? "" : `\n${theme.fg("dim", "(ctrl+o to expand)")}`;
      const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(`${label} ${body}${hint}`, 0, 0));
      return box;
    });

    pi.on("session_start", async (_e, ctx) => {
      disposed = false;
      lastCtx = ctx;
      session = sessionOf(ctx);
      adopt();
      refreshStatus();
    });

    pi.on("agent_end", async (_e, ctx) => {
      lastCtx = ctx;
    });

    pi.on("session_shutdown", async (e) => {
      const reason = (e as { reason?: string } | undefined)?.reason;
      if (disposed) return;
      if (reason !== "reload") {
        for (const job of active()) {
          const wasRunning = job.state === "running";
          kill(job);
          if (wasRunning) {
            job.state = "killed";
            job.endedAt = Date.now();
          }
          job.notified = true;
        }
      }
      save();
      disposed = true;
      if (ticker) clearInterval(ticker);
      if (statusTicker) clearInterval(statusTicker);
      ticker = statusTicker = undefined;
      for (const r of rt.values()) r.child?.removeAllListeners("exit");
      try {
        lastCtx?.ui.setStatus(STATUS_KEY, undefined);
      } catch {}
    });

    pi.registerTool({
      name: "bash_bg",
      label: "Background bash",
      description:
        "Start a shell command in the background and return immediately with a job id. Use for anything that may take longer than about 30 seconds (builds, deploys, waiting/polling, large queries, sleeps). Output goes to a log file; you get a message when it exits, so end your turn instead of polling. Jobs survive /reload. Options: notify_on (regex) wakes you on matching lines while it keeps running — use for long-lived watchers instead of restarting a script per event; idle_warn warns when output stalls; wait_until re-runs command every interval seconds until it exits 0 (use instead of hand-written polling loops); at delays the start; ok_codes marks expected non-zero exits as success; preflight checks (e.g. auth) before starting; fail_on adds kill patterns (gcloud/gh auth errors are built in). Colors and pagers are disabled by default; use env to override. yield_ms waits up to that many ms: if the command exits by then you get its exit code and output directly (no later message); otherwise it keeps running in the background as usual.",
      promptSnippet:
        "bash_bg: run a long shell command in the background; you are notified when it exits (or on notify_on matches)",
      promptGuidelines: [
        "For shell work likely to take more than ~30 seconds (deploys, builds, waiting on CI/Cloud Build, sleeps, long queries), use bash_bg instead of bash, tell the user what is running, and end your turn; you will be notified when it exits.",
        "Never sleep or poll in a loop waiting for a bash_bg job; use bash_bg_output only when the user asks for progress or you need intermediate output.",
        "For commands that usually finish in seconds but might hang or run long, use bash_bg with yield_ms (e.g. 10000) instead of bash; plain bash is still fine for trivially short commands.",
        "To wait for a condition, use bash_bg with wait_until: true and a check command instead of a sleep loop; to watch a stream of events, use one long-running job with notify_on instead of a script that exits per event.",
      ],
      parameters: Type.Object({
        command: Type.String({
          description: "Shell command, run with bash -c (with wait_until: the check to repeat)",
        }),
        label: Type.Optional(Type.String({ description: "Short name shown in job lists" })),
        cwd: Type.Optional(
          Type.String({ description: "Working directory (defaults to the session cwd)" }),
        ),
        timeout: Type.Optional(
          Type.Number({ description: "Kill the job after this many seconds" }),
        ),
        notify: Type.Optional(
          Type.Boolean({
            description: "Post the result and wake the agent when the job exits (default true)",
          }),
        ),
        notify_on: Type.Optional(
          Type.String({
            description:
              "Regex; matching output lines wake you while the job keeps running (batched ~5s, rate-limited)",
          }),
        ),
        idle_warn: Type.Optional(
          Type.Number({
            description:
              "Seconds without new output before one 'no output' warning (re-arms on output)",
          }),
        ),
        wait_until: Type.Optional(
          Type.Boolean({
            description:
              "Treat command as a check; re-run it every interval s until it exits 0 or max_wait s pass",
          }),
        ),
        interval: Type.Optional(
          Type.Number({ description: "wait_until: seconds between checks (default 30)" }),
        ),
        max_wait: Type.Optional(
          Type.Number({
            description: "wait_until: give up after this many seconds (default 3600)",
          }),
        ),
        at: Type.Optional(
          Type.String({ description: "Start later: ISO-8601 time or relative +90s/+10m/+2h" }),
        ),
        env: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description:
              "Extra/override environment variables (defaults: NO_COLOR=1, TERM=dumb, pagers=cat, gcloud no prompts/color)",
          }),
        ),
        fail_on: Type.Optional(
          Type.String({
            description:
              'Regex; a matching output line kills the job. Adds to built-in gcloud/gh auth-failure patterns; "" disables the built-ins',
          }),
        ),
        builtin_fail: Type.Optional(
          Type.Boolean({
            description:
              "Use built-in auth-failure kill patterns (default true). Set false for watchers that relay other programs' output, or a relayed auth error will kill them",
          }),
        ),
        preflight: Type.Optional(
          Type.String({
            description:
              "Command run first (e.g. gcloud auth print-access-token >/dev/null); job does not start if it fails",
          }),
        ),
        yield_ms: Type.Optional(
          Type.Number({
            description: `Wait up to this many ms (max ${YIELD_MAX_MS}) for the job to exit and return its output directly; if still running it continues in the background. Not with wait_until or at`,
          }),
        ),
        ok_codes: Type.Optional(
          Type.Array(Type.Number(), {
            description: "Exit codes that count as success (default [0])",
          }),
        ),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        lastCtx = ctx;
        const yieldMs = params.yield_ms;
        if (yieldMs !== undefined) {
          if (!Number.isFinite(yieldMs) || yieldMs <= 0 || yieldMs > YIELD_MAX_MS)
            throw new Error(`Invalid yield_ms ${yieldMs}: must be > 0 and <= ${YIELD_MAX_MS}`);
          if (params.wait_until) throw new Error("yield_ms cannot be combined with wait_until");
          if (params.at) throw new Error("yield_ms cannot be combined with at");
        }
        const cwd = params.cwd
          ? isAbsolute(params.cwd)
            ? params.cwd
            : resolve(ctx.cwd, params.cwd)
          : ctx.cwd;
        const now = Date.now();
        const scheduledAt = params.at ? parseAt(params.at, now) : undefined;
        for (const [name, src] of [
          ["notify_on", params.notify_on],
          ["fail_on", params.fail_on],
        ] as const) {
          try {
            compile(src);
          } catch (e) {
            throw new Error(`Invalid ${name} regex: ${(e as Error).message}`);
          }
        }
        mkdirSync(logDir, { recursive: true });
        const id = nextId();
        session ??= sessionOf(ctx);
        const job: Persisted = {
          id,
          owner,
          session,
          command: params.command,
          label: params.label,
          cwd,
          logPath: join(logDir, `${id}.log`),
          startedAt: scheduledAt ?? now,
          state: "scheduled",
          notify: params.notify !== false,
          scheduledAt,
          okCodes: params.ok_codes?.length ? params.ok_codes : undefined,
          env: params.env,
          timeoutSec: params.timeout,
          notifyOn: params.notify_on || undefined,
          idleWarnSec: params.idle_warn,
          failOn: params.fail_on || undefined,
          builtinFail: params.builtin_fail !== false && params.fail_on !== "",
          preflight: params.preflight || undefined,
          waitUntil: params.wait_until
            ? {
                interval: Math.max(1, Math.round(params.interval ?? 30)),
                maxWait: Math.max(1, Math.round(params.max_wait ?? 3600)),
              }
            : undefined,
        };
        jobs.set(id, job);
        save();
        let text: string;
        if (scheduledAt !== undefined && scheduledAt > now) {
          ensureTicker();
          refreshStatus();
          text = `Scheduled ${id} to start at ${new Date(scheduledAt).toISOString()} (in ${formatDuration(scheduledAt - now)}). Log: ${job.logPath}\nYou will get a message when it exits. Cancel with bash_bg_kill.`;
        } else {
          const pre = await launch(job, false);
          if (yieldMs !== undefined && job.state === "running") {
            const notified = job.notified;
            job.notified = true;
            const end = Date.now() + yieldMs;
            while (job.state === "running" && Date.now() < end && !signal?.aborted && !disposed) {
              await new Promise((r) => setTimeout(r, Math.min(YIELD_POLL_MS, end - Date.now())));
            }
            if (job.state === "running") {
              job.notified = notified;
              save();
            }
          }
          if (yieldMs !== undefined && (job.state === "exited" || job.state === "killed")) {
            const tail = readTail(job.logPath, YIELD_LINES, OUTPUT_MAX_BYTES);
            text = redact(
              [
                describeJob(job, Date.now()),
                `log: ${job.logPath}`,
                tail.text
                  ? `${tail.truncated ? `(last ${YIELD_LINES} lines)\n` : ""}${tail.text}`
                  : "(no output)",
              ].join("\n"),
            );
          } else if (yieldMs !== undefined && job.state === "running") {
            const tail = readTail(job.logPath, YIELD_PARTIAL_LINES, NOTIFY_BYTES);
            text = redact(
              [
                `Started ${id} (pid ${job.pid}). Log: ${job.logPath}`,
                `Still running after ${formatDuration(Date.now() - job.startedAt)}; it continues in the background and you will get a message when it exits${job.notifyOn ? " and when output matches notify_on" : ""}.`,
                tail.text
                  ? `${tail.truncated ? `(last ${YIELD_PARTIAL_LINES} lines)\n` : ""}${tail.text}`
                  : "(no output yet)",
              ].join("\n"),
            );
          } else if (job.state === "running")
            text = `Started ${id} (pid ${job.pid}). Log: ${job.logPath}\nYou will get a message when it exits${job.notifyOn ? " and when output matches notify_on" : ""}. End your turn unless there is other work to do.`;
          else if (pre !== undefined)
            text = redact(`Did not start ${id}: ${job.failReason}\n${pre || "(no output)"}`);
          else text = `Failed to start ${id}: ${job.failReason ?? job.signal ?? "unknown error"}`;
        }
        return {
          content: [{ type: "text", text }],
          details: {
            id,
            pid: job.pid,
            logPath: job.logPath,
            state: job.state,
            ...(job.state === "exited" || job.state === "killed"
              ? { exitCode: job.exitCode, ok: isOk(job) }
              : {}),
          },
        };
      },
    });

    pi.registerTool({
      name: "bash_bg_output",
      label: "Background bash output",
      description:
        "List background jobs (omit id: running, scheduled and finished in the last hour; all: true for everything), or show one job's status and the last lines of its output.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Job id such as bg1" })),
        lines: Type.Optional(
          Type.Number({
            description: `Number of trailing lines (default ${OUTPUT_DEFAULT_LINES})`,
          }),
        ),
        all: Type.Optional(Type.Boolean({ description: "List all remembered jobs (last 24 h)" })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        lastCtx = ctx;
        return {
          content: [
            {
              type: "text",
              text: output(params.id, params.lines ?? OUTPUT_DEFAULT_LINES, params.all === true),
            },
          ],
          details: {},
        };
      },
    });

    function killTargets(arg: string): Persisted[] {
      return arg === "all" ? active() : [jobs.get(arg)].filter((j): j is Persisted => !!j);
    }

    pi.registerTool({
      name: "bash_bg_kill",
      label: "Background bash kill",
      description:
        'Stop a background job by id, or "all" (also cancels scheduled jobs). Sends SIGTERM to its process group, then SIGKILL after 5 seconds.',
      parameters: Type.Object({ id: Type.String({ description: 'Job id, or "all"' }) }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        lastCtx = ctx;
        const targets = killTargets(params.id);
        if (!targets.length)
          return {
            content: [
              {
                type: "text",
                text: params.id === "all" ? "No running jobs." : `No background job ${params.id}`,
              },
            ],
            details: {},
          };
        const killed = targets.filter((j) => kill(j)).map((j) => j.id);
        return {
          content: [
            {
              type: "text",
              text: killed.length ? `Stopping ${killed.join(", ")}` : "Nothing was running.",
            },
          ],
          details: { killed },
        };
      },
    });

    pi.registerCommand("bg", {
      description: "Background bash jobs: /bg [list|all] | /bg log <id> | /bg kill <id|all>",
      handler: async (args, ctx) => {
        lastCtx = ctx;
        const [sub = "list", arg] = args.trim().split(/\s+/).filter(Boolean);
        let text: string;
        if (sub === "list") text = output(undefined, 0);
        else if (sub === "all") text = output(undefined, 0, true);
        else if (sub === "log" && arg)
          text = jobs.has(arg) ? output(arg, OUTPUT_DEFAULT_LINES) : `No background job ${arg}`;
        else if (sub === "kill" && arg) {
          const killed = killTargets(arg)
            .filter((j) => kill(j))
            .map((j) => j.id);
          text = killed.length ? `Stopping ${killed.join(", ")}` : `Nothing to stop for ${arg}`;
        } else text = "Usage: /bg [list|all] | /bg log <id> | /bg kill <id|all>";
        ctx.ui.notify(text, "info");
      },
    });
  };
}

export default createBgBash();
