import { legalActions } from "../engine/table.ts";
import { redactStateFor } from "../engine/view.ts";
import { HostRoom } from "../net/host.ts";
import { createSessionEmitter } from "./emitter.ts";
import type { GameSession, HostSessionOptions } from "./types.ts";

/** Node WebSocket adapter for the runtime-neutral GameSession boundary. */
export function createHostSession(opts: HostSessionOptions, onReady: (port: number) => void): GameSession {
	const emitter = createSessionEmitter();
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
	room.waitForListening().then(onReady).catch(() => {});

	return {
		info: { roomLabel: "Hosting", myId: opts.myId, mySeatIndex: 0 },
		getState: () => redactStateFor(room.state, opts.myId),
		legalActionsForMe: () => legalActions(room.state, 0),
		canStartHand: () => room.canStartHand() && room.state.street === "showdown",
		startHand: () => room.startHand(),
		act: (action) => room.applyLocalAction(0, action),
		getChatLog: () => room.getChatHistory(),
		sendChat: (text) => room.sendLocalChat(0, text),
		subscribe: emitter.subscribe,
		close: () => {
			emitter.clear();
			room.close();
		},
	};
}
