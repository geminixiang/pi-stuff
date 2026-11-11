import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ext, { createBgBash, type BgBashOptions } from "../extensions/index.ts";
import { formatDuration, readTail, statusText, tailText } from "../extensions/lib.ts";

process.env.PI_BG_BASH_DIR = mkdtempSync(join(tmpdir(), "bgstate-"));

const freshDir = () => mkdtempSync(join(tmpdir(), "bgstate-"));

function harness(opts: BgBashOptions & { sessionId?: string } = {}) {
  const h: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const cmds: Record<string, any> = {};
  const renderers: Record<string, Function> = {};
  const sent: { msg: any; opts: any }[] = [];
  const notes: string[] = [];
  const status: Record<string, string | undefined> = {};
  const st = { idle: true };
  const pi: any = {
    on: (n: string, f: Function) => (h[n] = f),
    registerTool: (t: any) => (tools[t.name] = t),
    registerCommand: (n: string, c: any) => (cmds[n] = c),
    sendMessage: (msg: any, opts: any) => sent.push({ msg, opts }),
    registerMessageRenderer: (t: string, f: Function) => (renderers[t] = f),
  };
  const sessionId = opts.sessionId ?? "main-session";
  const ctx: any = {
    cwd: tmpdir(),
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => st.idle,
    ui: {
      setStatus: (k: string, v: string | undefined) => (status[k] = v),
      notify: (t: string) => notes.push(t),
    },
  };
  const stateDir = opts.stateDir ?? freshDir();
  const { sessionId: _s, ...rest } = opts;
  createBgBash({ tickMs: 50, ...rest, stateDir })(pi);
  return { h, tools, cmds, renderers, sent, notes, status, st, ctx, stateDir };
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const run = (t: any, params: any, ctx: any) => t.execute("call", params, undefined, undefined, ctx);

test("bash_bg returns immediately and notifies with exit code and output", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  const started = Date.now();
  const r = await run(
    x.tools.bash_bg,
    { command: "echo hello; sleep 0.3; echo done; exit 3", label: "demo" },
    x.ctx,
  );
  assert.ok(Date.now() - started < 200);
  assert.match(r.content[0].text, /Started bg1/);
  assert.match(x.status["bg-bash"]!, /^bg: bg1 demo · \d+s$/);
  await waitFor(() => x.sent.length === 1);
  const { msg, opts } = x.sent[0];
  assert.equal(msg.customType, "bg-bash");
  assert.match(msg.content, /bg1 \[exit 3 after/);
  assert.match(msg.content, /hello\ndone/);
  assert.deepEqual(opts, { triggerTurn: true });
  assert.equal(x.status["bg-bash"], undefined);
});

test("notification is queued as follow-up while the agent is busy", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  x.st.idle = false;
  await run(x.tools.bash_bg, { command: "true" }, x.ctx);
  await waitFor(() => x.sent.length === 1);
  assert.deepEqual(x.sent[0].opts, { triggerTurn: true, deliverAs: "followUp" });
});

test("bash_bg_output lists and tails; kill stops the process group", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(x.tools.bash_bg, { command: "echo start; sleep 30 & wait" }, x.ctx);
  await new Promise((r) => setTimeout(r, 200));
  const list = await run(x.tools.bash_bg_output, {}, x.ctx);
  assert.match(list.content[0].text, /bg1 \[running/);
  const out = await run(x.tools.bash_bg_output, { id: "bg1" }, x.ctx);
  assert.match(out.content[0].text, /start/);
  const k = await run(x.tools.bash_bg_kill, { id: "bg1" }, x.ctx);
  assert.match(k.content[0].text, /Stopping bg1/);
  await waitFor(() => x.sent.length === 1);
  assert.match(x.sent[0].msg.content, /bg1 \[killed after/);
});

test("timeout kills the job", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(x.tools.bash_bg, { command: "sleep 30", timeout: 0.3 }, x.ctx);
  await waitFor(() => x.sent.length === 1);
  assert.match(x.sent[0].msg.content, /killed/);
});

test("notify:false stays quiet; shutdown kills without notifying", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(x.tools.bash_bg, { command: "true", notify: false }, x.ctx);
  await run(x.tools.bash_bg, { command: "sleep 30" }, x.ctx);
  await new Promise((r) => setTimeout(r, 200));
  await x.h.session_shutdown({}, x.ctx);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(x.sent.length, 0);
  const list = await run(x.tools.bash_bg_output, {}, x.ctx);
  assert.match(list.content[0].text, /bg2 \[killed/);
});

test("/bg command lists, logs and handles unknown ids", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await x.cmds.bg.handler("", x.ctx);
  await x.cmds.bg.handler("log nope", x.ctx);
  assert.deepEqual(x.notes, ["No background jobs.", "No background job nope"]);
});

test("helpers", () => {
  assert.equal(formatDuration(5_000), "5s");
  assert.equal(formatDuration(125_000), "2m5s");
  assert.equal(formatDuration(3_720_000), "1h2m");
  assert.deepEqual(tailText("a\nb\nc\n", 2, 1000), { text: "b\nc", truncated: true });
  const dir = mkdtempSync(join(tmpdir(), "bgt-"));
  const p = join(dir, "x.log");
  writeFileSync(p, Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n") + "\n");
  const t = readTail(p, 3, 1 << 20);
  assert.equal(t.text, "line97\nline98\nline99");
  assert.equal(t.truncated, true);
  assert.equal(readTail(join(dir, "missing"), 3, 100).text, "");
});

test("statusText names each running job with its age", () => {
  const base = { cwd: "/", logPath: "/x", state: "running" as const, notify: true };
  const now = 1_000_000;
  const a = {
    ...base,
    id: "bg3",
    command: "sleep 9; gcloud logging read",
    label: "fer-issues 09Z hourly check",
    startedAt: now - 34 * 60_000,
  };
  const b = { ...base, id: "bg5", command: "npm   run    build", startedAt: now - 5_000 };
  assert.equal(statusText([a], now), "bg: bg3 fer-issues 09Z hourly check · 34m");
  assert.equal(
    statusText([a, b], now),
    "bg: 2 running: bg3 fer-issues 09Z ho… 34m | bg5 npm run build 5s",
  );
});

test("collapseMessage keeps the header and the last lines", async () => {
  const { collapseMessage } = await import("../extensions/lib.ts");
  const msg = [
    "Background job bg4 [exit 0 after 2m29s] plan",
    "log: /tmp/x.log",
    "",
    "(last 30 lines)",
    "a",
    "b",
    "c",
    "d",
    "e",
  ].join("\n");
  assert.equal(
    collapseMessage(msg, 3),
    "Background job bg4 [exit 0 after 2m29s] plan\n… 2 more lines\nc\nd\ne",
  );
  assert.equal(
    collapseMessage("Background job bg1 [exit 0 after 1s] x\nlog: /tmp/y\n\n(no output)", 3),
    "Background job bg1 [exit 0 after 1s] x\n(no output)",
  );
});

test("registers a message renderer that collapses by default", () => {
  const renderers: Record<string, Function> = {};
  const pi: any = {
    on() {},
    registerTool() {},
    registerCommand() {},
    sendMessage() {},
    registerMessageRenderer: (t: string, f: Function) => (renderers[t] = f),
  };
  ext(pi);
  assert.equal(typeof renderers["bg-bash"], "function");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kinds = (x: { sent: { msg: any }[] }, kind: string) =>
  x.sent.filter((s) => s.msg.details?.kind === kind);

test("notify_on batches matches with context while the job keeps running", async () => {
  const x = harness({ batchMs: 300, minGapMs: 0 });
  await x.h.session_start({}, x.ctx);
  const r = await run(
    x.tools.bash_bg,
    {
      command:
        "echo noise; echo 'EVENT one'; echo ctx1; echo ctx2; echo 'EVENT two'; echo after; sleep 30",
      notify_on: "^EVENT",
    },
    x.ctx,
  );
  assert.match(r.content[0].text, /notify_on/);
  await waitFor(() => kinds(x, "match").length === 1);
  await sleep(400);
  assert.equal(x.sent.length, 1);
  const m = x.sent[0].msg.content;
  assert.match(m, /2 lines matched notify_on/);
  assert.match(m, /> EVENT one\n {2}ctx1\n {2}ctx2\n> EVENT two\n {2}after/);
  assert.doesNotMatch(m, /noise/);
  assert.match((await run(x.tools.bash_bg_output, {}, x.ctx)).content[0].text, /running/);
  await run(x.tools.bash_bg_kill, { id: "bg1" }, x.ctx);
  await waitFor(() => kinds(x, "exit").length === 1);
});

test("notify_on is rate limited and reports suppressed matches at exit", async () => {
  const x = harness({ batchMs: 50, minGapMs: 0, maxNotifyPerHour: 2 });
  await x.h.session_start({}, x.ctx);
  await run(
    x.tools.bash_bg,
    { command: "for i in $(seq 1 12); do echo EVENT $i; sleep 0.15; done", notify_on: "EVENT" },
    x.ctx,
  );
  await waitFor(() => kinds(x, "exit").length === 1, 8000);
  assert.equal(kinds(x, "match").length, 2);
  assert.match(kinds(x, "exit")[0].msg.content, /matches suppressed by rate limit/);
});

test("notify_on respects the minimum gap between messages", async () => {
  const x = harness({ batchMs: 50, minGapMs: 60_000 });
  await x.h.session_start({}, x.ctx);
  await run(
    x.tools.bash_bg,
    { command: "echo EVENT a; sleep 0.5; echo EVENT b; sleep 0.5", notify_on: "EVENT" },
    x.ctx,
  );
  await waitFor(() => kinds(x, "exit").length === 1, 5000);
  assert.equal(kinds(x, "match").length, 1);
  assert.match(kinds(x, "exit")[0].msg.content, /Unreported notify_on matches:\n> EVENT b/);
});

test("idle_warn fires once per quiet period and re-arms after output", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(
    x.tools.bash_bg,
    { command: "echo a; sleep 1.2; echo b; sleep 1.2; echo c", idle_warn: 0.6 },
    x.ctx,
  );
  await waitFor(() => kinds(x, "exit").length === 1, 8000);
  const idle = kinds(x, "idle");
  assert.equal(idle.length, 2);
  assert.match(idle[0].msg.content, /no output for \ds — still running/);
  assert.match(idle[0].msg.content, /last lines:\na/);
  assert.match(idle[1].msg.content, /a\nb/);
});

test("wait_until succeeds once the check passes and logs each attempt", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  const flag = join(freshDir(), "ready");
  await run(
    x.tools.bash_bg,
    { command: `test -f ${flag} && echo ready`, wait_until: true, interval: 1, max_wait: 20 },
    x.ctx,
  );
  setTimeout(() => writeFileSync(flag, ""), 1300);
  await waitFor(() => kinds(x, "exit").length === 1, 8000);
  const m = kinds(x, "exit")[0];
  assert.equal(m.msg.details.exitCode, 0);
  assert.match(m.msg.content, /\d{4}-\d\d-\d\dT\S+ attempt 1 exit 1 \n/);
  assert.match(m.msg.content, /attempt \d exit 0 ready/);
  assert.match(m.msg.content, /condition met after \d attempts/);
});

test("wait_until gives up after max_wait with a non-zero exit", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(
    x.tools.bash_bg,
    { command: "echo not yet; false", wait_until: true, interval: 1, max_wait: 1 },
    x.ctx,
  );
  await waitFor(() => kinds(x, "exit").length === 1, 8000);
  const m = kinds(x, "exit")[0];
  assert.equal(m.msg.details.exitCode, 124);
  assert.equal(m.msg.details.ok, false);
  assert.match(m.msg.content, /attempt 1 exit 1 not yet/);
  assert.match(m.msg.content, /gave up after \d attempts/);
});

test("parseAt accepts relative and ISO times and rejects junk", async () => {
  const { parseAt } = await import("../extensions/lib.ts");
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(parseAt("+10m", now), now + 600_000);
  assert.equal(parseAt("+2h", now), now + 7_200_000);
  assert.equal(parseAt("+1h30m", now), now + 5_400_000);
  assert.equal(parseAt("+45s", now), now + 45_000);
  assert.equal(parseAt("2026-01-01T01:00:00Z", now), now + 3_600_000);
  assert.equal(parseAt("2026-01-01T09:00:00+08:00", now), now + 3_600_000);
  assert.throws(() => parseAt("+10x", now), /Invalid relative/);
  assert.throws(() => parseAt("tomorrow-ish", now), /Invalid time/);
  assert.throws(() => parseAt("2025-01-01T00:00:00Z", now), /past/);
});

test("scheduled jobs are listed, start later, and can be cancelled", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  const a = await run(x.tools.bash_bg, { command: "echo late", at: "+1s" }, x.ctx);
  const b = await run(x.tools.bash_bg, { command: "echo never", at: "+1h" }, x.ctx);
  assert.match(a.content[0].text, /Scheduled bg1/);
  assert.match(b.content[0].text, /Scheduled bg2/);
  assert.match(x.status["bg-bash"]!, /^bg: 2 scheduled$/);
  const list = (await run(x.tools.bash_bg_output, {}, x.ctx)).content[0].text;
  assert.match(list, /bg1 \[scheduled \d{4}-/);
  assert.match((await run(x.tools.bash_bg_kill, { id: "bg2" }, x.ctx)).content[0].text, /bg2/);
  await waitFor(() => kinds(x, "exit").length === 1, 5000);
  assert.match(kinds(x, "exit")[0].msg.content, /bg1 \[exit 0.*\n[\s\S]*late/);
  assert.match((await run(x.tools.bash_bg_output, {}, x.ctx)).content[0].text, /bg2 \[killed/);
  assert.equal(x.sent.length, 1);
});

test("env defaults disable colour/pagers and can be overridden", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(
    x.tools.bash_bg,
    {
      command:
        'echo "$NO_COLOR|$TERM|$PAGER|$GIT_PAGER|$GH_PAGER|$CLOUDSDK_CORE_DISABLE_PROMPTS|$CLOUDSDK_CORE_DISABLE_COLOR|$FOO"',
      env: { TERM: "xterm", FOO: "bar" },
    },
    x.ctx,
  );
  await waitFor(() => kinds(x, "exit").length === 1);
  assert.match(kinds(x, "exit")[0].msg.content, /1\|xterm\|cat\|cat\|cat\|1\|1\|bar/);
});

test("ANSI escapes are stripped from notifications and output", async () => {
  const { stripAnsi } = await import("../extensions/lib.ts");
  assert.equal(stripAnsi("\x1b[1mgenv-studio\x1b[0m \x1b]0;t\x07ok"), "genv-studio ok");
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(x.tools.bash_bg, { command: "printf '\\033[1mgenv-studio-001\\033[0m\\n'" }, x.ctx);
  await waitFor(() => kinds(x, "exit").length === 1);
  const m = kinds(x, "exit")[0].msg.content;
  assert.match(m, /\ngenv-studio-001$/);
  assert.doesNotMatch(m, /\x1b/);
  const out = (await run(x.tools.bash_bg_output, { id: "bg1" }, x.ctx)).content[0].text;
  assert.doesNotMatch(out, /\x1b/);
  const log = readFileSync(kinds(x, "exit")[0].msg.content.match(/log: (\S+)/)[1], "utf8");
  assert.match(log, /\x1b\[1m/);
});

test("built-in auth failure patterns kill the job and say why", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(
    x.tools.bash_bg,
    { command: "echo 'ERROR: (gcloud.run) Reauthentication failed.'; sleep 30" },
    x.ctx,
  );
  await waitFor(() => kinds(x, "exit").length === 1);
  const m = kinds(x, "exit")[0].msg;
  assert.equal(m.details.state, "killed");
  assert.match(
    m.content,
    /stopped after \d+s: matched fail pattern \(gcloud reauthentication failed\)/,
  );
});

test("each built-in fail pattern matches; fail_on adds and '' disables", async () => {
  const { BUILTIN_FAIL_PATTERNS } = await import("../extensions/lib.ts");
  const samples = [
    "ERROR: Reauthentication failed. cannot prompt during non-interactive execution.",
    "ERROR: (gcloud.auth) There was a problem refreshing your current auth tokens: x",
    "Please run:\n\n  $ gcloud auth login",
    "gh: authentication required",
    "HTTP 401: Bad credentials (https://api.github.com/graphql)",
  ];
  samples.forEach((s, i) => assert.ok(BUILTIN_FAIL_PATTERNS[i].re.test(s), s));
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(x.tools.bash_bg, { command: "echo QUOTA EXCEEDED; sleep 30", fail_on: "QUOTA" }, x.ctx);
  await run(
    x.tools.bash_bg,
    { command: "echo 'HTTP 401: Bad credentials'; exit 0", fail_on: "" },
    x.ctx,
  );
  await waitFor(() => kinds(x, "exit").length === 2);
  const byId = (id: string) => kinds(x, "exit").find((s) => s.msg.details.id === id)!.msg;
  assert.match(byId("bg1").content, /matched fail pattern \/QUOTA\/: QUOTA EXCEEDED/);
  assert.equal(byId("bg2").details.state, "exited");
  assert.equal(byId("bg2").details.ok, true);
});

test("preflight failure prevents the start and reports its output", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  const r = await run(
    x.tools.bash_bg,
    {
      command: "touch should-not-exist",
      preflight: "echo token expired ghp_abcdefghijklmnopqrstuvwxyz; exit 3",
    },
    x.ctx,
  );
  assert.match(
    r.content[0].text,
    /Did not start bg1: preflight failed \(exit 3\)\ntoken expired ghp_abcd\*\*\*/,
  );
  assert.equal(r.details.state, "failed");
  assert.equal(existsSync(join(x.ctx.cwd, "should-not-exist")), false);
  const ok = await run(x.tools.bash_bg, { command: "echo go", preflight: "true" }, x.ctx);
  assert.match(ok.content[0].text, /Started bg2/);
  await run(
    x.tools.bash_bg,
    { command: "echo go", preflight: "echo nope; false", at: "+1s" },
    x.ctx,
  );
  await waitFor(() => x.sent.some((s) => s.msg.details.id === "bg3"), 5000);
  const m = x.sent.find((s) => s.msg.details.id === "bg3")!.msg;
  assert.match(m.content, /bg3 \[failed: preflight failed \(exit 1\)\][\s\S]*\nnope/);
});

test("job list hides old finished jobs unless all: true; drops >24h", async () => {
  const dir = freshDir();
  const now = Date.now();
  const base = { owner: process.pid, cwd: "/", notify: true, builtinFail: true, notified: true };
  writeFileSync(
    join(dir, "jobs.json"),
    JSON.stringify({
      seq: 7,
      jobs: [
        {
          ...base,
          id: "bg5",
          command: "old",
          logPath: join(dir, "bg5.log"),
          startedAt: now - 2 * 3600e3,
          endedAt: now - 2 * 3600e3 + 1000,
          state: "exited",
          exitCode: 0,
        },
        {
          ...base,
          id: "bg6",
          command: "ancient",
          logPath: join(dir, "bg6.log"),
          startedAt: now - 25 * 3600e3,
          endedAt: now - 25 * 3600e3,
          state: "exited",
          exitCode: 0,
        },
        {
          ...base,
          id: "bg7",
          command: "recent",
          logPath: join(dir, "bg7.log"),
          startedAt: now - 60e3,
          endedAt: now - 30e3,
          state: "exited",
          exitCode: 1,
        },
      ],
    }),
  );
  const x = harness({ stateDir: dir });
  await x.h.session_start({}, x.ctx);
  const list = (await run(x.tools.bash_bg_output, {}, x.ctx)).content[0].text;
  assert.match(list, /bg7 \[exit 1/);
  assert.doesNotMatch(list, /bg5|bg6/);
  assert.match(list, /1 older finished job hidden/);
  const all = (await run(x.tools.bash_bg_output, { all: true }, x.ctx)).content[0].text;
  assert.match(all, /bg5 \[exit 0/);
  assert.doesNotMatch(all, /bg6/);
  const reg = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
  assert.deepEqual(reg.jobs.map((j: any) => j.id).sort(), ["bg5", "bg7"]);
  assert.equal(x.sent.length, 0);
});

test("redact masks each secret type and keeps a short prefix", async () => {
  const { redact } = await import("../extensions/lib.ts");
  const cases: [string, string][] = [
    ["xoxb-1234567890-abcdefghij", "xoxb-1234***"],
    ["xoxp-1234567890-abcdefghij", "xoxp-1234***"],
    ["sk-abcdefghijklmnopqrstuvwx", "sk-abcd***"],
    ["sk-proj-abcdefghijklmnopqrstuvwx", "sk-proj-abcd***"],
    ["sk-or-v1-0123456789abcdef0123456789", "sk-or-v1-0123***"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123", "ghp_abcd***"],
    ["gho_abcdefghijklmnopqrstuvwxyz0123", "gho_abcd***"],
    ["ghs_abcdefghijklmnopqrstuvwxyz0123", "ghs_abcd***"],
    ["ghu_abcdefghijklmnopqrstuvwxyz0123", "ghu_abcd***"],
    ["ghr_abcdefghijklmnopqrstuvwxyz0123", "ghr_abcd***"],
    ["github_pat_11ABCDEFG0123456789_abcdefghij", "github_pat_11AB***"],
    ["GOCSPX-abcdefghijklmnop", "GOCSPX-abcd***"],
    ["ya29.a0AfH6SMBabcdefghijk", "ya29.a0Af***"],
    ["AIzaSyA1234567890abcdefghijklmnopqrstu", "AIzaSyA1***"],
    ["AKIAIOSFODNN7EXAMPLE", "AKIAIOSF***"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc", "Authorization: Bearer ***"],
    [
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----***-----END RSA PRIVATE KEY-----",
    ],
  ];
  for (const [input, want] of cases) assert.equal(redact(`x ${input} y`), `x ${want} y`);
  assert.equal(
    redact("key:\n-----BEGIN PRIVATE KEY-----\nMIIEow-truncated"),
    "key:\n-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----",
  );
  assert.equal(redact("nothing secret here sk-short"), "nothing secret here sk-short");
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(x.tools.bash_bg, { command: "echo token=ghp_abcdefghijklmnopqrstuvwxyz0123" }, x.ctx);
  await waitFor(() => kinds(x, "exit").length === 1);
  const m = kinds(x, "exit")[0].msg.content;
  assert.match(m, /token=ghp_abcd\*\*\*/);
  const out = (await run(x.tools.bash_bg_output, { id: "bg1" }, x.ctx)).content[0].text;
  assert.doesNotMatch(out, /qrstuv/);
  assert.match(readFileSync(m.match(/log: (\S+)/)[1], "utf8"), /qrstuvwxyz0123/);
});

test("ok_codes turns an expected non-zero exit into success styling", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(x.tools.bash_bg, { command: "exit 2", ok_codes: [0, 2] }, x.ctx);
  await run(x.tools.bash_bg, { command: "exit 1", ok_codes: [0, 2] }, x.ctx);
  await waitFor(() => kinds(x, "exit").length === 2);
  const byId = (id: string) => kinds(x, "exit").find((s) => s.msg.details.id === id)!.msg;
  assert.equal(byId("bg1").details.ok, true);
  assert.match(byId("bg1").content, /exit 2 \(ok\) after/);
  assert.equal(byId("bg2").details.ok, false);
  assert.match(byId("bg2").content, /exit 1 \(failure\) after/);
  const theme = { fg: (c: string, t: string) => `<${c}>${t}`, bg: (_c: string, t: string) => t };
  const render = (msg: any) =>
    x.renderers["bg-bash"](msg, { expanded: true, outputPad: 0 }, theme).render(200).join("\n");
  assert.match(render(byId("bg1")), /<success>\[bg-bash\]/);
  assert.match(render(byId("bg2")), /<warning>\[bg-bash\]/);
});

test("jobs survive reload, re-attach, notify once, and ids keep counting", async () => {
  const dir = freshDir();
  const a = harness({ stateDir: dir, batchMs: 100, minGapMs: 0 });
  await a.h.session_start({}, a.ctx);
  await run(
    a.tools.bash_bg,
    {
      command: "echo one; sleep 1; echo EVENT two; sleep 0.5; exit 3",
      notify_on: "EVENT",
      label: "survivor",
    },
    a.ctx,
  );
  await run(a.tools.bash_bg, { command: "sleep 0.2; exit 5" }, a.ctx);
  await run(a.tools.bash_bg, { command: "echo scheduled-ran", at: "+1s" }, a.ctx);
  await a.h.session_shutdown({ reason: "reload" }, a.ctx);
  const reg = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
  const pid = reg.jobs.find((j: any) => j.id === "bg1").pid;
  assert.ok(pid);
  await sleep(500);
  process.kill(pid, 0);
  const b = harness({ stateDir: dir, batchMs: 100, minGapMs: 0 });
  await b.h.session_start({}, b.ctx);
  await waitFor(() => kinds(b, "exit").some((s) => s.msg.details.id === "bg2"));
  assert.match(kinds(b, "exit").find((s) => s.msg.details.id === "bg2")!.msg.content, /exit 5/);
  assert.match(b.status["bg-bash"]!, /survivor/);
  const started = await run(b.tools.bash_bg, { command: "true" }, b.ctx);
  assert.match(started.content[0].text, /Started bg4/);
  await waitFor(() => kinds(b, "exit").some((s) => s.msg.details.id === "bg1"), 6000);
  await waitFor(() => kinds(b, "exit").some((s) => s.msg.details.id === "bg3"), 6000);
  assert.match(kinds(b, "match")[0].msg.content, /> EVENT two/);
  assert.match(
    kinds(b, "exit").find((s) => s.msg.details.id === "bg1")!.msg.content,
    /bg1 \[exit 3[\s\S]*one\nEVENT two/,
  );
  assert.match(
    kinds(b, "exit").find((s) => s.msg.details.id === "bg3")!.msg.content,
    /scheduled-ran/,
  );
  assert.equal(a.sent.length, 0);
  await b.h.session_shutdown({ reason: "reload" }, b.ctx);
  const c = harness({ stateDir: dir });
  await c.h.session_start({}, c.ctx);
  await sleep(300);
  assert.equal(c.sent.length, 0);
  const listed = (await run(c.tools.bash_bg_output, {}, c.ctx)).content[0].text;
  assert.match(listed, /bg1 \[exit 3/);
  assert.match(
    (await run(c.tools.bash_bg, { command: "true" }, c.ctx)).content[0].text,
    /Started bg5/,
  );
  await c.h.session_shutdown({ reason: "quit" }, c.ctx);
});

test("quit kills jobs and kill reaches the whole process group after reload", async () => {
  const dir = freshDir();
  const a = harness({ stateDir: dir });
  await a.h.session_start({}, a.ctx);
  await run(a.tools.bash_bg, { command: "sleep 30 & sleep 30 & wait" }, a.ctx);
  await sleep(200);
  await a.h.session_shutdown({ reason: "reload" }, a.ctx);
  const b = harness({ stateDir: dir });
  await b.h.session_start({}, b.ctx);
  const pid = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8")).jobs[0].pid;
  await run(b.tools.bash_bg_kill, { id: "bg1" }, b.ctx);
  await waitFor(() => kinds(b, "exit").length === 1);
  assert.equal(kinds(b, "exit")[0].msg.details.state, "killed");
  await sleep(100);
  assert.throws(() => process.kill(-pid, 0));
  await run(b.tools.bash_bg, { command: "sleep 30" }, b.ctx);
  await sleep(200);
  const pid2 = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8")).jobs.find(
    (j: any) => j.id === "bg2",
  ).pid;
  await b.h.session_shutdown({ reason: "quit" }, b.ctx);
  await sleep(300);
  assert.throws(() => process.kill(-pid2, 0));
  assert.equal(kinds(b, "exit").length, 1);
});

for (const reason of ["quit", "new", "resume", "fork", undefined]) {
  test(`another session in the same process shutting down (${reason}) leaves our jobs alone`, async () => {
    const dir = freshDir();
    const mgr = harness({ stateDir: dir, sessionId: "manager" });
    await mgr.h.session_start({}, mgr.ctx);
    await run(mgr.tools.bash_bg, { command: "sleep 30", label: "watcher" }, mgr.ctx);
    await run(mgr.tools.bash_bg, { command: "true", at: "+1h" }, mgr.ctx);
    await sleep(200);
    const pid = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8")).jobs[0].pid;
    // e.g. an in-process subagent session that loads the same extension
    const child = harness({ stateDir: dir, sessionId: "subagent" });
    await child.h.session_start({}, child.ctx);
    const listed = (await run(child.tools.bash_bg_output, {}, child.ctx)).content[0].text;
    assert.match(listed, /No background jobs/);
    await child.h.session_shutdown(reason ? { reason } : {}, child.ctx);
    await sleep(300);
    process.kill(-pid, 0);
    const reg = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
    const states = Object.fromEntries(reg.jobs.map((j: any) => [j.id, j.state]));
    assert.deepEqual(states, { bg1: "running", bg2: "scheduled" });
    assert.equal(reg.jobs[0].killRequested, undefined);
    assert.equal(mgr.sent.length, 0);
    await mgr.h.session_shutdown({ reason: "quit" }, mgr.ctx);
    await sleep(200);
    assert.throws(() => process.kill(-pid, 0));
  });
}

test("concurrent instances never lose or duplicate jobs in the registry", async () => {
  const dir = freshDir();
  const xs = [0, 1, 2].map((i) => harness({ stateDir: dir, sessionId: `s${i}` }));
  for (const x of xs) await x.h.session_start({}, x.ctx);
  await Promise.all(
    xs.flatMap((x) =>
      Array.from({ length: 8 }, () => run(x.tools.bash_bg, { command: "true", at: "+1h" }, x.ctx)),
    ),
  );
  const reg = JSON.parse(readFileSync(join(dir, "jobs.json"), "utf8"));
  const ids = reg.jobs.map((j: any) => j.id);
  assert.equal(ids.length, 24);
  assert.equal(new Set(ids).size, 24);
  for (const x of xs) await x.h.session_shutdown({ reason: "quit" }, x.ctx);
});

test("an external signal is recorded instead of 'lost (no exit code)'", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  await run(x.tools.bash_bg, { command: "echo up; sleep 30" }, x.ctx);
  await sleep(300);
  const pid = JSON.parse(readFileSync(join(x.stateDir, "jobs.json"), "utf8")).jobs[0].pid;
  process.kill(-pid, "SIGINT");
  await waitFor(() => kinds(x, "exit").length === 1);
  const m = kinds(x, "exit")[0].msg;
  assert.equal(m.details.state, "killed");
  assert.match(m.content, /SIGINT/);
});

test("yield_ms returns output and exit code of a fast job without a later message", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  const r = await run(
    x.tools.bash_bg,
    { command: "echo hi; echo there; exit 2", yield_ms: 5000 },
    x.ctx,
  );
  assert.match(r.content[0].text, /bg1 \[exit 2 after/);
  assert.match(r.content[0].text, /hi\nthere/);
  assert.equal(r.details.exitCode, 2);
  assert.equal(r.details.state, "exited");
  await sleep(300);
  assert.equal(x.sent.length, 0);
  assert.match((await run(x.tools.bash_bg_output, {}, x.ctx)).content[0].text, /bg1 \[exit 2/);
});

test("yield_ms returns partial output for a slow job and notifies on exit", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  const r = await run(
    x.tools.bash_bg,
    { command: "echo early; sleep 2; echo done", yield_ms: 300 },
    x.ctx,
  );
  assert.match(r.content[0].text, /Started bg1/);
  assert.match(r.content[0].text, /continues in the background/);
  assert.match(r.content[0].text, /early/);
  assert.equal(r.details.state, "running");
  await waitFor(() => kinds(x, "exit").length === 1, 5000);
  assert.match(kinds(x, "exit")[0].msg.content, /early\ndone/);
});

test("yield_ms rejects invalid values and incompatible options", async () => {
  const x = harness();
  await x.h.session_start({}, x.ctx);
  for (const yield_ms of [0, -1, 60_001, Number.NaN])
    await assert.rejects(run(x.tools.bash_bg, { command: "true", yield_ms }, x.ctx), /yield_ms/);
  await assert.rejects(
    run(x.tools.bash_bg, { command: "true", yield_ms: 1000, wait_until: true }, x.ctx),
    /wait_until/,
  );
  await assert.rejects(
    run(x.tools.bash_bg, { command: "true", yield_ms: 1000, at: "+1m" }, x.ctx),
    /at/,
  );
  assert.match(
    (await run(x.tools.bash_bg_output, {}, x.ctx)).content[0].text,
    /No background jobs/,
  );
});
