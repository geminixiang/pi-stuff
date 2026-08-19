import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { HostRoom } from "../src/net/host.ts";
import { RoomClient } from "../src/net/client.ts";
import { encode, decodeClientMessage } from "../src/net/protocol.ts";
import { createJoinSession } from "../src/session/join.ts";

function once<T>(fn: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise((resolve) => fn(resolve));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

test("creator capability is sent only in hello, never the socket URL or session label", async () => {
	const server = new WebSocketServer({ port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	assert.equal(typeof address, "object");
	const port = typeof address === "object" && address ? address.port : 0;
	const capability = "creator-secret-capability";
	let requestPath = "";
	const helloPromise = once<ReturnType<typeof decodeClientMessage>>((resolve) => {
		server.once("connection", (socket, request) => {
			requestPath = request.url ?? "";
			socket.once("message", (raw) => resolve(decodeClientMessage(raw.toString())));
		});
	});

	const session = createJoinSession(
		{
			url: `ws://127.0.0.1:${port}/rooms/test?id=invite&creator=${capability}`,
			myId: "creator-id",
			displayName: "creator",
			canStartHands: true,
		},
		() => {},
	);
	try {
		assert.equal(session.info.roomLabel, `Connected to ws://127.0.0.1:${port}/rooms/test?id=invite`);
		assert.equal(session.info.roomLabel.includes(capability), false);
		const hello = await helloPromise;
		assert.equal(requestPath, "/rooms/test?id=invite");
		assert.equal(requestPath.includes("creator"), false);
		assert.equal(hello.type, "hello");
		assert.equal(hello.type === "hello" ? hello.creatorCapability : undefined, capability);
	} finally {
		session.close();
		server.close();
	}
});

test("a remote client can join a hosted room and see redacted state", async () => {
	const host = new HostRoom({
		port: 0,
		seatCount: 4,
		smallBlind: 5,
		bigBlind: 10,
		startingStack: 500,
		onStateChange: () => {},
	});
	const port = await host.waitForListening();
	host.seatLocalPlayer(0, "host-id", "host-machine");

	let client: RoomClient | undefined;
	try {
		const welcome = await once<{ seatIndex: number; seatCount: number }>((resolve) => {
			client = new RoomClient({
				url: `ws://127.0.0.1:${port}`,
				playerId: "guest-id",
				displayName: "guest-machine",
				onWelcome: (info) => resolve(info),
				onState: () => {},
				onChatMessage: () => {},
				onChatHistory: () => {},
				onRejected: (reason, message) => assert.fail(`unexpected rejection: ${reason} ${message ?? ""}`),
				onClose: () => {},
			});
		});

		assert.equal(welcome.seatIndex, 1, "guest takes the next open seat after the host");
		assert.equal(welcome.seatCount, 4);
		assert.equal(host.seatedCount(), 2);
	} finally {
		client?.close();
		host.close();
	}
});

test("heads-up client disconnect settles the hand in-turn and out-of-turn", async (t) => {
	for (const timing of ["out-of-turn", "in-turn"] as const) {
		await t.test(timing, async () => {
			const host = new HostRoom({
				port: 0,
				seatCount: 2,
				smallBlind: 5,
				bigBlind: 10,
				startingStack: 500,
				onStateChange: () => {},
			});
			const port = await host.waitForListening();
			host.seatLocalPlayer(0, "host-id", "host-machine");
			let client: RoomClient | undefined;
			try {
				await once<void>((resolve) => {
					client = new RoomClient({
						url: `ws://127.0.0.1:${port}`,
						playerId: "guest-id",
						displayName: "guest-machine",
						onWelcome: () => resolve(),
						onState: () => {},
						onChatMessage: () => {},
						onChatHistory: () => {},
						onRejected: (reason, message) => assert.fail(`unexpected rejection: ${reason} ${message ?? ""}`),
						onClose: () => {},
					});
				});
				host.startHand();
				const guestIndex = host.state.seats.findIndex((seat) => seat?.id === "guest-id");
				assert.equal(guestIndex, 1);
				if (timing === "in-turn") {
					assert.equal(host.state.toActIndex, 0);
					host.applyLocalAction(0, { type: "call" });
					assert.equal(host.state.toActIndex, guestIndex);
				} else {
					assert.notEqual(host.state.toActIndex, guestIndex);
				}

				client!.close();
				await waitFor(() => host.state.street === "showdown" && host.seatedCount() === 1, "disconnect did not settle the hand");
				assert.equal(host.state.toActIndex, null);
				assert.ok(host.state.log.some((line) => line === "guest-machine folds"));
			} finally {
				client?.close();
				host.close();
			}
		});
	}
});

test("server errors reject before welcome but are nonfatal after welcome", async (t) => {
	await t.test("an error before welcome rejects the handshake", async () => {
		const server = new WebSocketServer({ port: 0 });
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		assert.equal(typeof address, "object");
		const port = typeof address === "object" && address ? address.port : 0;
		server.on("connection", (socket) => socket.send(encode({ type: "error", message: "Handshake failed" })));

		let client: RoomClient | undefined;
		try {
			const rejection = await once<string>((resolve) => {
				client = new RoomClient({
					url: `ws://127.0.0.1:${port}`,
					playerId: "guest-id",
					displayName: "guest-machine",
					onWelcome: () => assert.fail("unexpected welcome"),
					onState: () => {},
					onChatMessage: () => {},
					onChatHistory: () => {},
					onRejected: (_reason, message) => resolve(message ?? ""),
					onError: (message) => assert.fail(`unexpected in-session error: ${message}`),
					onClose: () => {},
				});
			});
			assert.equal(rejection, "Handshake failed");
		} finally {
			client?.close();
			server.close();
		}
	});

	await t.test("an action error after welcome uses the nonfatal callback", async () => {
		const host = new HostRoom({
			port: 0,
			seatCount: 2,
			smallBlind: 5,
			bigBlind: 10,
			startingStack: 500,
			onStateChange: () => {},
		});
		const port = await host.waitForListening();
		host.seatLocalPlayer(0, "host-id", "host-machine");
		let client: RoomClient | undefined;
		let rejectionCount = 0;
		try {
			const errorPromise = once<string>((resolve) => {
				client = new RoomClient({
					url: `ws://127.0.0.1:${port}`,
					playerId: "guest-id",
					displayName: "guest-machine",
					onWelcome: () => {
						host.startHand();
						client!.sendAction({ type: "check" });
					},
					onState: () => {},
					onChatMessage: () => {},
					onChatHistory: () => {},
					onRejected: () => rejectionCount++,
					onError: resolve,
					onClose: () => {},
				});
			});
			assert.match(await errorPromise, /not this seat's turn/);
			assert.equal(rejectionCount, 0);
			assert.equal(host.seatedCount(), 2, "nonfatal action errors keep the welcomed client seated");
		} finally {
			client?.close();
			host.close();
		}
	});
});

test("actions from a connected client update the host's authoritative state", async () => {
	const stateUpdates: number[] = [];
	const host = new HostRoom({
		port: 0,
		seatCount: 2,
		smallBlind: 5,
		bigBlind: 10,
		startingStack: 500,
		onStateChange: (state) => stateUpdates.push(state.handNumber),
	});
	const port = await host.waitForListening();
	host.seatLocalPlayer(0, "host-id", "host-machine");

	let client: RoomClient | undefined;
	try {
		await once<void>((resolve) => {
			client = new RoomClient({
				url: `ws://127.0.0.1:${port}`,
				playerId: "guest-id",
				displayName: "guest-machine",
				onWelcome: () => resolve(),
				onState: () => {},
				onChatMessage: () => {},
				onChatHistory: () => {},
				onRejected: () => resolve(),
				onClose: () => {},
			});
		});

		assert.ok(host.canStartHand());
		host.startHand();

		const guestSeatIndex = host.state.seats.findIndex((s) => s?.id === "guest-id");
		assert.notEqual(guestSeatIndex, -1);

		// Drive the hand to completion using whichever seat is actually up first.
		let guard = 0;
		while (host.state.street !== "showdown" && guard < 50) {
			guard++;
			const toAct = host.state.toActIndex;
			if (toAct === null) break;
			const seat = host.state.seats[toAct]!;
			const toCall = host.state.currentBet - seat.committed;
			const action = toCall > 0 ? ({ type: "call" } as const) : ({ type: "check" } as const);
			if (toAct === guestSeatIndex) {
				client!.sendAction(action);
				await new Promise((r) => setTimeout(r, 20));
			} else {
				host.applyLocalAction(toAct, action);
			}
		}

		assert.equal(host.state.street, "showdown");
	} finally {
		client?.close();
		host.close();
	}
});
