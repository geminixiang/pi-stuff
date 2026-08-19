import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ROOM_CONFIG, parseRoomConfig, roomTtlMs } from "../src/config.ts";

test("room config defaults conservatively and telemetry is explicit opt-in", () => {
	assert.deepEqual(parseRoomConfig({}), DEFAULT_ROOM_CONFIG);
	assert.equal(parseRoomConfig({ telemetry: "true" }).telemetryEnabled, false);
	assert.equal(parseRoomConfig({ telemetry: true }).telemetryEnabled, true);
});

test("room config constrains public input", () => {
	assert.deepEqual(parseRoomConfig({ seatCount: 99, smallBlind: -1, bigBlind: 0, startingStack: 1 }), DEFAULT_ROOM_CONFIG);
	assert.equal(parseRoomConfig({ bigBlind: 20_000 }).startingStack, 40_000);
	assert.deepEqual(parseRoomConfig({ seatCount: 2, smallBlind: 10, bigBlind: 20, startingStack: 1_000 }), {
		seatCount: 2,
		smallBlind: 10,
		bigBlind: 20,
		startingStack: 1_000,
		telemetryEnabled: false,
	});
});

test("room TTL has a floor, default, and seven-day cap", () => {
	assert.equal(roomTtlMs(undefined), 86_400_000);
	assert.equal(roomTtlMs("600"), 600_000);
	assert.equal(roomTtlMs("1"), 86_400_000);
	assert.equal(roomTtlMs("9999999"), 604_800_000);
});
