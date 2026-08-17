import type { Card, HandCategory, HandEvaluation } from "./types.ts";

const CATEGORY_BY_RANK: HandCategory[] = [
	"highCard",
	"pair",
	"twoPair",
	"trips",
	"straight",
	"flush",
	"fullHouse",
	"quads",
	"straightFlush",
];

function straightHighCard(ranksDesc: number[]): number | null {
	const uniq = [...new Set(ranksDesc)];
	const highs: number[] = [];
	for (let i = 0; i + 4 < uniq.length; i++) {
		if ((uniq[i] as number) - (uniq[i + 4] as number) === 4) highs.push(uniq[i] as number);
	}
	if ([14, 5, 4, 3, 2].every((r) => uniq.includes(r))) highs.push(5);
	return highs.length ? Math.max(...highs) : null;
}

function evaluate5(cards: Card[]): Omit<HandEvaluation, "hand"> {
	const ranksDesc = cards.map((c) => c.rank as number).sort((a, b) => b - a);
	const isFlush = cards.every((c) => c.suit === cards[0]?.suit);

	const counts = new Map<number, number>();
	for (const r of ranksDesc) counts.set(r, (counts.get(r) ?? 0) + 1);
	const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
	const pattern = groups.map(([, count]) => count).join("");

	const straightHigh = straightHighCard(ranksDesc);
	const isStraight = straightHigh !== null;

	if (isStraight && isFlush) return { category: "straightFlush", rank: 8, tiebreak: [straightHigh as number] };
	if (pattern === "41") return { category: "quads", rank: 7, tiebreak: [groups[0]![0], groups[1]![0]] };
	if (pattern === "32") return { category: "fullHouse", rank: 6, tiebreak: [groups[0]![0], groups[1]![0]] };
	if (isFlush) return { category: "flush", rank: 5, tiebreak: ranksDesc };
	if (isStraight) return { category: "straight", rank: 4, tiebreak: [straightHigh as number] };
	if (pattern === "311")
		return { category: "trips", rank: 3, tiebreak: [groups[0]![0], groups[1]![0], groups[2]![0]] };
	if (pattern === "221")
		return { category: "twoPair", rank: 2, tiebreak: [groups[0]![0], groups[1]![0], groups[2]![0]] };
	if (pattern === "2111")
		return {
			category: "pair",
			rank: 1,
			tiebreak: [groups[0]![0], groups[1]![0], groups[2]![0], groups[3]![0]],
		};
	return { category: "highCard", rank: 0, tiebreak: ranksDesc };
}

function combinations5(cards: Card[]): Card[][] {
	const result: Card[][] = [];
	const n = cards.length;
	for (let a = 0; a < n; a++) {
		for (let b = a + 1; b < n; b++) {
			for (let c = b + 1; c < n; c++) {
				for (let d = c + 1; d < n; d++) {
					for (let e = d + 1; e < n; e++) {
						result.push([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
					}
				}
			}
		}
	}
	return result;
}

export function compareEvaluations(a: HandEvaluation, b: HandEvaluation): number {
	if (a.rank !== b.rank) return a.rank - b.rank;
	const len = Math.max(a.tiebreak.length, b.tiebreak.length);
	for (let i = 0; i < len; i++) {
		const diff = (a.tiebreak[i] ?? 0) - (b.tiebreak[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Evaluates the best 5-card hand out of 5-7 cards (hole cards + community cards). */
export function evaluateBestHand(cards: Card[]): HandEvaluation {
	if (cards.length < 5) throw new Error(`evaluateBestHand needs at least 5 cards, got ${cards.length}`);
	const combos = cards.length === 5 ? [cards] : combinations5(cards);
	let best: HandEvaluation | undefined;
	for (const combo of combos) {
		const evaluated = { ...evaluate5(combo), hand: combo };
		if (!best || compareEvaluations(evaluated, best) > 0) best = evaluated;
	}
	return best as HandEvaluation;
}

export function categoryLabel(category: HandCategory): string {
	switch (category) {
		case "highCard":
			return "High Card";
		case "pair":
			return "Pair";
		case "twoPair":
			return "Two Pair";
		case "trips":
			return "Three of a Kind";
		case "straight":
			return "Straight";
		case "flush":
			return "Flush";
		case "fullHouse":
			return "Full House";
		case "quads":
			return "Four of a Kind";
		case "straightFlush":
			return "Straight Flush";
	}
}

export function categoryFromRank(rank: number): HandCategory {
	return CATEGORY_BY_RANK[rank] as HandCategory;
}
