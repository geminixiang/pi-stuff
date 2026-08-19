export interface Env {
	POKER_ROOMS: DurableObjectNamespace;
	/** Set with `wrangler secret put CREATE_ROOM_SECRET`; never commit its value. */
	CREATE_ROOM_SECRET: string;
	ROOM_TTL_SECONDS?: string;
}

export interface RoomConfig {
	seatCount: number;
	smallBlind: number;
	bigBlind: number;
	startingStack: number;
	telemetryEnabled: boolean;
}

export interface RoomMetadata extends RoomConfig {
	createdAt: number;
	expiresAt: number;
	/** SHA-256 of the unguessable creator capability; the plaintext is never stored. */
	creatorCapabilityHash: string;
}

/** Optional future seam. Private rooms are never registered unless a creator explicitly requests it. */
export interface RoomDirectory {
	register(room: { url: string; expiresAt: number }): Promise<void>;
	unregister(url: string): Promise<void>;
}

/** Receives anonymous daily counters only: never room/player IDs, names, IPs, or URLs. */
export interface AnonymousTelemetry {
	increment(day: string, event: "room_created" | "player_joined"): Promise<void>;
}
