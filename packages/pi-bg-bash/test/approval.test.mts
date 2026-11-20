import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBgBash } from "../extensions/index.ts";
import { riskyCommand } from "../extensions/lib.ts";

const freshDir = () => mkdtempSync(join(tmpdir(), "bg-approval-"));

function harness(opts: { confirm?: () => Promise<boolean>; stateDir?: string; approvalTimeoutMs?: number } = {}) {
  const h: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const cmds: Record<string, any> = {};
  const confirms: string[] = [];
  const pi: any = {
    on: (n: string, f: Function) => (h[n] = f),
    registerTool: (t: any) => (tools[t.name] = t),
    registerCommand: (n: string, c: any) => (cmds[n] = c),
    sendMessage() {},
    registerMessageRenderer() {},
  };
  const dir = freshDir();
  const stateDir = opts.stateDir ?? freshDir();
  const ctx: any = {
    cwd: dir,
    sessionManager: { getSessionId: () => "s" },
    isIdle: () => true,
    ui: {
      setStatus() {},
      notify() {},
      ...(opts.confirm
        ? {
            confirm: async (title: string, message: string) => {
              confirms.push(`${title}\n${message}`);
              return opts.confirm!();
            },
          }
        : {}),
    },
  };
  createBgBash({ stateDir, approvalTimeoutMs: opts.approvalTimeoutMs })(pi);
  return { h, tools, cmds, ctx, dir, confirms, stateDir };
}

const run = (t: any, params: any, ctx: any) => t.execute("call", params, undefined, undefined, ctx);

test("risky patterns and temp-dir exception", () => {
  const cwd = "/work";
  assert.equal(riskyCommand("rm -rf tmp/cache", cwd), "rm -rf");
  assert.equal(riskyCommand("rm -rf .", cwd), "rm -rf");
  assert.equal(riskyCommand("rm -rf /", cwd), "rm -rf");
  assert.equal(riskyCommand("rm file", cwd), null);
  assert.equal(riskyCommand("git push --force origin HEAD", cwd), "git push --force");
  assert.equal(riskyCommand("git -C project push -f origin main", cwd), "git push --force");
  assert.equal(riskyCommand("git push origin HEAD", cwd), null);
  assert.equal(riskyCommand("git reset --hard HEAD", cwd), "git reset --hard");
  assert.equal(riskyCommand("dd if=/dev/zero of=disk.img", cwd), "dd");
  assert.equal(riskyCommand("mkfs.ext4 /dev/sdb", cwd), "mkfs");
  assert.equal(riskyCommand("chmod -R 777 .", cwd), "chmod -R");
  assert.equal(riskyCommand("echo hello", cwd), null);
  const tmp = join(tmpdir(), "bg-approval-safe");
  assert.equal(riskyCommand(`rm -rf ${tmp}/cache`, cwd), null);
  assert.equal(riskyCommand(`rm -rf ${tmpdir()}`, cwd), "rm -rf");
  assert.equal(riskyCommand(`rm -rf ${tmp}/cache && rm -rf /etc`, cwd), "rm -rf");
  assert.equal(riskyCommand("chmod --recursive a+r .", cwd), "chmod -R");
});

test("deny runs nothing and approve runs the command", async () => {
  const deny = harness({ confirm: async () => false });
  writeFileSync(join(deny.dir, "keep.txt"), "keep");
  mkdirSync(join(deny.dir, "cache"));
  writeFileSync(join(deny.dir, "cache", "old.txt"), "x");
  const denied = await run(deny.tools.bash_bg, { command: "rm -rf cache" }, deny.ctx);
  assert.equal(denied.details.approval, "deny");
  assert.equal(existsSync(join(deny.dir, "cache", "old.txt")), true);
  const reg = JSON.parse(readFileSync(join(deny.stateDir!, "jobs.json"), "utf8"));
  assert.equal(reg.jobs[0].state, "killed");
  assert.equal(reg.jobs[0].pid, undefined);

  const ok = harness({ confirm: async () => true, stateDir: deny.stateDir });
  const approved = await run(ok.tools.bash_bg, { command: "rm -rf cache" }, { ...deny.ctx, ui: ok.ctx.ui });
  assert.equal(approved.details.approval, "approve");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(existsSync(join(deny.dir, "cache")), false);
  assert.equal(existsSync(join(deny.dir, "keep.txt")), true);
});

test("timeout denies", async () => {
  const x = harness({
    confirm: () => new Promise(() => {}),
    approvalTimeoutMs: 30,
  });
  writeFileSync(join(x.dir, "keep.txt"), "keep");
  const result = await run(x.tools.bash_bg, { command: "rm -rf keep.txt" }, x.ctx);
  assert.equal(result.details.approval, "deny");
  assert.equal(existsSync(join(x.dir, "keep.txt")), true);
});

test("headless approval survives reload and runs only after approve", async () => {
  const dir = freshDir();
  const stateDir = freshDir();
  const boot = (id: string) => {
    const h: Record<string, Function> = {};
    const tools: Record<string, any> = {};
    const pi: any = {
      on: (n: string, f: Function) => (h[n] = f),
      registerTool: (t: any) => (tools[t.name] = t),
      registerCommand() {},
      sendMessage() {},
      registerMessageRenderer() {},
    };
    const ctx: any = {
      cwd: dir,
      sessionManager: { getSessionId: () => id },
      isIdle: () => true,
      ui: { setStatus() {}, notify() {} },
    };
    createBgBash({ stateDir })(pi);
    return { h, tools, ctx };
  };
  writeFileSync(join(dir, "victim"), "x");
  const a = boot("same");
  await a.h.session_start({}, a.ctx);
  const pending = await run(a.tools.bash_bg, { command: "rm -rf victim" }, a.ctx);
  assert.equal(pending.details.state, "waiting_for_approval");
  assert.equal(existsSync(join(dir, "victim")), true);
  const saved = JSON.parse(readFileSync(join(stateDir, "jobs.json"), "utf8"));
  assert.equal(saved.jobs[0].state, "waiting_for_approval");
  await a.h.session_shutdown({ reason: "reload" }, a.ctx);

  const b = boot("same");
  await b.h.session_start({}, b.ctx);
  const listed = await run(b.tools.bash_bg_output, {}, b.ctx);
  assert.match(listed.content[0].text, /waiting for approval/);
  assert.equal(existsSync(join(dir, "victim")), true);
  const approved = await run(b.tools.bash_bg_approve, { id: "bg1", approve: true }, b.ctx);
  assert.equal(approved.details.approval, "approve");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(existsSync(join(dir, "victim")), false);
});

test("approval off runs a risky command immediately", async () => {
  const previous = process.env.PI_BG_BASH_APPROVAL;
  process.env.PI_BG_BASH_APPROVAL = "off";
  try {
    const x = harness({ confirm: async () => false });
    writeFileSync(join(x.dir, "victim"), "x");
    const result = await run(x.tools.bash_bg, { command: "rm -rf victim" }, x.ctx);
    assert.equal(result.details.approval, undefined);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(existsSync(join(x.dir, "victim")), false);
    assert.equal(x.confirms.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_BG_BASH_APPROVAL;
    else process.env.PI_BG_BASH_APPROVAL = previous;
  }
});
