import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWorkerEndpoint } from "../src/ui/cloud.ts";
import { normalizeRoomUrl, parsePokerCommand, shareableRoomUrl } from "../src/ui/commands.ts";

test("parses the three primary entry paths", () => {
	assert.deepEqual(parsePokerCommand("local 4"), { kind: "local", seatCount: 4, legacyAlias: false });
	assert.deepEqual(parsePokerCommand("create"), { kind: "create" });
	assert.deepEqual(parsePokerCommand("join https://cards.example/room/abc"), {
		kind: "join",
		address: "https://cards.example/room/abc",
	});
});

test("retains legacy command aliases", () => {
	assert.deepEqual(parsePokerCommand("bots 3"), { kind: "local", seatCount: 3, legacyAlias: true });
	assert.deepEqual(parsePokerCommand("host 4666 --i-know"), {
		kind: "lanHost",
		port: 4666,
		confirmed: true,
		legacyAlias: true,
	});
	assert.deepEqual(parsePokerCommand("quit"), { kind: "leave" });
});

test("local seats and LAN ports use safe bounds and defaults", () => {
	assert.equal(parsePokerCommand("local 99").kind, "local");
	assert.deepEqual(parsePokerCommand("local 99"), { kind: "local", seatCount: 6, legacyAlias: false });
	assert.deepEqual(parsePokerCommand("local nope"), { kind: "local", seatCount: 6, legacyAlias: false });
	assert.deepEqual(parsePokerCommand("lan-host 99999 --i-know"), {
		kind: "lanHost",
		port: 4551,
		confirmed: true,
		legacyAlias: false,
	});
});

test("normalizes share URLs and direct LAN addresses", () => {
	assert.equal(normalizeRoomUrl("https://cards.example/room/abc"), "wss://cards.example/room/abc");
	assert.equal(normalizeRoomUrl("http://localhost:4551"), "ws://localhost:4551/");
	assert.equal(normalizeRoomUrl("192.168.1.20:4551"), "ws://192.168.1.20:4551/");
	assert.equal(normalizeRoomUrl("wss://cards.example/r?id=abc"), "wss://cards.example/r?id=abc");
	assert.equal(shareableRoomUrl("wss://cards.example/r?creator=secret&id=abc"), "wss://cards.example/r?id=abc");
});

test("normalizes personal Worker endpoints and requires secure remote transport", () => {
	assert.equal(normalizeWorkerEndpoint("https://cards.example/"), "https://cards.example");
	assert.equal(normalizeWorkerEndpoint("http://localhost:8787/"), "http://localhost:8787");
	assert.throws(() => normalizeWorkerEndpoint("http://cards.example"), /must use HTTPS/);
	assert.throws(() => normalizeWorkerEndpoint("https://user:secret@cards.example"), /cannot contain credentials/);
});

test("rejects unsafe or malformed room URLs before replacing the active session", () => {
	assert.throws(() => normalizeRoomUrl(""), /Enter a room URL/);
	assert.throws(() => normalizeRoomUrl("ws://user:secret@example.com"), /usernames or passwords/);
	assert.throws(() => normalizeRoomUrl("not a room url"), /valid room URL/);
});
