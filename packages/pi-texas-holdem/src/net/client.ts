import { WebSocket } from "ws";
import type { Action } from "../engine/types.ts";
import type { PublicTableState } from "../engine/view.ts";
import { decodeServerMessage, encode, PROTOCOL_VERSION } from "./protocol.ts";

export interface RoomClientOptions {
	url: string;
	playerId: string;
	displayName: string;
	onWelcome: (info: { seatIndex: number; seatCount: number; smallBlind: number; bigBlind: number }) => void;
	onState: (state: PublicTableState) => void;
	onRejected: (reason: "roomFull" | "protocolMismatch" | "error", message?: string) => void;
	onClose: () => void;
}

export class RoomClient {
	private ws: WebSocket;
	seatIndex: number | null = null;

	constructor(private readonly opts: RoomClientOptions) {
		this.ws = new WebSocket(opts.url);
		this.ws.on("open", () => {
			this.ws.send(
				encode({
					type: "hello",
					protocolVersion: PROTOCOL_VERSION,
					playerId: opts.playerId,
					displayName: opts.displayName,
				}),
			);
		});
		this.ws.on("message", (raw) => this.handleMessage(raw.toString()));
		this.ws.on("close", () => opts.onClose());
		this.ws.on("error", () => opts.onRejected("error", "Connection failed"));
	}

	sendAction(action: Action): void {
		this.ws.send(encode({ type: "action", action }));
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
			case "roomFull":
				this.opts.onRejected("roomFull");
				break;
			case "protocolMismatch":
				this.opts.onRejected("protocolMismatch", `Host is running protocol v${message.hostVersion}`);
				break;
			case "error":
				this.opts.onRejected("error", message.message);
				break;
			case "pong":
				break;
		}
	}
}
