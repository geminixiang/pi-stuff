import assert from "node:assert/strict";
import test from "node:test";
import { forceFold, seatPlayer, startHand, createTable } from "@geminixiang/pi-texas-holdem/src/engine/table.ts";
import {
	assertCreatorCanStartHand,
	canAcceptConnection,
	handshakeDeadline,
	HANDSHAKE_TIMEOUT_MS,
	MAX_PENDING_CONNECTIONS,
	MAX_ROOM_CONNECTIONS,
	sanitizeDisplayName,
} from "../src/poker-room.ts";

test("worker display-name boundary strips ANSI, OSC, controls, and newlines before limiting length", () => {
	const malicious = `\x1b[31mAlice\x1b[0m\x1b]0;owned\x07\n${"x".repeat(100)}\x00`;
	const clean = sanitizeDisplayName(malicious);
	assert.equal(clean, `Alice ${"x".repeat(34)}`);
	assert.equal(clean.length, 40);
	assert.doesNotMatch(clean, /[\x00-\x1f\x7f-\x9f]/);
	assert.equal(sanitizeDisplayName("\x1b[31m\x1b[0m"), "");
	assert.equal(sanitizeDisplayName("A\u0085B"), "AB");
});

test("connection limits preserve normal tables while bounding pending handshakes", () => {
	const joined = Array.from({ length: 6 }, (_, seatIndex) => ({ playerId: `p${seatIndex}`, seatIndex }));
	assert.equal(canAcceptConnection(joined), true, "a full six-seat table can still accept bounded transport overhead");
	const pending = Array.from({ length: MAX_PENDING_CONNECTIONS }, (_, index) => ({ acceptedAt: index }));
	assert.equal(canAcceptConnection([...joined, ...pending]), false);
	const total = Array.from({ length: MAX_ROOM_CONNECTIONS }, (_, seatIndex) => ({ playerId: `p${seatIndex}`, seatIndex }));
	assert.equal(canAcceptConnection(total), false);
});

test("pending handshake deadline survives hibernation through the socket attachment", () => {
	assert.equal(handshakeDeadline({ acceptedAt: 1_000 }), 1_000 + HANDSHAKE_TIMEOUT_MS);
	assert.equal(handshakeDeadline({ acceptedAt: 1_000, playerId: "joined", seatIndex: 0 }), null);
	assert.equal(handshakeDeadline({}), null);
});

test("only the creator capability authorizes starting hands", () => {
	assert.throws(() => assertCreatorCanStartHand(false, "showdown"), /Only the room creator/);
	assert.throws(() => assertCreatorCanStartHand(true, "preflop"), /already in progress/);
	assert.doesNotThrow(() => assertCreatorCanStartHand(true, "showdown"));
});

test("engine forceFold preserves disconnected chips and settles heads-up", () => {
	let table = createTable({ seatCount: 2, smallBlind: 5, bigBlind: 10 });
	table = seatPlayer(table, 0, { id: "creator", displayName: "Creator", stack: 500 });
	table = seatPlayer(table, 1, { id: "guest", displayName: "Guest", stack: 500 });
	table = startHand(table, () => 0.5);
	const disconnected = table.toActIndex!;
	const committed = table.seats[disconnected]!.totalCommitted;
	const totalBefore = table.seats.reduce((sum, seat) => sum + (seat?.stack ?? 0) + (seat?.totalCommitted ?? 0), 0);
	const next = forceFold(table, disconnected);
	assert.equal(next.street, "showdown");
	assert.equal(next.seats[disconnected]!.status, "folded");
	assert.ok(committed > 0);
	const totalAfter = next.seats.reduce((sum, seat) => sum + (seat?.stack ?? 0) + (seat?.totalCommitted ?? 0), 0);
	assert.equal(totalAfter, totalBefore);
});
