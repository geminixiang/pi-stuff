import assert from "node:assert/strict";
import test from "node:test";
import { HostRoom } from "../src/net/host.ts";
import { RoomClient } from "../src/net/client.ts";

function once<T>(fn: (resolve: (value: T) => void) => void): Promise<T> {
	return new Promise((resolve) => fn(resolve));
}

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
