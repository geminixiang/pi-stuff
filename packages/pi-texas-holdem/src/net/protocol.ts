import type { Action } from "../engine/types.ts";
import type { PublicTableState } from "../engine/view.ts";

export const PROTOCOL_VERSION = 2;

export interface ChatMessage {
	id: string;
	/** null identifies a system/log message (joins, folds, showdown results, ...). */
	seatIndex: number | null;
	displayName: string;
	text: string;
	ts: number;
}

export type ClientMessage =
	| { type: "hello"; protocolVersion: number; playerId: string; displayName: string }
	| { type: "action"; action: Action }
	| { type: "startHand" }
	| { type: "chat"; text: string }
	| { type: "ping" };

export type ServerMessage =
	| { type: "welcome"; youId: string; seatIndex: number; seatCount: number; smallBlind: number; bigBlind: number }
	| { type: "state"; state: PublicTableState }
	| { type: "chatMessage"; message: ChatMessage }
	| { type: "chatHistory"; messages: ChatMessage[] }
	| { type: "roomFull" }
	| { type: "protocolMismatch"; hostVersion: number }
	| { type: "error"; message: string }
	| { type: "pong" };

export function encode(message: ClientMessage | ServerMessage): string {
	return JSON.stringify(message);
}

export function decodeClientMessage(raw: string): ClientMessage {
	const parsed = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
		throw new Error("Malformed client message");
	}
	return parsed as ClientMessage;
}

export function decodeServerMessage(raw: string): ServerMessage {
	const parsed = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") {
		throw new Error("Malformed server message");
	}
	return parsed as ServerMessage;
}
