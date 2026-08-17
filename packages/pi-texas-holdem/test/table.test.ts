import assert from "node:assert/strict";
import test from "node:test";
import { applyAction, computeSidePots, createTable, legalActions, seatPlayer, startHand } from "../src/engine/table.ts";
import type { Seat, TableState } from "../src/engine/types.ts";

function seat(id: string, stack: number, committed = 0, status: Seat["status"] = "active"): Seat {
	return {
		id,
		displayName: id,
		stack,
		holeCards: [],
		status,
		committed,
		totalCommitted: committed,
		hasActed: false,
		sittingOut: false,
	};
}

function baseState(seats: (Seat | null)[], overrides: Partial<TableState> = {}): TableState {
	return {
		seats,
		dealerIndex: 0,
		smallBlind: 5,
		bigBlind: 10,
		street: "preflop",
		communityCards: [],
		deck: [],
		toActIndex: 0,
		currentBet: 10,
		minRaise: 10,
		lastAggressorIndex: 1,
		handNumber: 1,
		pots: [],
		winners: [],
		awards: [],
		log: [],
		...overrides,
	};
}

test("legalActions reports call amount and raise bounds", () => {
	const state = baseState([seat("a", 100), seat("b", 90, 10), seat("c", 30, 10)]);
	const legal = legalActions(state, 0);
	assert.equal(legal.canCheck, false);
	assert.equal(legal.canCall, true);
	assert.equal(legal.callAmount, 10);
	assert.equal(legal.minRaiseTo, 20);
	assert.equal(legal.maxRaiseTo, 100);
});

test("legalActions caps raise-to at the seat's stack and disallows raising with a short stack", () => {
	const state = baseState([seat("a", 15), seat("b", 100, 30), seat("c", 100, 30)], {
		toActIndex: 0,
		currentBet: 30,
	});
	const legal = legalActions(state, 0);
	assert.equal(legal.callAmount, 15);
	assert.equal(legal.canBetOrRaise, false, "a 15-stack facing a 30 bet can only call all-in or fold");
	assert.equal(legal.maxRaiseTo, 15);
});

test("raise reopens action for other active players and updates min-raise size", () => {
	const state = baseState([seat("a", 100), seat("b", 90, 10), seat("c", 90, 10)]);
	const next = applyAction(state, 0, { type: "raise", amount: 30 });
	const a = next.seats[0] as Seat;
	assert.equal(a.committed, 30);
	assert.equal(a.stack, 70);
	assert.equal(next.currentBet, 30);
	assert.equal(next.minRaise, 20); // raised by 20 over the previous bet of 10
	assert.equal(next.lastAggressorIndex, 0);
	assert.equal((next.seats[1] as Seat).hasActed, false, "other active seats must act again after a raise");
	assert.equal(next.toActIndex, 1);
});

test("calling all-in for less than the current bet does not reopen betting", () => {
	const state = baseState([seat("a", 15), seat("b", 100, 30, "active"), seat("c", 100, 30, "active")], {
		toActIndex: 0,
		currentBet: 30,
		lastAggressorIndex: 1,
	});
	const next = applyAction(state, 0, { type: "call" });
	const a = next.seats[0] as Seat;
	assert.equal(a.status, "allIn");
	assert.equal(a.stack, 0);
	assert.equal(a.committed, 15);
	assert.equal(next.currentBet, 30, "current bet is unchanged by a short call");
	assert.equal(next.lastAggressorIndex, 1, "short all-in call is not an aggressive action");
});

test("computeSidePots splits a main pot and a side pot for an uneven all-in", () => {
	const seats: Seat[] = [
		seat("short", 0, 20), // all-in for 20 total
		seat("mid", 0, 20), // called the short stack, itself all-in too... but committed equals short here
		seat("big", 70, 60), // committed 60 total, more than the others
	];
	seats[2]!.totalCommitted = 60;
	seats[0]!.totalCommitted = 20;
	seats[1]!.totalCommitted = 20;
	const pots = computeSidePots(seats);
	// Layer 1: everyone contributes up to 20 -> pot of 60, all three eligible.
	// Layer 2: only "big" contributes the remaining 40 -> side pot of 40, only "big" eligible.
	assert.equal(pots.length, 2);
	assert.equal(pots[0]!.amount, 60);
	assert.deepEqual(new Set(pots[0]!.eligible), new Set(["short", "mid", "big"]));
	assert.equal(pots[1]!.amount, 40);
	assert.deepEqual(pots[1]!.eligible, ["big"]);
});

test("computeSidePots excludes folded players from eligibility but keeps their chips in the pot", () => {
	const seats: Seat[] = [seat("folder", 0, 20, "folded"), seat("stayer", 80, 20)];
	seats[0]!.totalCommitted = 20;
	seats[1]!.totalCommitted = 20;
	const pots = computeSidePots(seats);
	assert.equal(pots.length, 1);
	assert.equal(pots[0]!.amount, 40);
	assert.deepEqual(pots[0]!.eligible, ["stayer"]);
});

test("full hand simulation conserves total chips across many hands", () => {
	let state = createTable({ seatCount: 4, smallBlind: 5, bigBlind: 10 });
	const startingStack = 200;
	for (let i = 0; i < 4; i++) {
		state = seatPlayer(state, i, { id: `p${i}`, displayName: `p${i}`, stack: startingStack });
	}
	const totalChips = startingStack * 4;

	for (let hand = 0; hand < 25; hand++) {
		const seated = state.seats.filter((s) => s && s.stack > 0);
		if (seated.length < 2) break;
		state = startHand(state);

		let guard = 0;
		while (state.street !== "showdown" && guard < 200) {
			guard++;
			const idx = state.toActIndex;
			if (idx === null) break;
			const legal = legalActions(state, idx);
			// Bots always check/call to keep the simulation simple and deterministic-ish.
			const action = legal.canCheck ? ({ type: "check" } as const) : ({ type: "call" } as const);
			state = applyAction(state, idx, action);
		}

		const sumStacks = state.seats.reduce((total, s) => total + (s ? s.stack : 0), 0);
		assert.equal(sumStacks, totalChips, `chips must be conserved after hand ${hand + 1}`);
		for (const s of state.seats) {
			if (s) assert.ok(s.stack >= 0, "no seat should have a negative stack");
		}
	}
});
