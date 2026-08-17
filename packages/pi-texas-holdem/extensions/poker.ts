import crypto from "node:crypto";
import os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { formatCard } from "../src/engine/cards.ts";
import { applyAction, createTable, legalActions as computeLegalActions, seatPlayer, startHand as engineStartHand } from "../src/engine/table.ts";
import type { Action, LegalActions, Street, TableState } from "../src/engine/types.ts";
import { centerOnRow, layoutTable, stampBlock } from "../src/engine/ring.ts";
import type { PublicSeat, PublicTableState } from "../src/engine/view.ts";
import { redactStateFor } from "../src/engine/view.ts";
import { HostRoom } from "../src/net/host.ts";
import { RoomClient } from "../src/net/client.ts";
import type { ChatMessage } from "../src/net/protocol.ts";
import { sanitizeChatText } from "../src/net/sanitize.ts";

const CHAT_LOG_LIMIT = 200;
const CHAT_PANEL_LINES = 4;

const RING_WIDTH = 75;
const RING_HEIGHT = 15;
const SEAT_HALF_WIDTH = 10;
const SEAT_HALF_HEIGHT = 3;
const BOX_INNER = 17;
const DEFAULT_PORT = 4551;
const DEFAULT_STARTING_STACK = 2000;
const DEFAULT_SMALL_BLIND = 10;
const DEFAULT_BIG_BLIND = 20;

// ---------- token usage ----------

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function isUsageLike(value: unknown): value is UsageLike {
	if (typeof value !== "object" || value === null) return false;
	const usage = value as Record<string, unknown>;
	return (
		typeof usage.input === "number" &&
		typeof usage.output === "number" &&
		typeof usage.cacheRead === "number" &&
		typeof usage.cacheWrite === "number"
	);
}

/** Sums input+output+cache tokens for today (local time) across the current session's entries. */
function todaysTokenUsage(ctx: ExtensionContext): number {
	const startOfDay = new Date();
	startOfDay.setHours(0, 0, 0, 0);
	let total = 0;
	for (const entry of ctx.sessionManager.getEntries()) {
		const timestamp = (entry as { timestamp?: string }).timestamp;
		if (timestamp && new Date(timestamp) < startOfDay) continue;

		if (entry.type === "message") {
			const message = (entry as { message?: { role?: string; usage?: unknown } }).message;
			if (message && (message.role === "assistant" || message.role === "toolResult") && isUsageLike(message.usage)) {
				total += message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			const usage = (entry as { usage?: unknown }).usage;
			if (isUsageLike(usage)) total += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		}
	}
	return total;
}

function formatTokenCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

// ---------- bot AI ----------

function botDecision(state: TableState, seatIndex: number): Action {
	const legal = computeLegalActions(state, seatIndex);
	const roll = Math.random();
	if (legal.canCheck) {
		if (legal.canBetOrRaise && roll < 0.12) return { type: "raise", amount: legal.minRaiseTo };
		return { type: "check" };
	}
	if (!legal.canCall) return { type: "fold" };
	const seat = state.seats[seatIndex];
	const stackBase = seat ? seat.stack + seat.committed : 1;
	const callRatio = legal.callAmount / Math.max(1, stackBase);
	if (callRatio > 0.55 && roll < 0.5) return { type: "fold" };
	if (legal.canBetOrRaise && roll < 0.07) return { type: "raise", amount: legal.minRaiseTo };
	return { type: "call" };
}

// ---------- game session abstraction ----------

interface SessionInfo {
	roomLabel: string;
	myId: string;
	mySeatIndex: number | null;
}

interface GameSession {
	readonly info: SessionInfo;
	getState(): PublicTableState;
	legalActionsForMe(): LegalActions | null;
	canStartHand(): boolean;
	startHand(): void;
	act(action: Action): void;
	getChatLog(): readonly ChatMessage[];
	sendChat(text: string): void;
	subscribe(fn: () => void): () => void;
	close(): void;
}

function makeEmitter() {
	const listeners = new Set<() => void>();
	return {
		subscribe(fn: () => void) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		emit() {
			for (const fn of listeners) fn();
		},
	};
}

interface LocalOptions {
	myId: string;
	displayName: string;
	seatCount: number;
	smallBlind: number;
	bigBlind: number;
	startingStack: number;
}

/** Solo play against simple local bots. No networking. */
function createBotsSession(opts: LocalOptions): GameSession {
	let state = createTable({ seatCount: opts.seatCount, smallBlind: opts.smallBlind, bigBlind: opts.bigBlind });
	state = seatPlayer(state, 0, { id: opts.myId, displayName: opts.displayName, stack: opts.startingStack });
	for (let i = 1; i < opts.seatCount; i++) {
		state = seatPlayer(state, i, { id: `bot-${i}`, displayName: `bot-${i}`, stack: opts.startingStack });
	}
	const emitter = makeEmitter();
	let botTimer: NodeJS.Timeout | undefined;
	let chatLog: ChatMessage[] = [];
	let announcedLogLength = 0;
	let chatCounter = 0;

	const pushChat = (seatIndex: number | null, displayName: string, text: string) => {
		chatLog = [...chatLog, { id: `local-${++chatCounter}`, seatIndex, displayName, text, ts: Date.now() }];
		if (chatLog.length > CHAT_LOG_LIMIT) chatLog = chatLog.slice(-CHAT_LOG_LIMIT);
	};

	const announceNewLog = () => {
		while (announcedLogLength < state.log.length) {
			pushChat(null, "table", state.log[announcedLogLength] as string);
			announcedLogLength++;
		}
	};

	const scheduleBotTurn = () => {
		if (botTimer) return;
		const toAct = state.toActIndex;
		if (toAct === null || toAct === 0 || state.street === "showdown") return;
		botTimer = setTimeout(() => {
			botTimer = undefined;
			const idx = state.toActIndex;
			if (idx === null || idx === 0 || state.street === "showdown") return;
			try {
				state = applyAction(state, idx, botDecision(state, idx));
			} catch {
				state = applyAction(state, idx, { type: "fold" });
			}
			announceNewLog();
			emitter.emit();
			scheduleBotTurn();
		}, 450);
	};

	return {
		info: { roomLabel: "Local vs bots", myId: opts.myId, mySeatIndex: 0 },
		getState: () => redactStateFor(state, opts.myId),
		legalActionsForMe: () => computeLegalActions(state, 0),
		canStartHand: () => state.street === "showdown" && state.seats.filter((s) => s && s.stack > 0).length >= 2,
		startHand: () => {
			state = engineStartHand(state);
			announcedLogLength = 0;
			announceNewLog();
			emitter.emit();
			scheduleBotTurn();
		},
		act: (action) => {
			state = applyAction(state, 0, action);
			announceNewLog();
			emitter.emit();
			scheduleBotTurn();
		},
		getChatLog: () => chatLog,
		sendChat: (text) => {
			const clean = sanitizeChatText(text);
			if (!clean) return;
			pushChat(0, opts.displayName, clean);
			emitter.emit();
		},
		subscribe: emitter.subscribe,
		close: () => {
			if (botTimer) clearTimeout(botTimer);
		},
	};
}

interface HostOptions extends LocalOptions {
	port: number;
	onLog?: (line: string) => void;
}

function createHostSession(opts: HostOptions, onReady: (port: number) => void): GameSession {
	const emitter = makeEmitter();
	const room = new HostRoom({
		port: opts.port,
		seatCount: opts.seatCount,
		smallBlind: opts.smallBlind,
		bigBlind: opts.bigBlind,
		startingStack: opts.startingStack,
		onStateChange: () => emitter.emit(),
		onChatMessage: () => emitter.emit(),
		onLog: opts.onLog,
	});
	room.seatLocalPlayer(0, opts.myId, opts.displayName);
	room
		.waitForListening()
		.then((port) => onReady(port))
		.catch(() => {});

	return {
		info: { roomLabel: "Hosting", myId: opts.myId, mySeatIndex: 0 },
		getState: () => redactStateFor(room.state, opts.myId),
		legalActionsForMe: () => computeLegalActions(room.state, 0),
		canStartHand: () => room.canStartHand() && room.state.street === "showdown",
		startHand: () => room.startHand(),
		act: (action) => room.applyLocalAction(0, action),
		getChatLog: () => room.getChatHistory(),
		sendChat: (text) => room.sendLocalChat(0, text),
		subscribe: emitter.subscribe,
		close: () => room.close(),
	};
}

interface JoinOptions {
	url: string;
	myId: string;
	displayName: string;
}

function createJoinSession(opts: JoinOptions, onEvent: (kind: "welcome" | "rejected", message?: string) => void): GameSession {
	const emitter = makeEmitter();
	let lastState: PublicTableState | undefined;
	let mySeatIndex: number | null = null;
	let chatLog: ChatMessage[] = [];

	const client = new RoomClient({
		url: opts.url,
		playerId: opts.myId,
		displayName: opts.displayName,
		onWelcome: (info) => {
			mySeatIndex = info.seatIndex;
			onEvent("welcome");
			emitter.emit();
		},
		onState: (state) => {
			lastState = state;
			emitter.emit();
		},
		onChatMessage: (message) => {
			chatLog = [...chatLog, message].slice(-CHAT_LOG_LIMIT);
			emitter.emit();
		},
		onChatHistory: (messages) => {
			chatLog = messages.slice(-CHAT_LOG_LIMIT);
			emitter.emit();
		},
		onRejected: (reason, message) => onEvent("rejected", message ?? reason),
		onClose: () => onEvent("rejected", "Connection closed"),
	});

	const emptyState: PublicTableState = {
		seats: [],
		dealerIndex: -1,
		smallBlind: 0,
		bigBlind: 0,
		street: "showdown",
		communityCards: [],
		toActIndex: null,
		currentBet: 0,
		minRaise: 0,
		handNumber: 0,
		pots: [],
		winners: [],
		awards: [],
		log: [],
	};

	return {
		info: { roomLabel: `Connected to ${opts.url}`, myId: opts.myId, mySeatIndex },
		getState: () => lastState ?? emptyState,
		legalActionsForMe: () => {
			if (mySeatIndex === null || !lastState) return null;
			// Clients don't run the engine locally; derive a minimal legality check
			// from the public state so the UI can grey out actions consistently.
			const seat = lastState.seats[mySeatIndex];
			if (!seat || lastState.toActIndex !== mySeatIndex || seat.status !== "active") {
				return { canFold: false, canCheck: false, canCall: false, callAmount: 0, canBetOrRaise: false, minRaiseTo: 0, maxRaiseTo: 0 };
			}
			const toCall = Math.max(0, lastState.currentBet - seat.committed);
			const callAmount = Math.min(toCall, seat.stack);
			const maxRaiseTo = seat.committed + seat.stack;
			const minRaiseTo = Math.min(lastState.currentBet + lastState.minRaise, maxRaiseTo);
			return {
				canFold: true,
				canCheck: toCall === 0,
				canCall: toCall > 0 && seat.stack > 0,
				callAmount,
				canBetOrRaise: seat.stack > callAmount,
				minRaiseTo,
				maxRaiseTo,
			};
		},
		canStartHand: () => false,
		startHand: () => {},
		act: (action) => client.sendAction(action),
		getChatLog: () => chatLog,
		sendChat: (text) => client.sendChat(text),
		subscribe: emitter.subscribe,
		close: () => client.close(),
	};
}

// ---------- rendering ----------

function padTo(text: string, width: number): string {
	const chars = [...text];
	if (chars.length >= width) return chars.slice(0, width).join("");
	return text + " ".repeat(width - chars.length);
}

function formatSeatBox(
	seat: PublicSeat | null,
	opts: { isMe: boolean; isDealer: boolean; isSB: boolean; isBB: boolean; isTurn: boolean; folded: boolean },
): string[] {
	const top = opts.isTurn ? `┏${"━".repeat(BOX_INNER)}┓` : `┌${"─".repeat(BOX_INNER)}┐`;
	const bottom = opts.isTurn ? `┗${"━".repeat(BOX_INNER)}┛` : `└${"─".repeat(BOX_INNER)}┘`;
	const side = opts.isTurn ? "┃" : "│";

	if (!seat) {
		return [top, `${side} ${padTo("(open seat)", BOX_INNER - 1)}${side}`, `${side}${" ".repeat(BOX_INNER)}${side}`, `${side}${" ".repeat(BOX_INNER)}${side}`, bottom];
	}

	const tags = [opts.isDealer && "D", opts.isSB && "SB", opts.isBB && "BB", opts.isMe && "YOU"].filter(Boolean).join(" ");
	const nameText = tags ? `[${tags}] ${seat.displayName}` : seat.displayName;
	const cardsText = seat.status === "folded" ? "folded" : seat.holeCards.map((c) => (c ? formatCard(c) : "??")).join(" ");

	return [
		top,
		`${side} ${padTo(nameText, BOX_INNER - 1)}${side}`,
		`${side} ${padTo(`$${seat.stack.toLocaleString()}`, BOX_INNER - 1)}${side}`,
		`${side} ${padTo(cardsText, BOX_INNER - 1)}${side}`,
		bottom,
	];
}

function buildTableGrid(state: PublicTableState, mySeatIndex: number | null): string[] {
	const layout = layoutTable(RING_WIDTH, RING_HEIGHT, state.seats.length, {
		seatHalfWidth: SEAT_HALF_WIDTH,
		seatHalfHeight: SEAT_HALF_HEIGHT,
	});
	let rows = layout.rows.slice();

	const cardsText = state.communityCards.length
		? state.communityCards.map((c) => `[${formatCard(c)}]`).join("  ")
		: "-- pre-flop --";
	const potTotal = state.seats.reduce((sum, s) => sum + (s ? s.committed : 0), 0) + state.pots.reduce((sum, p) => sum + p.amount, 0);
	const communityRow = layout.padTop + 6;
	const potRow = layout.padTop + 7;
	rows[communityRow] = centerOnRow(rows[communityRow] as string, cardsText);
	rows[potRow] = centerOnRow(rows[potRow] as string, `Pot  ${potTotal.toLocaleString()}`);

	state.seats.forEach((seat, index) => {
		const anchor = layout.seatAnchors[index];
		if (!anchor) return;
		const box = formatSeatBox(seat, {
			isMe: mySeatIndex === index,
			isDealer: state.dealerIndex === index,
			isSB: false,
			isBB: false,
			isTurn: state.toActIndex === index,
			folded: !!seat && seat.status === "folded",
		});
		rows = stampBlock(rows, anchor, box);
	});

	return rows;
}

function streetLabel(street: Street): string {
	switch (street) {
		case "preflop":
			return "Preflop";
		case "flop":
			return "Flop";
		case "turn":
			return "Turn";
		case "river":
			return "River";
		case "showdown":
			return "Showdown";
	}
}

interface RaiseUiState {
	active: boolean;
	amount: number;
}

interface ChatUiState {
	active: boolean;
	draft: string;
}

function formatChatLine(theme: Theme, msg: ChatMessage): string {
	if (msg.seatIndex === null) return theme.fg("dim", `· ${msg.text}`);
	return `${theme.fg("accent", msg.displayName)}: ${msg.text}`;
}

function renderOverlay(
	session: GameSession,
	theme: Theme,
	raiseState: RaiseUiState,
	chatState: ChatUiState,
	ctx: ExtensionCommandContext,
): string[] {
	const state = session.getState();
	const mySeatIndex = session.info.mySeatIndex;
	const tokensToday = todaysTokenUsage(ctx);

	const lines: string[] = [];
	const headline = [
		session.info.roomLabel,
		`hand #${state.handNumber || 0}`,
		streetLabel(state.street),
		`today's tokens ${formatTokenCount(tokensToday)}`,
	].join("   ·   ");
	lines.push(theme.fg("accent", theme.bold(headline)));
	lines.push("");

	const grid = buildTableGrid(state, mySeatIndex);
	for (const row of grid) lines.push(theme.fg("borderMuted", row));
	lines.push("");

	if (state.street === "showdown" && state.awards.length > 0) {
		const idToName = new Map(state.seats.filter((s): s is NonNullable<typeof s> => !!s).map((s) => [s.id, s.displayName]));
		const summary = state.awards.map((a) => `${idToName.get(a.seatIds[0] ?? "") ?? "?"} +${a.amount}`).join("  ·  ");
		lines.push(theme.fg("success", `Winners: ${summary}`));
		lines.push("");
	}

	const chatLog = session.getChatLog();
	lines.push(theme.fg("dim", theme.bold("Chat")));
	if (chatLog.length === 0) {
		lines.push(theme.fg("dim", "  (no messages yet)"));
	} else {
		for (const msg of chatLog.slice(-CHAT_PANEL_LINES)) lines.push(`  ${formatChatLine(theme, msg)}`);
	}
	if (chatState.active) {
		lines.push(theme.fg("accent", `> ${chatState.draft}_`));
	}
	lines.push("");

	const legal = session.legalActionsForMe();
	if (mySeatIndex === null) {
		lines.push(theme.fg("warning", "Waiting for the host..."));
	} else if (state.street === "showdown" && state.toActIndex === null) {
		if (session.canStartHand()) {
			lines.push(theme.fg("accent", "Press Enter to start the next hand   ·   Esc back to work"));
		} else {
			lines.push(theme.fg("dim", "Waiting for the host to start the next hand   ·   Esc back to work"));
		}
	} else if (legal && legal.canFold && raiseState.active) {
		lines.push(
			theme.fg(
				"accent",
				`Raise to ${raiseState.amount}   ·   +/- adjust   ·   Enter confirm   ·   Esc cancel`,
			),
		);
	} else if (legal && legal.canFold) {
		const parts = [`${theme.fg("error", "F")} fold`];
		parts.push(legal.canCheck ? `${theme.fg("accent", "C")} check` : `${theme.fg("accent", "C")} call ${legal.callAmount}`);
		if (legal.canBetOrRaise) parts.push(`${theme.fg("accent", "R")} raise`);
		parts.push(`${theme.fg("accent", "A")} all-in`);
		parts.push(`${theme.fg("dim", "Esc")} back to work`);
		lines.push(parts.join("   "));
	} else {
		lines.push(theme.fg("dim", "Watching   ·   Esc back to work"));
	}

	if (!chatState.active && !raiseState.active) {
		lines.push(theme.fg("dim", "Press / to chat"));
	}

	return lines;
}

// ---------- widget ----------

function widgetLines(session: GameSession | null, ctx: ExtensionContext): string[] | undefined {
	if (!session) return undefined;
	const state = session.getState();
	const tokensToday = todaysTokenUsage(ctx);
	const mySeatIndex = session.info.mySeatIndex;
	const legal = session.legalActionsForMe();

	const parts = [`♠ ${session.info.roomLabel}`, `hand #${state.handNumber || 0}`];
	if (mySeatIndex !== null && legal?.canFold) {
		parts.push("your turn");
	} else if (state.toActIndex !== null) {
		const actingName = state.seats[state.toActIndex]?.displayName ?? "?";
		parts.push(`${actingName} to act`);
	}
	const pot = state.seats.reduce((sum, s) => sum + (s ? s.committed : 0), 0) + state.pots.reduce((sum, p) => sum + p.amount, 0);
	parts.push(`pot ${pot}`);
	parts.push(`today's tokens ${formatTokenCount(tokensToday)}`);
	const chatCount = session.getChatLog().length;
	if (chatCount > 0) parts.push(`chat ${chatCount}`);
	parts.push("/poker to open the table");
	return [parts.join("  ·  ")];
}

// ---------- extension ----------

export default function pokerExtension(pi: ExtensionAPI) {
	let session: GameSession | null = null;

	const refreshWidget = (ctx: ExtensionContext) => {
		ctx.ui.setWidget("poker", widgetLines(session, ctx), { placement: "belowEditor" });
	};

	const closeSession = (ctx: ExtensionContext) => {
		session?.close();
		session = null;
		ctx.ui.setWidget("poker", undefined);
	};

	const openTable = async (ctx: ExtensionCommandContext) => {
		if (!session) {
			ctx.ui.notify("No poker session active. Try /poker bots, /poker host, or /poker join <address>.", "warning");
			return;
		}
		const activeSession = session;
		const raiseState: RaiseUiState = { active: false, amount: 0 };
		const chatState: ChatUiState = { active: false, draft: "" };
		const unsubscribe = activeSession.subscribe(() => refreshWidget(ctx));

		await ctx.ui.custom<void>((tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (result: void) => void) => {
			const rerender = () => tui.requestRender();
			const stop = activeSession.subscribe(rerender);

			const submitAction = (action: Action) => {
				try {
					activeSession.act(action);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			};

			return {
				render(_width: number) {
					return renderOverlay(activeSession, theme, raiseState, chatState, ctx);
				},
				invalidate() {},
				handleInput(data: string) {
					if (chatState.active) {
						if (matchesKey(data, "escape")) {
							chatState.active = false;
							chatState.draft = "";
						} else if (matchesKey(data, "enter")) {
							const text = chatState.draft.trim();
							chatState.active = false;
							chatState.draft = "";
							if (text) activeSession.sendChat(text);
						} else if (matchesKey(data, "backspace")) {
							chatState.draft = chatState.draft.slice(0, -1);
						} else if (!data.startsWith("\x1B") && data.length > 0 && chatState.draft.length < 240) {
							chatState.draft += data;
						}
						tui.requestRender();
						return;
					}

					if (matchesKey(data, "escape")) {
						stop();
						unsubscribe();
						refreshWidget(ctx);
						done();
						return;
					}

					if (matchesKey(data, "/")) {
						chatState.active = true;
						tui.requestRender();
						return;
					}

					const legal = activeSession.legalActionsForMe();
					const mySeatIndex = activeSession.info.mySeatIndex;

					if (mySeatIndex !== null && activeSession.getState().street === "showdown" && activeSession.getState().toActIndex === null) {
						if (matchesKey(data, "enter") && activeSession.canStartHand()) {
							activeSession.startHand();
						}
						return;
					}

					if (raiseState.active) {
						if (matchesKey(data, "enter")) {
							submitAction({ type: "raise", amount: raiseState.amount });
							raiseState.active = false;
							tui.requestRender();
						} else if (matchesKey(data, "+") || matchesKey(data, "=")) {
							const step = activeSession.getState().bigBlind || 20;
							raiseState.amount = Math.min(raiseState.amount + step, legal?.maxRaiseTo ?? raiseState.amount);
							tui.requestRender();
						} else if (matchesKey(data, "-")) {
							const step = activeSession.getState().bigBlind || 20;
							raiseState.amount = Math.max(raiseState.amount - step, legal?.minRaiseTo ?? raiseState.amount);
							tui.requestRender();
						} else if (matchesKey(data, "escape")) {
							raiseState.active = false;
							tui.requestRender();
						}
						return;
					}

					if (!legal || !legal.canFold) return;

					if (matchesKey(data, "f")) submitAction({ type: "fold" });
					else if (matchesKey(data, "c")) submitAction(legal.canCheck ? { type: "check" } : { type: "call" });
					else if (matchesKey(data, "a")) submitAction({ type: "allin" });
					else if (matchesKey(data, "r") && legal.canBetOrRaise) {
						raiseState.active = true;
						raiseState.amount = legal.minRaiseTo;
						tui.requestRender();
					}
				},
			} satisfies Component;
		});
	};

	pi.registerCommand("poker", {
		description: "Play Texas Hold'em: /poker bots | host [port] | join <host:port> | (reopen table)",
		handler: async (rawArgs, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/poker needs the interactive terminal UI", "warning");
				return;
			}
			const args = rawArgs.trim().split(/\s+/).filter(Boolean);
			const sub = args[0];
			const hostname = os.hostname();
			const myId = `${hostname}-${crypto.randomBytes(3).toString("hex")}`;

			if (!sub) {
				await openTable(ctx);
				return;
			}

			if (sub === "bots") {
				closeSession(ctx);
				const seatCount = Math.min(6, Math.max(2, Number(args[1]) || 6));
				session = createBotsSession({
					myId,
					displayName: hostname,
					seatCount,
					smallBlind: DEFAULT_SMALL_BLIND,
					bigBlind: DEFAULT_BIG_BLIND,
					startingStack: DEFAULT_STARTING_STACK,
				});
				refreshWidget(ctx);
				await openTable(ctx);
				return;
			}

			if (sub === "host") {
				closeSession(ctx);
				const port = Number(args[1]) || DEFAULT_PORT;
				session = createHostSession(
					{
						myId,
						displayName: hostname,
						seatCount: 6,
						smallBlind: DEFAULT_SMALL_BLIND,
						bigBlind: DEFAULT_BIG_BLIND,
						startingStack: DEFAULT_STARTING_STACK,
						port,
						onLog: (line) => ctx.ui.notify(line, "info"),
					},
					(boundPort) => ctx.ui.notify(`Hosting on port ${boundPort}. Share <your-ip>:${boundPort} for others to join.`, "info"),
				);
				refreshWidget(ctx);
				await openTable(ctx);
				return;
			}

			if (sub === "join") {
				const address = args[1];
				if (!address) {
					ctx.ui.notify("Usage: /poker join <host:port>", "warning");
					return;
				}
				closeSession(ctx);
				const url = address.startsWith("ws://") || address.startsWith("wss://") ? address : `ws://${address}`;
				session = createJoinSession({ url, myId, displayName: hostname }, (kind, message) => {
					if (kind === "rejected") {
						ctx.ui.notify(`Could not join: ${message ?? "unknown error"}`, "error");
						closeSession(ctx);
					}
				});
				refreshWidget(ctx);
				await openTable(ctx);
				return;
			}

			if (sub === "leave" || sub === "quit") {
				closeSession(ctx);
				ctx.ui.notify("Left the poker table", "info");
				return;
			}

			ctx.ui.notify("Usage: /poker bots [seats] | host [port] | join <host:port> | leave", "warning");
		},
	});

	pi.on("session_shutdown", () => {
		session?.close();
		session = null;
	});
}
