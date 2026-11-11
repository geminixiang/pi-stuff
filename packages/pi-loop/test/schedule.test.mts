import { test, mock } from "node:test";
import assert from "node:assert/strict";
import ext from "../extensions/index.ts";

function harness() {
	const h: Record<string, Function> = {}, tools: Record<string, any> = {}, cmds: Record<string, any> = {};
	const sent: string[] = [];
	const st = { idle: true, pending: false };
	const pi: any = {
		on: (n: string, f: Function) => (h[n] = f),
		registerTool: (t: any) => (tools[t.name] = t),
		registerCommand: (n: string, c: any) => (cmds[n] = c),
		appendEntry: () => {},
		sendUserMessage: (m: string) => { sent.push(m); st.idle = false; },
	};
	const ctx: any = {
		isIdle: () => st.idle, hasPendingMessages: () => st.pending,
		ui: { setStatus() {}, notify() {} }, cwd: "/tmp",
		sessionManager: { getBranch: () => [] },
	};
	ext(pi);
	h.session_start({}, ctx);
	const endRun = () => { st.idle = true; h.agent_end({}, ctx); };
	return { tools, cmds, sent, st, ctx, h, endRun };
}
const M = 60_000;

test("fires when due, waits while busy, catches up after agent_end", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const t = harness();
	await t.tools.loop_create.execute("x", { prompt: "ping", interval: "5m" });
	mock.timers.tick(1); assert.equal(t.sent.length, 1, "first run immediately");
	t.endRun(); mock.timers.tick(2000);
	mock.timers.tick(5 * M); assert.equal(t.sent.length, 2, "second at +5m");
	// user turn running when due
	t.endRun(); mock.timers.tick(2000); t.st.idle = false;
	mock.timers.tick(5 * M); assert.equal(t.sent.length, 2, "not while busy");
	t.endRun(); mock.timers.tick(2000); assert.equal(t.sent.length, 3, "fires after agent_end");
	mock.timers.reset();
});

test("safety net: busy ends without agent_end", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const t = harness(); t.st.idle = false;
	await t.tools.loop_create.execute("x", { prompt: "p", interval: "1m" });
	mock.timers.tick(1); assert.equal(t.sent.length, 0);
	t.st.idle = true; // no agent_end
	mock.timers.tick(60_000); assert.equal(t.sent.length, 1, "retry picked it up");
	mock.timers.reset();
});

test("timer callback errors don't escape", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const t = harness();
	t.ctx.isIdle = () => { throw new Error("stale ctx"); };
	await t.tools.loop_create.execute("x", { prompt: "p", interval: "1m" });
	assert.doesNotThrow(() => mock.timers.tick(1));
	mock.timers.reset();
});

test("overrun run doesn't fire back-to-back; shutdown stops everything", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const t = harness();
	await t.tools.loop_create.execute("x", { prompt: "p", interval: "2m" });
	mock.timers.tick(1); assert.equal(t.sent.length, 1);
	mock.timers.tick(10 * M); t.endRun(); mock.timers.tick(2000);
	assert.equal(t.sent.length, 1, "gap after overrun");
	mock.timers.tick(2 * M); assert.equal(t.sent.length, 2);
	t.h.session_shutdown({}, t.ctx); t.endRun();
	mock.timers.tick(60 * M); assert.equal(t.sent.length, 2, "nothing after shutdown");
	mock.timers.reset();
});

test("/loop sends a refine turn; --raw schedules verbatim", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const t = harness();
	await t.cmds.loop.handler("10m check CI", t.ctx);
	assert.equal(t.sent.length, 1);
	assert.match(t.sent[0], /\[pi-loop\][\s\S]*check CI[\s\S]*interval "10m"/);
	assert.equal((await t.tools.loop_list.execute()).content[0].text, "No loops.", "nothing scheduled until agent calls loop_create");
	t.endRun();
	await t.cmds.loop.handler("--raw 10m check CI", t.ctx);
	assert.match((await t.tools.loop_list.execute()).content[0].text, /every 10m .* check CI/);
	mock.timers.reset();
});

test("loop_update keeps id/runs; /loop edit sends an edit turn", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const t = harness();
	const { details } = await t.tools.loop_create.execute("x", { prompt: "old", interval: "10m" });
	mock.timers.tick(1); t.endRun();
	await t.tools.loop_update.execute("x", { id: details.id, prompt: "new", interval: "15m" });
	const full = (await t.tools.loop_list.execute("x", { id: details.id })).content[0].text;
	assert.match(full, new RegExp(`${details.id}  every 15m .*runs=1`));
	assert.match(full, /<prompt>\nnew\n<\/prompt>/);
	await t.cmds.loop.handler("edit 別再貼完整 log", t.ctx); // single loop: id optional
	assert.match(t.sent.at(-1)!, new RegExp(`Improve loop ${details.id}[\\s\\S]*別再貼完整 log`));
	mock.timers.reset();
});

test("a fired fixed loop is not fired again right after reload", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const entries: any[] = [];
	const boot = () => {
		const h: Record<string, Function> = {}, tools: Record<string, any> = {};
		const sent: string[] = [];
		const st = { idle: true };
		const pi: any = {
			on: (n: string, f: Function) => (h[n] = f),
			registerTool: (t: any) => (tools[t.name] = t),
			registerCommand: () => {},
			appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
			sendUserMessage: (m: string) => { sent.push(m); st.idle = false; },
		};
		const ctx: any = {
			isIdle: () => st.idle, hasPendingMessages: () => false,
			ui: { setStatus() {}, notify() {} }, cwd: "/tmp",
			sessionManager: { getBranch: () => entries },
		};
		ext(pi);
		h.session_start({}, ctx);
		return { h, tools, sent, st, ctx };
	};
	const a = boot();
	await a.tools.loop_create.execute("x", { prompt: "weekly", interval: "7d" });
	mock.timers.tick(1);
	assert.equal(a.sent.length, 1);
	a.h.session_shutdown({});
	mock.timers.tick(60 * M);
	const b = boot();
	mock.timers.tick(5 * M);
	assert.equal(b.sent.length, 0, "not fired again after reload");
	const list = await b.tools.loop_list.execute("x", {});
	assert.match(JSON.stringify(list), /runs=1/);
	mock.timers.reset();
});
