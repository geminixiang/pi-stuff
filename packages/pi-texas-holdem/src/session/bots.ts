import { secureRandom } from "../engine/random.ts";
import { applyAction, createTable, legalActions, seatPlayer, startHand } from "../engine/table.ts";
import type { Action, TableState } from "../engine/types.ts";
import { redactStateFor } from "../engine/view.ts";
import type { ChatMessage } from "../net/protocol.ts";
import { sanitizeChatText } from "../net/sanitize.ts";
import { createSessionEmitter } from "./emitter.ts";
import type { GameSession, LocalSessionOptions } from "./types.ts";

const CHAT_LOG_LIMIT = 200;
const BOT_DELAY_MS = 450;

export interface BotsSessionDependencies {
	random?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
	now?: () => number;
}

function botDecision(state: TableState, seatIndex: number, random: () => number): Action {
	const legal = legalActions(state, seatIndex);
	const roll = random();
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

/** Solo play against simple local bots. No networking or Node-specific APIs. */
export function createBotsSession(opts: LocalSessionOptions, dependencies: BotsSessionDependencies = {}): GameSession {
	const random = dependencies.random ?? secureRandom;
	const setTimer = dependencies.setTimer ?? setTimeout;
	const clearTimer = dependencies.clearTimer ?? clearTimeout;
	const now = dependencies.now ?? Date.now;
	let state = createTable({ seatCount: opts.seatCount, smallBlind: opts.smallBlind, bigBlind: opts.bigBlind });
	state = seatPlayer(state, 0, { id: opts.myId, displayName: opts.displayName, stack: opts.startingStack });
	for (let i = 1; i < opts.seatCount; i++) {
		state = seatPlayer(state, i, { id: `bot-${i}`, displayName: `bot-${i}`, stack: opts.startingStack });
	}
	const emitter = createSessionEmitter();
	let botTimer: ReturnType<typeof setTimeout> | undefined;
	let chatLog: ChatMessage[] = [];
	let announcedLogLength = 0;
	let chatCounter = 0;
	let closed = false;

	const pushChat = (seatIndex: number | null, displayName: string, text: string) => {
		chatLog = [...chatLog, { id: `local-${++chatCounter}`, seatIndex, displayName, text, ts: now() }].slice(-CHAT_LOG_LIMIT);
	};
	const announceNewLog = () => {
		while (announcedLogLength < state.log.length) pushChat(null, "table", state.log[announcedLogLength++] as string);
	};
	const scheduleBotTurn = () => {
		if (closed || botTimer) return;
		const toAct = state.toActIndex;
		if (toAct === null || toAct === 0 || state.street === "showdown") return;
		botTimer = setTimer(() => {
			botTimer = undefined;
			const index = state.toActIndex;
			if (closed || index === null || index === 0 || state.street === "showdown") return;
			try {
				state = applyAction(state, index, botDecision(state, index, random));
			} catch {
				state = applyAction(state, index, { type: "fold" });
			}
			announceNewLog();
			emitter.emit();
			scheduleBotTurn();
		}, BOT_DELAY_MS);
	};

	return {
		info: { roomLabel: "Local vs bots", myId: opts.myId, mySeatIndex: 0 },
		getState: () => redactStateFor(state, opts.myId),
		legalActionsForMe: () => legalActions(state, 0),
		canStartHand: () => state.street === "showdown" && state.seats.filter((seat) => seat && seat.stack > 0).length >= 2,
		startHand: () => {
			state = startHand(state, random);
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
			closed = true;
			if (botTimer) clearTimer(botTimer);
			botTimer = undefined;
			emitter.clear();
		},
	};
}
