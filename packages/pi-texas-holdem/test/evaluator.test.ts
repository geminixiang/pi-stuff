import assert from "node:assert/strict";
import test from "node:test";
import type { Card } from "../src/engine/types.ts";
import { compareEvaluations, describeHand, evaluateBestHand } from "../src/engine/evaluator.ts";

function cards(spec: string): Card[] {
	// spec like "As Kd Qh Jc 10s" -> rank 2-10 or A/K/Q/J, suit s/h/d/c
	return spec.split(/\s+/).map((token) => {
		const suit = token.slice(-1) as Card["suit"];
		const rankToken = token.slice(0, -1);
		const rank =
			rankToken === "A" ? 14 : rankToken === "K" ? 13 : rankToken === "Q" ? 12 : rankToken === "J" ? 11 : Number(rankToken);
		return { rank: rank as Card["rank"], suit };
	});
}

test("recognizes a straight flush", () => {
	const evaluation = evaluateBestHand(cards("9s 8s 7s 6s 5s 2h 3c"));
	assert.equal(evaluation.category, "straightFlush");
	assert.equal(evaluation.tiebreak[0], 9);
});

test("recognizes the wheel (A-5 straight) as low", () => {
	const evaluation = evaluateBestHand(cards("As 2s 3d 4h 5c 9h Kc"));
	assert.equal(evaluation.category, "straight");
	assert.equal(evaluation.tiebreak[0], 5);
});

test("recognizes four of a kind over a full house", () => {
	const quads = evaluateBestHand(cards("7s 7h 7d 7c 2h 3c 4d"));
	const fullHouse = evaluateBestHand(cards("Ks Kh Kd 9c 9h 2c 3d"));
	assert.equal(quads.category, "quads");
	assert.equal(fullHouse.category, "fullHouse");
	assert.ok(compareEvaluations(quads, fullHouse) > 0);
});

test("full house beats flush beats straight beats trips", () => {
	const fullHouse = evaluateBestHand(cards("Ks Kh Kd 9c 9h 2c 3d"));
	const flush = evaluateBestHand(cards("2s 5s 9s Js Ks 3h 4d"));
	const straight = evaluateBestHand(cards("5s 6h 7d 8c 9h 2c 3d"));
	const trips = evaluateBestHand(cards("4s 4h 4d 9c 2h 6c 7d"));
	assert.ok(compareEvaluations(fullHouse, flush) > 0);
	assert.ok(compareEvaluations(flush, straight) > 0);
	assert.ok(compareEvaluations(straight, trips) > 0);
});

test("picks the best 5 of 7 cards (kicker matters)", () => {
	// Board pairs the board; both players use the same board pair plus best kicker.
	const board = cards("Ks Kh 2d 5c 9h");
	const strongKicker = evaluateBestHand([...cards("As Qs"), ...board]);
	const weakKicker = evaluateBestHand([...cards("4h 3c"), ...board]);
	assert.equal(strongKicker.category, "pair");
	assert.equal(weakKicker.category, "pair");
	assert.ok(compareEvaluations(strongKicker, weakKicker) > 0);
});

test("two pair compares the higher pair first, then the lower pair, then kicker", () => {
	const better = evaluateBestHand(cards("Ks Kh 9d 9c 2h 3c 7d"));
	const worse = evaluateBestHand(cards("Qs Qh 9d 9c Ah 3c 7d"));
	assert.equal(better.category, "twoPair");
	assert.equal(worse.category, "twoPair");
	assert.ok(compareEvaluations(better, worse) > 0);
});

test("describes hands in beginner-friendly language", () => {
	assert.equal(describeHand(cards("As Ah")), "Pair of Aces");
	assert.equal(describeHand(cards("As 10s")), "Ace high · suited");
	assert.equal(describeHand(evaluateBestHand(cards("Ks Kh 9d 9c 2h 3c 7d"))), "Two Pair · Kings and 9s");
	assert.equal(describeHand(evaluateBestHand(cards("Ks Kh Kd 9c 9h 2c 3d"))), "Full House · Kings over 9s");
	assert.equal(describeHand(evaluateBestHand(cards("As 2s 3d 4h 5c 9h Kc"))), "Straight · 5 high");
});

test("identical hands tie", () => {
	const a = evaluateBestHand(cards("As Ks Qs Js 9s 2h 3c"));
	const b = evaluateBestHand(cards("Ah Kh Qh Jh 9h 2c 3d"));
	assert.equal(compareEvaluations(a, b), 0);
});
