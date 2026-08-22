import type { Card, HandResult, PotAward, Pot, Seat, Street, TableState } from "./types.ts";

export interface PublicSeat {
	id: string;
	displayName: string;
	stack: number;
	committed: number;
	status: Seat["status"];
	sittingOut: boolean;
	/** null entries are face-down cards hidden from this viewer. */
	holeCards: (Card | null)[];
}

export interface PublicTableState {
	seats: (PublicSeat | null)[];
	dealerIndex: number;
	smallBlind: number;
	bigBlind: number;
	street: Street;
	communityCards: Card[];
	toActIndex: number | null;
	currentBet: number;
	minRaise: number;
	handNumber: number;
	pots: Pot[];
	winners: HandResult[];
	awards: PotAward[];
	log: string[];
}

/** Redacts hole cards other players shouldn't see yet for the given viewer. */
export function redactStateFor(state: TableState, viewerId: string | undefined): PublicTableState {
	const seats = state.seats.map((seat): PublicSeat | null => {
		if (!seat) return null;
		const revealed = seat.id === viewerId || (state.street === "showdown" && seat.status !== "folded");
		return {
			id: seat.id,
			displayName: seat.displayName,
			stack: seat.stack,
			committed: seat.committed,
			status: seat.status,
			sittingOut: seat.sittingOut,
			holeCards: revealed ? seat.holeCards : seat.holeCards.map(() => null),
		};
	});

	return {
		seats,
		dealerIndex: state.dealerIndex,
		smallBlind: state.smallBlind,
		bigBlind: state.bigBlind,
		street: state.street,
		communityCards: state.communityCards,
		toActIndex: state.toActIndex,
		currentBet: state.currentBet,
		minRaise: state.minRaise,
		handNumber: state.handNumber,
		pots: state.pots,
		winners: state.winners,
		awards: state.awards,
		log: state.log,
	};
}
