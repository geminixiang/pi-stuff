import type { Card, Rank, Suit } from "./types.ts";

export const SUITS: Suit[] = ["s", "h", "d", "c"];
export const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const RANK_LABEL: Record<Rank, string> = {
	2: "2",
	3: "3",
	4: "4",
	5: "5",
	6: "6",
	7: "7",
	8: "8",
	9: "9",
	10: "10",
	11: "J",
	12: "Q",
	13: "K",
	14: "A",
};

const SUIT_GLYPH: Record<Suit, string> = {
	s: "♠",
	h: "♥",
	d: "♦",
	c: "♣",
};

export function rankLabel(rank: Rank): string {
	return RANK_LABEL[rank];
}

export function suitGlyph(suit: Suit): string {
	return SUIT_GLYPH[suit];
}

export function isRedSuit(suit: Suit): boolean {
	return suit === "h" || suit === "d";
}

export function formatCard(card: Card): string {
	return `${rankLabel(card.rank)}${suitGlyph(card.suit)}`;
}

export function createDeck(): Card[] {
	const deck: Card[] = [];
	for (const suit of SUITS) {
		for (const rank of RANKS) deck.push({ rank, suit });
	}
	return deck;
}

/** Fisher-Yates shuffle. Returns a new array; does not mutate the input. */
export function shuffleDeck(deck: Card[], rng: () => number = Math.random): Card[] {
	const result = deck.slice();
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[result[i], result[j]] = [result[j] as Card, result[i] as Card];
	}
	return result;
}
