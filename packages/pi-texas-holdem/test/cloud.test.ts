import assert from "node:assert/strict";
import test from "node:test";
import { createPersonalRoom } from "../src/ui/cloud.ts";

test("creates a private room with telemetry off and keeps the creation secret out of URLs", async () => {
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	const room = await createPersonalRoom(
		{ endpoint: "https://cards.example/", creationSecret: "super-secret" },
		{},
		async (input, init) => {
			requestUrl = String(input);
			requestInit = init;
			return Response.json({
				url: "wss://cards.example/rooms/invite",
				creatorUrl: "wss://cards.example/rooms/invite?creator=creator-token",
				expiresAt: 123,
			}, { status: 201 });
		},
	);

	assert.equal(requestUrl, "https://cards.example/rooms");
	assert.equal(requestUrl.includes("super-secret"), false);
	assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer super-secret");
	assert.deepEqual(JSON.parse(String(requestInit?.body)), {
		seatCount: 6,
		smallBlind: 10,
		bigBlind: 20,
		startingStack: 2000,
		telemetry: false,
	});
	assert.deepEqual(room, {
		shareUrl: "wss://cards.example/rooms/invite",
		creatorUrl: "wss://cards.example/rooms/invite?creator=creator-token",
		expiresAt: 123,
	});
});

test("supports a separate capability response while preserving the share URL", async () => {
	const room = await createPersonalRoom(
		{ endpoint: "https://cards.example" },
		{},
		async () => Response.json({ url: "wss://cards.example/rooms/invite", capability: "a b" }, { status: 201 }),
	);
	assert.equal(room.shareUrl, "wss://cards.example/rooms/invite");
	assert.equal(room.creatorUrl, "wss://cards.example/rooms/invite?creator=a+b");
});

test("creation auth failures are actionable and never echo the secret", async () => {
	await assert.rejects(
		createPersonalRoom(
			{ endpoint: "https://cards.example", creationSecret: "do-not-echo" },
			{},
			async () => Response.json({ error: "denied do-not-echo" }, { status: 403 }),
		),
		(error: Error) => {
			assert.match(error.message, /PI_POKER_CREATE_SECRET/);
			assert.equal(error.message.includes("do-not-echo"), false);
			return true;
		},
	);
});
