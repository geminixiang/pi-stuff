import assert from "node:assert/strict";
import test from "node:test";
import { centerOnRow, generateRing, layoutTable, stampBlock } from "../src/engine/ring.ts";

test("generateRing produces the requested dimensions using only box-drawing glyphs and spaces", () => {
	const ring = generateRing(74, 15);
	assert.equal(ring.rows.length, 15);
	for (const row of ring.rows) {
		assert.equal([...row].length, 74);
		for (const ch of row) assert.ok(/[│─╮╭╰╯ ]/.test(ch), `unexpected glyph: ${JSON.stringify(ch)}`);
	}
});

test("the ring is left-right symmetric", () => {
	// Odd width so there's a true center column and rounding can't introduce a 1-column skew.
	const ring = generateRing(75, 15);
	for (const row of ring.rows) {
		const chars = [...row];
		const mirrored = [...chars].reverse();
		// Mirroring swaps ╮<->╭ and ╯<->╰; │/─/space are self-symmetric.
		const swap = (c: string) => (c === "╮" ? "╭" : c === "╭" ? "╮" : c === "╯" ? "╰" : c === "╰" ? "╯" : c);
		assert.deepEqual(
			chars.map(swap),
			mirrored,
			`row not symmetric: ${row}`,
		);
	}
});

for (const seatCount of [2, 3, 4, 5, 6, 7, 8, 9]) {
	test(`layoutTable places ${seatCount} seat anchors fully inside the padded canvas`, () => {
		const table = layoutTable(74, 15, seatCount);
		assert.equal(table.seatAnchors.length, seatCount);
		const boxHalfWidth = 9;
		const boxHalfHeight = 2;
		for (const anchor of table.seatAnchors) {
			assert.ok(anchor.x - boxHalfWidth >= -1, `seat box runs off the left edge: ${anchor.x}`);
			assert.ok(anchor.x + boxHalfWidth <= table.width + 1, `seat box runs off the right edge: ${anchor.x}`);
			assert.ok(anchor.y - boxHalfHeight >= -1, `seat box runs off the top edge: ${anchor.y}`);
			assert.ok(anchor.y + boxHalfHeight <= table.height + 1, `seat box runs off the bottom edge: ${anchor.y}`);
		}
	});
}

test("layoutTable spaces seats out (no two anchors coincide)", () => {
	const table = layoutTable(74, 15, 6);
	for (let i = 0; i < table.seatAnchors.length; i++) {
		for (let j = i + 1; j < table.seatAnchors.length; j++) {
			const a = table.seatAnchors[i]!;
			const b = table.seatAnchors[j]!;
			const dist = Math.hypot(a.x - b.x, a.y - b.y);
			assert.ok(dist > 5, `seats ${i} and ${j} are too close together (${dist.toFixed(1)})`);
		}
	}
});

test("stampBlock centers content on the anchor and clips at the canvas edge", () => {
	const rows = ["    ", "    ", "    "];
	// Content is 2 rows tall; centered on y=1 -> top row at round(1 - 0.5) = 1.
	const stamped = stampBlock(rows, { x: 1, y: 1 }, ["AB", "CD"]);
	assert.equal(stamped[0], "    ");
	assert.equal(stamped[1]?.slice(0, 2), "AB");
	assert.equal(stamped[2]?.slice(0, 2), "CD");
});

test("centerOnRow keeps the border glyphs and centers text between them", () => {
	const row = "  ╭                    ╮  ";
	const centered = centerOnRow(row, "Pot 100");
	assert.ok(centered.startsWith("  ╭"));
	assert.ok(centered.endsWith("╮  "));
	assert.ok(centered.includes("Pot 100"));
});
