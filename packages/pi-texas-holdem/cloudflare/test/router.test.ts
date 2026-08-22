import assert from "node:assert/strict";
import test from "node:test";
import { route } from "../src/router.ts";
import type { Env } from "../src/types.ts";

const CREATE_SECRET = "test-only-creation-secret";

function fakeEnv(handler: (request: Request) => Response | Promise<Response>) {
	const names: string[] = [];
	const namespace = {
		idFromName(name: string) {
			names.push(name);
			return { toString: () => name };
		},
		get() {
			return {
				fetch(input: RequestInfo | URL, init?: RequestInit) {
					return handler(input instanceof Request ? input : new Request(input, init));
				},
			};
		},
	} as unknown as DurableObjectNamespace;
	return { env: { POKER_ROOMS: namespace, CREATE_ROOM_SECRET: CREATE_SECRET } as Env, names };
}

function createRequest(body = "{}", authorization = `Bearer ${CREATE_SECRET}`): Request {
	return new Request("https://cards.example/rooms", {
		method: "POST",
		headers: { "content-type": "application/json", authorization },
		body,
	});
}

test("health route does not touch Durable Objects", async () => {
	const { env, names } = fakeEnv(() => new Response());
	const response = await route(new Request("https://example.test/health"), env);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { ok: true });
	assert.deepEqual(names, []);
});

test("room creation requires the deployer's bearer secret", async () => {
	const { env, names } = fakeEnv(() => assert.fail("unauthorized request reached a Durable Object"));
	assert.equal((await route(createRequest("{}", ""), env)).status, 401);
	assert.equal((await route(createRequest("{}", "Bearer wrong"), env)).status, 401);
	assert.deepEqual(names, []);
});

test("create returns separate guest and creator URLs and initializes its room", async () => {
	let forwarded: Request | undefined;
	const { env, names } = fakeEnv((request) => {
		forwarded = request;
		return Response.json({ expiresAt: 1234 }, { status: 201 });
	});
	const response = await route(createRequest(JSON.stringify({ seatCount: 4, telemetry: true })), env);
	const result = (await response.json()) as { roomId: string; url: string; creatorUrl: string; expiresAt: number };
	assert.equal(response.status, 201);
	assert.match(result.roomId, /^[a-f0-9-]{36}$/);
	assert.equal(result.url, `wss://cards.example/rooms/${result.roomId}`);
	const creatorUrl = new URL(result.creatorUrl);
	assert.equal(`${creatorUrl.origin}${creatorUrl.pathname}`, `wss://cards.example/rooms/${result.roomId}`);
	assert.match(creatorUrl.searchParams.get("creator") ?? "", /^[a-f0-9]{64}$/);
	assert.deepEqual(names, [result.roomId]);
	assert.equal(forwarded?.url, "https://room.internal/create");
	const initialization = (await forwarded?.json()) as {
		config: { telemetryEnabled: boolean };
		creatorCapability: string;
	};
	assert.equal(initialization.config.telemetryEnabled, true);
	assert.equal(initialization.creatorCapability, creatorUrl.searchParams.get("creator"));
	assert.equal(JSON.stringify(result).includes(initialization.creatorCapability), true, "capability appears only in creator URL");
	assert.equal(result.url.includes("creator="), false, "guest URL does not grant host authority");
});

test("room URL forwards only GET/HEAD and malformed authorized JSON is rejected", async () => {
	const { env } = fakeEnv(() => new Response("upgrade here", { status: 426 }));
	const roomId = "00000000-0000-4000-8000-000000000000";
	assert.equal((await route(new Request(`https://x.test/rooms/${roomId}`), env)).status, 426);
	assert.equal((await route(new Request(`https://x.test/rooms/${roomId}`, { method: "DELETE" }), env)).status, 404);
	assert.equal((await route(createRequest("{"), env)).status, 400);
});
