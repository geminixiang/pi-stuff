import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage } from "../src/net/protocol.ts";
import { HostRoom } from "../src/net/host.ts";
import { RoomClient, type RoomClientOptions } from "../src/net/client.ts";

function connect(port: number, playerId: string, displayName: string, extra: Partial<RoomClientOptions> = {}): Promise<RoomClient> {
	return new Promise<RoomClient>((resolve) => {
		const client = new RoomClient({
			url: `ws://127.0.0.1:${port}`,
			playerId,
			displayName,
			onWelcome: () => resolve(client),
			onState: () => {},
			onChatMessage: () => {},
			onChatHistory: () => {},
			onRejected: () => resolve(client),
			onClose: () => {},
			...extra,
		});
	});
}

test("a client's chat message is broadcast to the host and other clients", async () => {
	const hostChat: ChatMessage[] = [];
	const host = new HostRoom({
		port: 0,
		seatCount: 4,
		smallBlind: 5,
		bigBlind: 10,
		startingStack: 500,
		onStateChange: () => {},
		onChatMessage: (msg) => hostChat.push(msg),
	});
	const port = await host.waitForListening();
	host.seatLocalPlayer(0, "host-id", "host-machine");

	const guestChat: ChatMessage[] = [];
	let guest: RoomClient | undefined;
	let watcher: RoomClient | undefined;
	try {
		guest = await connect(port, "guest-id", "guest-machine");
		watcher = await new Promise<RoomClient>((resolve) => {
			const client = new RoomClient({
				url: `ws://127.0.0.1:${port}`,
				playerId: "watcher-id",
				displayName: "watcher-machine",
				onWelcome: () => resolve(client),
				onState: () => {},
				onChatMessage: (msg) => guestChat.push(msg),
				onChatHistory: () => {},
				onRejected: () => resolve(client),
				onClose: () => {},
			});
		});

		guest.sendChat("nice hand!");
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(hostChat.at(-1)?.text, "nice hand!");
		assert.equal(hostChat.at(-1)?.displayName, "guest-machine");
		assert.equal(guestChat.at(-1)?.text, "nice hand!", "a third party at the table also receives it");
	} finally {
		guest?.close();
		watcher?.close();
		host.close();
	}
});

test("chat text is sanitized before it ever reaches other clients", async () => {
	const hostChat: ChatMessage[] = [];
	const host = new HostRoom({
		port: 0,
		seatCount: 2,
		smallBlind: 5,
		bigBlind: 10,
		startingStack: 500,
		onStateChange: () => {},
		onChatMessage: (msg) => hostChat.push(msg),
	});
	const port = await host.waitForListening();
	host.seatLocalPlayer(0, "host-id", "host-machine");

	let guest: RoomClient | undefined;
	try {
		guest = await connect(port, "guest-id", "guest-machine");
		guest.sendChat("\x1B[31mnormal text\x1B[0m\nwith a fake newline");
		await new Promise((r) => setTimeout(r, 50));

		assert.equal(hostChat.at(-1)?.text, "normal text with a fake newline");
	} finally {
		guest?.close();
		host.close();
	}
});

test("a newly joined client receives recent chat history", async () => {
	const host = new HostRoom({
		port: 0,
		seatCount: 3,
		smallBlind: 5,
		bigBlind: 10,
		startingStack: 500,
		onStateChange: () => {},
	});
	const port = await host.waitForListening();
	host.seatLocalPlayer(0, "host-id", "host-machine");
	host.sendLocalChat(0, "welcome to the table");

	let guest: RoomClient | undefined;
	try {
		let historyResolve: (msgs: ChatMessage[]) => void = () => {};
		const historyPromise = new Promise<ChatMessage[]>((resolve) => {
			historyResolve = resolve;
		});
		guest = await connect(port, "guest-id", "guest-machine", { onChatHistory: (msgs) => historyResolve(msgs) });
		const history = await historyPromise;

		assert.ok(history.some((m) => m.text === "welcome to the table"));
	} finally {
		guest?.close();
		host.close();
	}
});

test("rapid chat messages from the same client are rate-limited without rejecting the session", async () => {
	const hostChat: ChatMessage[] = [];
	const clientErrors: string[] = [];
	let rejectionCount = 0;
	const host = new HostRoom({
		port: 0,
		seatCount: 2,
		smallBlind: 5,
		bigBlind: 10,
		startingStack: 500,
		onStateChange: () => {},
		onChatMessage: (msg) => hostChat.push(msg),
	});
	const port = await host.waitForListening();
	host.seatLocalPlayer(0, "host-id", "host-machine");

	let guest: RoomClient | undefined;
	try {
		guest = await connect(port, "guest-id", "guest-machine", {
			onError: (message) => clientErrors.push(message),
			onRejected: () => rejectionCount++,
		});
		guest.sendChat("first");
		guest.sendChat("second, immediately after");
		await new Promise((r) => setTimeout(r, 50));

		const fromGuest = hostChat.filter((m) => m.displayName === "guest-machine");
		assert.equal(fromGuest.length, 1, "the second message within the rate-limit window is dropped");
		assert.equal(fromGuest[0]?.text, "first");
		assert.deepEqual(clientErrors, ["You're sending messages too fast"]);
		assert.equal(rejectionCount, 0);
		assert.equal(host.seatedCount(), 2, "a nonfatal chat error keeps the client seated");
	} finally {
		guest?.close();
		host.close();
	}
});

test("host chat identifiers and timestamps can use runtime-provided sources", () => {
	const messages: ChatMessage[] = [];
	const host = new HostRoom({
		port: 0,
		seatCount: 2,
		smallBlind: 5,
		bigBlind: 10,
		startingStack: 500,
		onStateChange: () => {},
		onChatMessage: (message) => messages.push(message),
		createMessageId: () => "message-id",
		now: () => 123,
	});
	try {
		host.seatLocalPlayer(0, "host", "host");
		host.sendLocalChat(0, "hello");
		assert.equal(messages.at(-1)?.id, "message-id");
		assert.equal(messages.at(-1)?.ts, 123);
	} finally {
		host.close();
	}
});

test("game actions are mirrored into chat as system messages", async () => {
	const state: ChatMessage[] = [];
	const host = new HostRoom({
		port: 0,
		seatCount: 2,
		smallBlind: 5,
		bigBlind: 10,
		startingStack: 500,
		onStateChange: () => {},
		onChatMessage: (msg) => state.push(msg),
	});
	host.seatLocalPlayer(0, "a", "a");
	host.seatLocalPlayer(1, "b", "b");
	host.startHand();

	assert.ok(state.some((m) => m.seatIndex === null && /posts (small|big) blind/.test(m.text)));

	host.close();
});
