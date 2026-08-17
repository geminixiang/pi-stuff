import assert from "node:assert/strict";
import test from "node:test";
import { createDeck, formatCard, shuffleDeck } from "../src/engine/cards.ts";

test("creates a standard 52-card deck with no duplicates", () => {
	const deck = createDeck();
	assert.equal(deck.length, 52);
	const unique = new Set(deck.map((c) => `${c.rank}${c.suit}`));
	assert.equal(unique.size, 52);
});

test("shuffle is a pure permutation and does not mutate the input", () => {
	const deck = createDeck();
	const shuffled = shuffleDeck(deck, () => 0.5);
	assert.equal(deck.length, 52);
	assert.deepEqual(
		[...deck].sort((a, b) => a.rank - b.rank || a.suit.localeCompare(b.suit)),
		[...shuffled].sort((a, b) => a.rank - b.rank || a.suit.localeCompare(b.suit)),
	);
});

test("formats cards with rank labels and suit glyphs", () => {
	assert.equal(formatCard({ rank: 14, suit: "s" }), "A♠");
	assert.equal(formatCard({ rank: 10, suit: "h" }), "10♥");
	assert.equal(formatCard({ rank: 11, suit: "c" }), "J♣");
});
