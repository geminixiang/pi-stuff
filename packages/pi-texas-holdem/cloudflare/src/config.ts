import type { RoomConfig } from "./types.ts";

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
	seatCount: 6,
	smallBlind: 5,
	bigBlind: 10,
	startingStack: 500,
	telemetryEnabled: false,
};

function integerIn(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function parseRoomConfig(value: unknown): RoomConfig {
	const input = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	const smallBlind = integerIn(input.smallBlind, DEFAULT_ROOM_CONFIG.smallBlind, 1, 10_000);
	const bigBlind = integerIn(input.bigBlind, DEFAULT_ROOM_CONFIG.bigBlind, smallBlind, 20_000);
	const minimumStack = bigBlind * 2;
	const defaultStack = Math.max(DEFAULT_ROOM_CONFIG.startingStack, minimumStack);
	return {
		seatCount: integerIn(input.seatCount, DEFAULT_ROOM_CONFIG.seatCount, 2, 10),
		smallBlind,
		bigBlind,
		startingStack: integerIn(input.startingStack, defaultStack, minimumStack, 10_000_000),
		// Deliberately strict opt-in. Truthy strings and omitted values remain off.
		telemetryEnabled: input.telemetry === true,
	};
}

export function roomTtlMs(raw: string | undefined): number {
	const seconds = Number(raw ?? 86_400);
	return Number.isFinite(seconds) && seconds >= 300 ? Math.min(seconds, 604_800) * 1_000 : 86_400_000;
}
