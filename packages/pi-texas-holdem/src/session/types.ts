import type { Action, LegalActions } from "../engine/types.ts";
import type { PublicTableState } from "../engine/view.ts";
import type { ChatMessage } from "../net/protocol.ts";

export interface SessionInfo {
	readonly roomLabel: string;
	readonly myId: string;
	readonly mySeatIndex: number | null;
}

/** Runtime-neutral boundary consumed by the poker UI for local and online games. */
export interface GameSession {
	readonly info: SessionInfo;
	getState(): PublicTableState;
	legalActionsForMe(): LegalActions | null;
	canStartHand(): boolean;
	startHand(): void;
	act(action: Action): void;
	getChatLog(): readonly ChatMessage[];
	sendChat(text: string): void;
	subscribe(listener: () => void): () => void;
	close(): void;
}

export interface LocalSessionOptions {
	myId: string;
	displayName: string;
	seatCount: number;
	smallBlind: number;
	bigBlind: number;
	startingStack: number;
}

export interface HostSessionOptions extends LocalSessionOptions {
	port: number;
	onLog?: (line: string) => void;
}

export interface JoinSessionOptions {
	url: string;
	myId: string;
	displayName: string;
	/** Only creator-authorized cloud sessions may request a new hand. */
	canStartHands?: boolean;
}

export type JoinSessionEvent = "welcome" | "rejected" | "hostDisconnected" | "error";
