import { applyAction, createTable, forceFold, leaveSeat, seatPlayer, startHand } from "@geminixiang/pi-texas-holdem/src/engine/table.ts";
import type { Action, TableState } from "@geminixiang/pi-texas-holdem/src/engine/types.ts";
import { redactStateFor } from "@geminixiang/pi-texas-holdem/src/engine/view.ts";
import {
	encode,
	PROTOCOL_VERSION,
	type ClientMessage,
	type ServerMessage,
} from "@geminixiang/pi-texas-holdem/src/net/protocol.ts";
import { sanitizeChatText } from "@geminixiang/pi-texas-holdem/src/net/sanitize.ts";
import { roomTtlMs } from "./config.ts";
import type { Env, RoomConfig, RoomMetadata } from "./types.ts";

const TABLE_KEY = "table";
const META_KEY = "metadata";
const MAX_MESSAGE_BYTES = 16 * 1024;
export const MAX_ROOM_CONNECTIONS = 12;
export const MAX_PENDING_CONNECTIONS = 4;
export const HANDSHAKE_TIMEOUT_MS = 10_000;

interface ConnectionAttachment {
	playerId?: string;
	seatIndex?: number;
	isCreator?: boolean;
	acceptedAt?: number;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

export function sanitizeDisplayName(raw: string): string {
	return sanitizeChatText(raw, 40);
}

export function assertCreatorCanStartHand(isCreator: boolean, street: TableState["street"]): void {
	if (!isCreator) throw new Error("Only the room creator can start a hand");
	if (street !== "showdown") throw new Error("A hand is already in progress");
}

export function canAcceptConnection(attachments: ConnectionAttachment[]): boolean {
	return (
		attachments.length < MAX_ROOM_CONNECTIONS &&
		attachments.filter((connection) => connection.playerId === undefined).length < MAX_PENDING_CONNECTIONS
	);
}

export function handshakeDeadline(connection: ConnectionAttachment): number | null {
	return connection.playerId === undefined && connection.acceptedAt !== undefined
		? connection.acceptedAt + HANDSHAKE_TIMEOUT_MS
		: null;
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isAction(value: unknown): value is Action {
	if (typeof value !== "object" || value === null) return false;
	const action = value as Record<string, unknown>;
	if (action.type === "fold" || action.type === "check" || action.type === "call" || action.type === "allin") return true;
	return (action.type === "bet" || action.type === "raise") && Number.isInteger(action.amount) && (action.amount as number) >= 0;
}

function parseClientMessage(raw: string): ClientMessage {
	const value: unknown = JSON.parse(raw);
	if (typeof value !== "object" || value === null) throw new Error("Malformed message");
	const message = value as Record<string, unknown>;
	switch (message.type) {
		case "hello":
			if (
				typeof message.protocolVersion === "number" &&
				typeof message.playerId === "string" &&
				message.playerId.length >= 1 &&
				message.playerId.length <= 128 &&
				typeof message.displayName === "string" &&
				sanitizeDisplayName(message.displayName).length >= 1 &&
				(typeof message.creatorCapability === "undefined" || typeof message.creatorCapability === "string")
			)
				return message as unknown as ClientMessage;
			break;
		case "action":
			if (isAction(message.action)) return message as unknown as ClientMessage;
			break;
		case "startHand":
		case "ping":
			return message as unknown as ClientMessage;
	}
	throw new Error("Malformed or unsupported message");
}

function firstOpenSeat(table: TableState): number | null {
	const index = table.seats.findIndex((seat) => seat === null);
	return index < 0 ? null : index;
}

function attachment(ws: WebSocket): ConnectionAttachment {
	return (ws.deserializeAttachment() as ConnectionAttachment | null) ?? {};
}

/** One authoritative room. State is persisted after every mutation; sockets use DO hibernation. */
export class PokerRoom implements DurableObject {
	private readonly state: DurableObjectState;
	private readonly env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/create" && request.method === "POST") return this.create(request);

		const metadata = await this.state.storage.get<RoomMetadata>(META_KEY);
		if (!metadata) return json({ error: "Room not found or expired" }, 404);
		if (metadata.expiresAt <= Date.now()) {
			await this.expire();
			return json({ error: "Room expired" }, 410);
		}
		if (request.method === "HEAD") return new Response(null, { status: 204 });
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return json({ error: "Connect with WebSocket" }, 426);
		}
		const attachments = this.state.getWebSockets().map(attachment);
		if (!canAcceptConnection(attachments)) return json({ error: "Room connection limit reached" }, 503);

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		server.serializeAttachment({ acceptedAt: Date.now() } satisfies ConnectionAttachment);
		this.state.acceptWebSocket(server);
		await this.scheduleAlarm(metadata);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
		const connection = attachment(ws);
		if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
			this.send(ws, { type: "error", message: "Message must be text and at most 16 KiB" });
			if (connection.playerId === undefined) ws.close(1008, "Invalid handshake");
			return;
		}

		let message: ClientMessage;
		try {
			message = parseClientMessage(raw);
		} catch {
			this.send(ws, { type: "error", message: "Malformed message" });
			if (connection.playerId === undefined) ws.close(1008, "Invalid handshake");
			return;
		}

		if (message.type === "hello") {
			if (connection.playerId !== undefined) {
				this.send(ws, { type: "error", message: "Already joined" });
				ws.close(1008, "Repeated handshake");
				return;
			}
			if (message.protocolVersion !== PROTOCOL_VERSION) {
				this.send(ws, { type: "protocolMismatch", hostVersion: PROTOCOL_VERSION });
				ws.close(1002, "Protocol mismatch");
				return;
			}
			const hello = message as Extract<ClientMessage, { type: "hello" }>;
			await this.join(
				ws,
				hello.playerId,
				sanitizeDisplayName(hello.displayName),
				hello.creatorCapability,
			);
			return;
		}

		if (connection.playerId === undefined || connection.seatIndex === undefined) {
			this.send(ws, { type: "error", message: "Send hello first" });
			ws.close(1008, "Handshake required");
			return;
		}
		if (message.type === "ping") {
			this.send(ws, { type: "pong" });
			return;
		}

		try {
			let table = await this.table();
			if (message.type === "action") table = applyAction(table, connection.seatIndex, message.action);
			else if (message.type === "startHand") {
				assertCreatorCanStartHand(connection.isCreator === true, table.street);
				table = startHand(table);
			} else {
				this.send(ws, { type: "error", message: "Chat is not available in the worker MVP" });
				return;
			}
			await this.persistAndBroadcast(table);
		} catch (error) {
			this.send(ws, { type: "error", message: error instanceof Error ? error.message : "Action failed" });
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
		await this.disconnect(ws);
		ws.close(code, reason);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		await this.disconnect(ws);
	}

	async alarm(): Promise<void> {
		const metadata = await this.state.storage.get<RoomMetadata>(META_KEY);
		if (!metadata) return;
		const now = Date.now();
		if (metadata.expiresAt <= now) {
			await this.expire();
			return;
		}
		for (const socket of this.state.getWebSockets()) {
			const deadline = handshakeDeadline(attachment(socket));
			if (deadline !== null && deadline <= now) socket.close(1008, "Handshake timeout");
		}
		await this.scheduleAlarm(metadata);
	}

	private async create(request: Request): Promise<Response> {
		const existing = await this.state.storage.get<RoomMetadata>(META_KEY);
		if (existing) return json({ expiresAt: existing.expiresAt });
		const input = (await request.json()) as { config: RoomConfig; creatorCapability: string };
		if (!input.creatorCapability || typeof input.creatorCapability !== "string") return json({ error: "Invalid creator capability" }, 400);
		const config = input.config;
		const now = Date.now();
		const metadata: RoomMetadata = {
			...config,
			createdAt: now,
			expiresAt: now + roomTtlMs(this.env.ROOM_TTL_SECONDS),
			creatorCapabilityHash: await sha256(input.creatorCapability),
		};
		const table = createTable(config);
		await this.state.storage.put({ [META_KEY]: metadata, [TABLE_KEY]: table });
		await this.state.storage.setAlarm(metadata.expiresAt);
		// telemetryEnabled is stored as consent, but this package intentionally ships no collector binding.
		return json({ expiresAt: metadata.expiresAt }, 201);
	}

	private async join(
		ws: WebSocket,
		playerId: string,
		displayName: string,
		creatorCapability: string | undefined,
	): Promise<void> {
		let table = await this.table();
		if (table.street !== "showdown") {
			this.send(ws, { type: "error", message: "Wait for the current hand to finish" });
			return;
		}
		if (table.seats.some((seat) => seat?.id === playerId)) {
			this.send(ws, { type: "error", message: "Player ID is already seated" });
			return;
		}
		const seatIndex = firstOpenSeat(table);
		if (seatIndex === null) {
			this.send(ws, { type: "roomFull" });
			ws.close(1008, "Room full");
			return;
		}
		const metadata = await this.metadata();
		const isCreator =
			typeof creatorCapability === "string" &&
			creatorCapability.length > 0 &&
			(await sha256(creatorCapability)) === metadata.creatorCapabilityHash;
		table = seatPlayer(table, seatIndex, { id: playerId, displayName, stack: metadata.startingStack });
		ws.serializeAttachment({ playerId, seatIndex, isCreator } satisfies ConnectionAttachment);
		await this.scheduleAlarm(metadata);
		this.send(ws, {
			type: "welcome",
			youId: playerId,
			seatIndex,
			seatCount: table.seats.length,
			smallBlind: table.smallBlind,
			bigBlind: table.bigBlind,
		});
		await this.persistAndBroadcast(table);
	}

	private async disconnect(ws: WebSocket): Promise<void> {
		const connection = attachment(ws);
		if (connection.seatIndex === undefined) return;
		let table = await this.table();
		const seat = table.seats[connection.seatIndex];
		if (!seat || seat.id !== connection.playerId) return;
		if (table.street !== "showdown") {
			table = forceFold(table, connection.seatIndex);
			await this.persistAndBroadcast(table);
			return;
		}
		table = leaveSeat(table, connection.seatIndex);
		await this.persistAndBroadcast(table);
	}

	private async persistAndBroadcast(table: TableState): Promise<void> {
		if (table.street === "showdown") table = this.removeDisconnectedSeats(table);
		await this.state.storage.put(TABLE_KEY, table);
		for (const socket of this.state.getWebSockets()) {
			const viewer = attachment(socket).playerId;
			this.send(socket, { type: "state", state: redactStateFor(table, viewer) });
		}
	}

	private removeDisconnectedSeats(table: TableState): TableState {
		const connectedPlayerIds = new Set(
			this.state.getWebSockets().map((socket) => attachment(socket).playerId).filter((id): id is string => id !== undefined),
		);
		const seats = table.seats.map((seat) => (seat && !connectedPlayerIds.has(seat.id) ? null : seat));
		return seats.some((seat, index) => seat !== table.seats[index]) ? { ...table, seats } : table;
	}

	private send(ws: WebSocket, message: ServerMessage): void {
		try {
			ws.send(encode(message));
		} catch {
			// A close can race a broadcast; the close callback owns cleanup.
		}
	}

	private async table(): Promise<TableState> {
		const table = await this.state.storage.get<TableState>(TABLE_KEY);
		if (!table) throw new Error("Room is not initialized");
		return table;
	}

	private async metadata(): Promise<RoomMetadata> {
		const metadata = await this.state.storage.get<RoomMetadata>(META_KEY);
		if (!metadata) throw new Error("Room is not initialized");
		return metadata;
	}

	private async scheduleAlarm(metadata: RoomMetadata): Promise<void> {
		const now = Date.now();
		const pendingDeadlines = this.state
			.getWebSockets()
			.map((socket) => handshakeDeadline(attachment(socket)))
			.filter((deadline): deadline is number => deadline !== null && deadline > now);
		await this.state.storage.setAlarm(Math.min(metadata.expiresAt, ...pendingDeadlines));
	}

	private async expire(): Promise<void> {
		for (const socket of this.state.getWebSockets()) socket.close(1001, "Room expired");
		await this.state.storage.deleteAll();
	}
}
