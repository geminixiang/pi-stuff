import type { LegalActions } from "../engine/types.ts";
import type { PublicTableState } from "../engine/view.ts";
import { RoomClient } from "../net/client.ts";
import type { ChatMessage } from "../net/protocol.ts";
import { createSessionEmitter } from "./emitter.ts";
import type { GameSession, JoinSessionEvent, JoinSessionOptions } from "./types.ts";
import { shareableRoomUrl } from "../ui/commands.ts";

const CHAT_LOG_LIMIT = 200;
const NO_LEGAL_ACTIONS: LegalActions = {
	canFold: false,
	canCheck: false,
	canCall: false,
	callAmount: 0,
	canBetOrRaise: false,
	minRaiseTo: 0,
	maxRaiseTo: 0,
};
const EMPTY_STATE: PublicTableState = {
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

export function legalActionsFromPublicState(state: PublicTableState, seatIndex: number): LegalActions {
	const seat = state.seats[seatIndex];
	if (!seat || state.toActIndex !== seatIndex || seat.status !== "active") return NO_LEGAL_ACTIONS;
	const toCall = Math.max(0, state.currentBet - seat.committed);
	const callAmount = Math.min(toCall, seat.stack);
	const maxRaiseTo = seat.committed + seat.stack;
	return {
		canFold: true,
		canCheck: toCall === 0,
		canCall: toCall > 0 && seat.stack > 0,
		callAmount,
		canBetOrRaise: seat.stack > callAmount,
		minRaiseTo: Math.min(state.currentBet + state.minRaise, maxRaiseTo),
		maxRaiseTo,
	};
}

/** Node WebSocket client adapter for the runtime-neutral GameSession boundary. */
export function createJoinSession(
	opts: JoinSessionOptions,
	onEvent: (event: JoinSessionEvent, message?: string) => void,
): GameSession {
	const emitter = createSessionEmitter();
	let lastState: PublicTableState | undefined;
	let mySeatIndex: number | null = null;
	let chatLog: ChatMessage[] = [];
	let welcomed = false;
	const info = { roomLabel: `Connected to ${shareableRoomUrl(opts.url)}`, myId: opts.myId, get mySeatIndex() { return mySeatIndex; } };

	const client = new RoomClient({
		url: opts.url,
		playerId: opts.myId,
		displayName: opts.displayName,
		onWelcome: (welcome) => {
			welcomed = true;
			mySeatIndex = welcome.seatIndex;
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
		onError: (message) => onEvent("error", message),
		onClose: () => onEvent(welcomed ? "hostDisconnected" : "rejected", welcomed ? undefined : "Connection closed"),
	});

	return {
		info,
		getState: () => lastState ?? EMPTY_STATE,
		legalActionsForMe: () => (mySeatIndex === null || !lastState ? null : legalActionsFromPublicState(lastState, mySeatIndex)),
		canStartHand: () => opts.canStartHands === true && welcomed && lastState?.street === "showdown",
		startHand: () => {
			if (opts.canStartHands === true) client.startHand();
		},
		act: (action) => client.sendAction(action),
		getChatLog: () => chatLog,
		sendChat: (text) => client.sendChat(text),
		subscribe: emitter.subscribe,
		close: () => {
			emitter.clear();
			client.close();
		},
	};
}
