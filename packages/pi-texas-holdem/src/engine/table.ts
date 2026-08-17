import { createDeck, shuffleDeck } from "./cards.ts";
import { compareEvaluations, evaluateBestHand } from "./evaluator.ts";
import type { Action, Card, HandResult, LegalActions, Pot, PotAward, Seat, TableState } from "./types.ts";

export interface TableConfig {
	seatCount: number;
	smallBlind: number;
	bigBlind: number;
}

export function createTable(config: TableConfig): TableState {
	return {
		seats: Array.from({ length: config.seatCount }, () => null),
		dealerIndex: -1,
		smallBlind: config.smallBlind,
		bigBlind: config.bigBlind,
		street: "showdown",
		communityCards: [],
		deck: [],
		toActIndex: null,
		currentBet: 0,
		minRaise: config.bigBlind,
		lastAggressorIndex: null,
		handNumber: 0,
		pots: [],
		winners: [],
		awards: [],
		log: [],
	};
}

export function seatPlayer(
	state: TableState,
	seatIndex: number,
	player: { id: string; displayName: string; stack: number },
): TableState {
	const seats = state.seats.slice();
	seats[seatIndex] = {
		id: player.id,
		displayName: player.displayName,
		stack: player.stack,
		holeCards: [],
		status: "active",
		committed: 0,
		totalCommitted: 0,
		hasActed: false,
		sittingOut: false,
	};
	return { ...state, seats };
}

export function leaveSeat(state: TableState, seatIndex: number): TableState {
	const seats = state.seats.slice();
	seats[seatIndex] = null;
	return { ...state, seats };
}

function occupiedCount(state: TableState): number {
	return state.seats.filter((s) => s && !s.sittingOut && s.stack > 0).length;
}

/** Active (occupied, playable) seat indices in circular order, starting at and including `from`. */
function activeSeatIndicesFrom(seats: (Seat | null)[], from: number): number[] {
	const n = seats.length;
	const result: number[] = [];
	for (let i = 0; i < n; i++) {
		const idx = (from + i) % n;
		const seat = seats[idx];
		if (seat && !seat.sittingOut && seat.stack > 0) result.push(idx);
	}
	return result;
}

/** Next seat (strictly after `from`) that can still act this street, or null. */
function nextActingSeatIndex(seats: (Seat | null)[], from: number): number | null {
	const n = seats.length;
	for (let i = 1; i <= n; i++) {
		const idx = (from + i) % n;
		const seat = seats[idx];
		if (seat && seat.status === "active") return idx;
	}
	return null;
}

function contenders(state: TableState): { index: number; seat: Seat }[] {
	return state.seats
		.map((seat, index) => ({ seat, index }))
		.filter((entry): entry is { index: number; seat: Seat } => !!entry.seat && entry.seat.status !== "folded");
}

export function startHand(state: TableState, rng: () => number = Math.random): TableState {
	if (occupiedCount(state) < 2) throw new Error("Need at least 2 seated players with chips to start a hand");

	const dealerIndex =
		state.dealerIndex < 0
			? (activeSeatIndicesFrom(state.seats, 0)[0] as number)
			: (nextActingDealerIndex(state.seats, state.dealerIndex) ?? state.dealerIndex);

	const seats = state.seats.map((seat) => {
		if (!seat) return null;
		if (seat.sittingOut || seat.stack <= 0) return { ...seat, holeCards: [], committed: 0, totalCommitted: 0 };
		return {
			...seat,
			holeCards: [],
			status: "active" as const,
			committed: 0,
			totalCommitted: 0,
			hasActed: false,
		};
	});

	const order = activeSeatIndicesFrom(seats, dealerIndex);
	const headsUp = order.length === 2;
	const sbIndex = headsUp ? (order[0] as number) : (order[1] as number);
	const bbIndex = headsUp ? (order[1] as number) : (order[2] as number);

	let deck = shuffleDeck(createDeck(), rng);
	const log: string[] = [];

	const postBlind = (index: number, amount: number, label: string) => {
		const seat = seats[index] as Seat;
		const posted = Math.min(amount, seat.stack);
		seat.stack -= posted;
		seat.committed += posted;
		seat.totalCommitted += posted;
		if (seat.stack === 0) seat.status = "allIn";
		log.push(`${seat.displayName} posts ${label} ${posted}`);
	};

	postBlind(sbIndex, state.smallBlind, "small blind");
	postBlind(bbIndex, state.bigBlind, "big blind");

	for (let round = 0; round < 2; round++) {
		for (const idx of activeSeatIndicesFrom(seats, sbIndex)) {
			const seat = seats[idx] as Seat;
			const card = deck.pop() as Card;
			seat.holeCards.push(card);
		}
	}

	const toActIndex = nextActingSeatIndex(seats, bbIndex);

	return {
		...state,
		seats,
		dealerIndex,
		street: "preflop",
		communityCards: [],
		deck,
		toActIndex,
		currentBet: state.bigBlind,
		minRaise: state.bigBlind,
		lastAggressorIndex: bbIndex,
		handNumber: state.handNumber + 1,
		pots: [],
		winners: [],
		awards: [],
		log,
	};
}

function nextActingDealerIndex(seats: (Seat | null)[], from: number): number | null {
	const n = seats.length;
	const wrapped = activeSeatIndicesFrom(seats, (from + 1) % n);
	return wrapped[0] ?? null;
}

export function legalActions(state: TableState, seatIndex: number): LegalActions {
	const seat = state.seats[seatIndex];
	if (!seat || state.toActIndex !== seatIndex || seat.status !== "active") {
		return { canFold: false, canCheck: false, canCall: false, callAmount: 0, canBetOrRaise: false, minRaiseTo: 0, maxRaiseTo: 0 };
	}
	const toCall = Math.max(0, state.currentBet - seat.committed);
	const callAmount = Math.min(toCall, seat.stack);
	const canCheck = toCall === 0;
	const canCall = toCall > 0 && seat.stack > 0;
	const maxRaiseTo = seat.committed + seat.stack;
	const desiredMinRaiseTo = state.currentBet + state.minRaise;
	const minRaiseTo = Math.min(desiredMinRaiseTo, maxRaiseTo);
	const canBetOrRaise = seat.stack > callAmount;

	return { canFold: true, canCheck, canCall, callAmount, canBetOrRaise, minRaiseTo, maxRaiseTo };
}

function computeSidePots(seats: Seat[]): Pot[] {
	const contributors = seats.filter((s) => s.totalCommitted > 0);
	const levels = [...new Set(contributors.map((s) => s.totalCommitted))].sort((a, b) => a - b);
	const pots: Pot[] = [];
	let prev = 0;
	for (const level of levels) {
		const layer = contributors.filter((s) => s.totalCommitted >= level);
		const amount = (level - prev) * layer.length;
		if (amount > 0) {
			const eligible = layer.filter((s) => s.status !== "folded").map((s) => s.id);
			pots.push({ amount, eligible });
		}
		prev = level;
	}
	return pots;
}

function awardPots(pots: Pot[], seats: Seat[], evaluations: Map<string, ReturnType<typeof evaluateBestHand>>): PotAward[] {
	const seatOrder = seats.map((s) => s.id);
	const awards: PotAward[] = [];
	pots.forEach((pot, potIndex) => {
		const eligible = pot.eligible.filter((id) => evaluations.has(id) || pot.eligible.length === 1);
		let winners: string[];
		if (evaluations.size === 0) {
			winners = eligible;
		} else {
			let best: string[] = [];
			let bestEval: ReturnType<typeof evaluateBestHand> | undefined;
			for (const id of eligible) {
				const evaluation = evaluations.get(id);
				if (!evaluation) continue;
				if (!bestEval || compareEvaluations(evaluation, bestEval) > 0) {
					bestEval = evaluation;
					best = [id];
				} else if (compareEvaluations(evaluation, bestEval) === 0) {
					best.push(id);
				}
			}
			winners = best.length ? best : eligible;
		}
		winners.sort((a, b) => seatOrder.indexOf(a) - seatOrder.indexOf(b));
		const share = Math.floor(pot.amount / winners.length);
		let remainder = pot.amount - share * winners.length;
		for (const id of winners) {
			const bonus = remainder > 0 ? 1 : 0;
			if (remainder > 0) remainder--;
			awards.push({ potIndex, amount: share + bonus, seatIds: [id] });
			const seat = seats.find((s) => s.id === id) as Seat;
			seat.stack += share + bonus;
		}
	});
	return awards;
}

function resetHandChips(seats: (Seat | null)[]): (Seat | null)[] {
	return seats.map((seat) => (seat ? { ...seat, committed: 0, totalCommitted: 0 } : null));
}

function finishHandByFold(state: TableState): TableState {
	const remaining = contenders(state);
	const winner = remaining[0] as { index: number; seat: Seat };
	const seats = state.seats.map((s) => (s ? { ...s } : null));
	const pots = computeSidePots(seats.filter((s): s is Seat => !!s));
	const awards = awardPots(pots, seats.filter((s): s is Seat => !!s), new Map());
	const log = [...state.log, `${winner.seat.displayName} wins uncontested`];
	return {
		...state,
		seats: resetHandChips(seats),
		street: "showdown",
		toActIndex: null,
		pots,
		winners: [],
		awards,
		log,
	};
}

function runShowdown(state: TableState): TableState {
	const seats = state.seats.map((s) => (s ? { ...s } : null));
	const inHand = seats.filter((s): s is Seat => !!s && s.status !== "folded");
	const evaluations = new Map<string, ReturnType<typeof evaluateBestHand>>();
	const winners: HandResult[] = [];
	for (const seat of inHand) {
		const evaluation = evaluateBestHand([...seat.holeCards, ...state.communityCards]);
		evaluations.set(seat.id, evaluation);
		winners.push({ seatId: seat.id, evaluation });
	}
	const pots = computeSidePots(seats.filter((s): s is Seat => !!s));
	const awards = awardPots(pots, seats.filter((s): s is Seat => !!s), evaluations);
	const log = [...state.log, "Showdown"];
	return {
		...state,
		seats: resetHandChips(seats),
		street: "showdown",
		toActIndex: null,
		pots,
		winners,
		awards,
		log,
	};
}

function dealStreet(state: TableState): TableState {
	const deck = state.deck.slice();
	const communityCards = state.communityCards.slice();
	let street = state.street;

	const dealNext = () => {
		deck.pop(); // burn
		if (street === "preflop") {
			communityCards.push(deck.pop() as Card, deck.pop() as Card, deck.pop() as Card);
			street = "flop";
		} else if (street === "flop") {
			communityCards.push(deck.pop() as Card);
			street = "turn";
		} else if (street === "turn") {
			communityCards.push(deck.pop() as Card);
			street = "river";
		}
	};
	dealNext();

	const seats = state.seats.map((seat) => (seat ? { ...seat, committed: 0, hasActed: false } : null));
	const stillActing = seats.filter((s) => s && s.status === "active").length;

	let next: TableState = {
		...state,
		seats,
		street,
		communityCards,
		deck,
		currentBet: 0,
		minRaise: state.bigBlind,
		lastAggressorIndex: null,
		toActIndex: stillActing > 0 ? nextActingSeatIndex(seats, state.dealerIndex) : null,
		log: [...state.log, `-- ${street} --`],
	};

	if (stillActing <= 1) {
		// Everyone left is all-in (or only one seat can still act): run the board out.
		if (street === "river") return runShowdown(next);
		return dealStreet(next);
	}
	return next;
}

function bettingRoundComplete(state: TableState): boolean {
	const inHand = contenders(state);
	const actionable = inHand.filter((c) => c.seat.status === "active");
	if (actionable.length === 0) return true;
	return actionable.every((c) => c.seat.hasActed && c.seat.committed === state.currentBet);
}

export function applyAction(state: TableState, seatIndex: number, action: Action): TableState {
	if (state.toActIndex !== seatIndex) throw new Error("It is not this seat's turn to act");
	const seat = state.seats[seatIndex];
	if (!seat || seat.status !== "active") throw new Error("Seat cannot act");
	const legal = legalActions(state, seatIndex);

	const seats = state.seats.map((s) => (s ? { ...s } : null));
	const acting = seats[seatIndex] as Seat;
	let currentBet = state.currentBet;
	let minRaise = state.minRaise;
	let lastAggressorIndex = state.lastAggressorIndex;
	let raised = false;
	const log = [...state.log];

	switch (action.type) {
		case "fold": {
			acting.status = "folded";
			log.push(`${acting.displayName} folds`);
			break;
		}
		case "check": {
			if (!legal.canCheck) throw new Error("Cannot check facing a bet");
			acting.hasActed = true;
			log.push(`${acting.displayName} checks`);
			break;
		}
		case "call": {
			if (!legal.canCheck && !legal.canCall) throw new Error("Nothing to call");
			const amount = legal.callAmount;
			acting.stack -= amount;
			acting.committed += amount;
			acting.totalCommitted += amount;
			if (acting.stack === 0) acting.status = "allIn";
			acting.hasActed = true;
			log.push(`${acting.displayName} calls ${amount}`);
			break;
		}
		case "bet":
		case "raise": {
			const amount = action.amount;
			if (amount < legal.minRaiseTo || amount > legal.maxRaiseTo) {
				throw new Error(`Raise must be between ${legal.minRaiseTo} and ${legal.maxRaiseTo}`);
			}
			const delta = amount - acting.committed;
			acting.stack -= delta;
			acting.committed = amount;
			acting.totalCommitted += delta;
			if (acting.stack === 0) acting.status = "allIn";
			acting.hasActed = true;
			minRaise = Math.max(minRaise, amount - currentBet);
			currentBet = amount;
			lastAggressorIndex = seatIndex;
			raised = true;
			log.push(`${acting.displayName} ${action.type}s to ${amount}`);
			break;
		}
		case "allin": {
			const delta = acting.stack;
			const amount = acting.committed + delta;
			acting.stack = 0;
			acting.committed = amount;
			acting.totalCommitted += delta;
			acting.status = "allIn";
			acting.hasActed = true;
			log.push(`${acting.displayName} goes all-in for ${amount}`);
			if (amount > currentBet) {
				minRaise = Math.max(minRaise, amount - currentBet);
				currentBet = amount;
				lastAggressorIndex = seatIndex;
				raised = true;
			}
			break;
		}
	}

	if (raised) {
		for (const s of seats) {
			if (s && s.status === "active" && s.id !== acting.id) s.hasActed = false;
		}
	}

	let next: TableState = { ...state, seats, currentBet, minRaise, lastAggressorIndex, log };

	const stillIn = contenders(next);
	if (stillIn.length <= 1) {
		return finishHandByFold(next);
	}

	if (bettingRoundComplete(next)) {
		if (next.street === "river") return runShowdown(next);
		return dealStreet(next);
	}

	next = { ...next, toActIndex: nextActingSeatIndex(seats, seatIndex) };
	return next;
}

export { computeSidePots, bettingRoundComplete };
