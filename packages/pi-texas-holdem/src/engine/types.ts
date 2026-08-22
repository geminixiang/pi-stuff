export type Suit = "s" | "h" | "d" | "c";

/** 11=J, 12=Q, 13=K, 14=A */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
	rank: Rank;
	suit: Suit;
}

export type Street = "preflop" | "flop" | "turn" | "river" | "showdown";

export type SeatStatus = "active" | "folded" | "allIn";

export interface Seat {
	id: string;
	displayName: string;
	stack: number;
	holeCards: Card[];
	status: SeatStatus;
	/** Chips committed in the current betting round. */
	committed: number;
	/** Chips committed across the whole hand, used for side-pot math. */
	totalCommitted: number;
	/** Whether this seat has acted since the last bet/raise. */
	hasActed: boolean;
	sittingOut: boolean;
}

export type Action =
	| { type: "fold" }
	| { type: "check" }
	| { type: "call" }
	/** `amount` is the total this seat will have committed this round after the action. */
	| { type: "bet"; amount: number }
	| { type: "raise"; amount: number }
	| { type: "allin" };

export interface Pot {
	amount: number;
	/** Seat ids allowed to win this pot. */
	eligible: string[];
}

export type HandCategory =
	| "highCard"
	| "pair"
	| "twoPair"
	| "trips"
	| "straight"
	| "flush"
	| "fullHouse"
	| "quads"
	| "straightFlush";

export interface HandEvaluation {
	category: HandCategory;
	/** 0 (high card) .. 8 (straight flush) */
	rank: number;
	tiebreak: number[];
	hand: Card[];
}

export interface HandResult {
	seatId: string;
	evaluation: HandEvaluation;
}

export interface PotAward {
	potIndex: number;
	amount: number;
	/** Split evenly among these seat ids (odd chips go to the first). */
	seatIds: string[];
}

export interface TableState {
	seats: (Seat | null)[];
	dealerIndex: number;
	smallBlind: number;
	bigBlind: number;
	street: Street;
	communityCards: Card[];
	deck: Card[];
	toActIndex: number | null;
	currentBet: number;
	minRaise: number;
	lastAggressorIndex: number | null;
	handNumber: number;
	pots: Pot[];
	winners: HandResult[];
	awards: PotAward[];
	log: string[];
}

export interface LegalActions {
	canFold: boolean;
	canCheck: boolean;
	canCall: boolean;
	callAmount: number;
	canBetOrRaise: boolean;
	minRaiseTo: number;
	maxRaiseTo: number;
}
