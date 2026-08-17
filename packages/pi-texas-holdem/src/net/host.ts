import crypto from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { applyAction, createTable, leaveSeat, seatPlayer, startHand } from "../engine/table.ts";
import type { Action, TableState } from "../engine/types.ts";
import { redactStateFor } from "../engine/view.ts";
import { type ChatMessage, decodeClientMessage, encode, PROTOCOL_VERSION } from "./protocol.ts";
import { sanitizeChatText } from "./sanitize.ts";

const CHAT_HISTORY_LIMIT = 200;
const CHAT_HISTORY_SENT_ON_JOIN = 30;
const CHAT_MIN_INTERVAL_MS = 400;

export interface HostRoomOptions {
	port: number;
	seatCount: number;
	smallBlind: number;
	bigBlind: number;
	startingStack: number;
	onStateChange: (state: TableState) => void;
	onChatMessage?: (message: ChatMessage) => void;
	onLog?: (line: string) => void;
}

interface Connection {
	ws: WebSocket;
	seatIndex: number;
	playerId: string;
	lastChatAt: number;
}

/**
 * Authoritative game server. The host's own UI mutates `state` directly through
 * `applyLocalAction` / `startHand`; remote players connect over WebSocket and are
 * validated the same way any seat is (must be their turn, seat must be theirs).
 */
export class HostRoom {
	state: TableState;
	private wss: WebSocketServer;
	private connections = new Set<Connection>();
	private readonly opts: HostRoomOptions;
	private chatLog: ChatMessage[] = [];
	private announcedLogLength = 0;

	constructor(opts: HostRoomOptions) {
		this.opts = opts;
		this.state = createTable({ seatCount: opts.seatCount, smallBlind: opts.smallBlind, bigBlind: opts.bigBlind });
		this.wss = new WebSocketServer({ port: opts.port });
		this.wss.on("connection", (ws) => this.handleConnection(ws));
	}

	/** Resolves once the server is actually listening, with the bound port. */
	waitForListening(): Promise<number> {
		return new Promise((resolve, reject) => {
			this.wss.once("listening", () => {
				const address = this.wss.address();
				resolve(typeof address === "object" && address ? address.port : this.opts.port);
			});
			this.wss.once("error", reject);
		});
	}

	seatLocalPlayer(seatIndex: number, id: string, displayName: string): void {
		this.state = seatPlayer(this.state, seatIndex, { id, displayName, stack: this.opts.startingStack });
		this.broadcast();
	}

	firstOpenSeat(): number | null {
		for (let i = 0; i < this.state.seats.length; i++) {
			if (!this.state.seats[i]) return i;
		}
		return null;
	}

	seatedCount(): number {
		return this.state.seats.filter((s) => !!s).length;
	}

	canStartHand(): boolean {
		return this.state.seats.filter((s) => s && s.stack > 0).length >= 2;
	}

	startHand(): void {
		this.state = startHand(this.state);
		this.announcedLogLength = 0;
		this.announceNewLog();
		this.log(`-- hand ${this.state.handNumber} --`);
		this.broadcast();
	}

	applyLocalAction(seatIndex: number, action: Action): void {
		this.state = applyAction(this.state, seatIndex, action);
		this.announceNewLog();
		this.broadcast();
	}

	getChatHistory(): readonly ChatMessage[] {
		return this.chatLog;
	}

	/** Chat from the host's own local seat; bypasses the per-connection rate limit. */
	sendLocalChat(seatIndex: number, text: string): void {
		const seat = this.state.seats[seatIndex];
		if (!seat) return;
		const clean = sanitizeChatText(text);
		if (!clean) return;
		this.pushChat(seatIndex, seat.displayName, clean);
	}

	close(): void {
		for (const conn of this.connections) conn.ws.close();
		this.wss.close();
	}

	private log(line: string): void {
		this.opts.onLog?.(line);
	}

	/** Mirrors new engine log lines (folds, calls, showdown results, ...) into chat as system messages. */
	private announceNewLog(): void {
		while (this.announcedLogLength < this.state.log.length) {
			const line = this.state.log[this.announcedLogLength] as string;
			this.pushChat(null, "table", line);
			this.announcedLogLength++;
		}
	}

	private pushChat(seatIndex: number | null, displayName: string, text: string): void {
		const message: ChatMessage = { id: crypto.randomUUID(), seatIndex, displayName, text, ts: Date.now() };
		this.chatLog.push(message);
		if (this.chatLog.length > CHAT_HISTORY_LIMIT) this.chatLog.shift();
		this.opts.onChatMessage?.(message);
		const encoded = encode({ type: "chatMessage", message });
		for (const conn of this.connections) {
			if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(encoded);
		}
	}

	private handleConnection(ws: WebSocket): void {
		let conn: Connection | undefined;

		ws.on("message", (raw) => {
			let message: ReturnType<typeof decodeClientMessage>;
			try {
				message = decodeClientMessage(raw.toString());
			} catch {
				ws.send(encode({ type: "error", message: "Malformed message" }));
				return;
			}

			if (message.type === "hello") {
				if (message.protocolVersion !== PROTOCOL_VERSION) {
					ws.send(encode({ type: "protocolMismatch", hostVersion: PROTOCOL_VERSION }));
					ws.close();
					return;
				}
				const seatIndex = this.firstOpenSeat();
				if (seatIndex === null) {
					ws.send(encode({ type: "roomFull" }));
					ws.close();
					return;
				}
				this.state = seatPlayer(this.state, seatIndex, {
					id: message.playerId,
					displayName: message.displayName,
					stack: this.opts.startingStack,
				});
				conn = { ws, seatIndex, playerId: message.playerId, lastChatAt: 0 };
				this.connections.add(conn);
				this.log(`${message.displayName} joined at seat ${seatIndex}`);
				this.pushChat(null, "table", `${message.displayName} joined the table`);
				ws.send(
					encode({
						type: "welcome",
						youId: message.playerId,
						seatIndex,
						seatCount: this.state.seats.length,
						smallBlind: this.state.smallBlind,
						bigBlind: this.state.bigBlind,
					}),
				);
				ws.send(encode({ type: "chatHistory", messages: this.chatLog.slice(-CHAT_HISTORY_SENT_ON_JOIN) }));
				this.broadcast();
				return;
			}

			if (!conn) {
				ws.send(encode({ type: "error", message: "Send hello first" }));
				return;
			}

			if (message.type === "action") {
				try {
					this.applyLocalAction(conn.seatIndex, message.action);
				} catch (error) {
					ws.send(encode({ type: "error", message: error instanceof Error ? error.message : String(error) }));
				}
				return;
			}

			if (message.type === "chat") {
				const now = Date.now();
				if (now - conn.lastChatAt < CHAT_MIN_INTERVAL_MS) {
					ws.send(encode({ type: "error", message: "You're sending messages too fast" }));
					return;
				}
				conn.lastChatAt = now;
				const clean = sanitizeChatText(message.text);
				if (!clean) return;
				const seat = this.state.seats[conn.seatIndex];
				this.pushChat(conn.seatIndex, seat?.displayName ?? conn.playerId, clean);
				return;
			}

			if (message.type === "ping") {
				ws.send(encode({ type: "pong" }));
			}
		});

		ws.on("close", () => {
			if (!conn) return;
			this.connections.delete(conn);
			const seat = this.state.seats[conn.seatIndex];
			if (seat) {
				// A player who disconnects mid-hand auto-folds if it was their turn;
				// re-joining under the same connection isn't handled yet (v1 limitation).
				if (this.state.toActIndex === conn.seatIndex && seat.status === "active") {
					try {
						this.applyLocalAction(conn.seatIndex, { type: "fold" });
					} catch {
						// hand may have already ended between the disconnect and this fold
					}
				}
				this.state = leaveSeat(this.state, conn.seatIndex);
				this.log(`${seat.displayName} disconnected`);
				this.pushChat(null, "table", `${seat.displayName} disconnected`);
				this.broadcast();
			}
		});
	}

	private broadcast(): void {
		this.opts.onStateChange(this.state);
		for (const conn of this.connections) {
			if (conn.ws.readyState !== WebSocket.OPEN) continue;
			conn.ws.send(encode({ type: "state", state: redactStateFor(this.state, conn.playerId) }));
		}
	}
}
