import { WebSocket } from "ws";
import type { Action } from "../engine/types.ts";
import type { PublicTableState } from "../engine/view.ts";
import { type ChatMessage, decodeServerMessage, encode, PROTOCOL_VERSION } from "./protocol.ts";

export interface RoomClientOptions {
	url: string;
	playerId: string;
	displayName: string;
	onWelcome: (info: { seatIndex: number; seatCount: number; smallBlind: number; bigBlind: number }) => void;
	onState: (state: PublicTableState) => void;
	onChatMessage: (message: ChatMessage) => void;
	onChatHistory: (messages: ChatMessage[]) => void;
	onRejected: (reason: "roomFull" | "protocolMismatch" | "error", message?: string) => void;
	/** Nonfatal server or socket error after the welcome handshake. */
	onError?: (message: string) => void;
	onClose: () => void;
}

export class RoomClient {
	private ws: WebSocket;
	seatIndex: number | null = null;

	constructor(private readonly opts: RoomClientOptions) {
		const url = new URL(opts.url);
		const creatorCapability = url.searchParams.get("creator") ?? undefined;
		url.searchParams.delete("creator");
		this.ws = new WebSocket(url);
		this.ws.on("open", () => {
			this.ws.send(
				encode({
					type: "hello",
					protocolVersion: PROTOCOL_VERSION,
					playerId: opts.playerId,
					displayName: opts.displayName,
					...(creatorCapability ? { creatorCapability } : {}),
				}),
			);
		});
		this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
		this.ws.on("close", () => opts.onClose());
		this.ws.on("error", () => this.reportError("Connection failed"));
	}

	sendAction(action: Action): void {
		this.ws.send(encode({ type: "action", action }));
	}

	startHand(): void {
		this.ws.send(encode({ type: "startHand" }));
	}

	sendChat(text: string): void {
		this.ws.send(encode({ type: "chat", text }));
	}

	close(): void {
		this.ws.close();
	}

	private handleMessage(raw: string): void {
		let message: ReturnType<typeof decodeServerMessage>;
		try {
			message = decodeServerMessage(raw);
		} catch {
			return;
		}
		switch (message.type) {
			case "welcome":
				this.seatIndex = message.seatIndex;
				this.opts.onWelcome(message);
				break;
			case "state":
				this.opts.onState(message.state);
				break;
			case "chatMessage":
				this.opts.onChatMessage(message.message);
				break;
			case "chatHistory":
				this.opts.onChatHistory(message.messages);
				break;
			case "roomFull":
				this.opts.onRejected("roomFull");
				break;
			case "protocolMismatch":
				this.opts.onRejected("protocolMismatch", `Host is running protocol v${message.hostVersion}`);
				break;
			case "error":
				this.reportError(message.message);
				break;
			case "pong":
				break;
		}
	}

	private reportError(message: string): void {
		if (this.seatIndex === null) {
			this.opts.onRejected("error", message);
		} else {
			this.opts.onError?.(message);
		}
	}
}
