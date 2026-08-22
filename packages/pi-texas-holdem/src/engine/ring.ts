/**
 * Draws the oval table as box-drawing characters on a fixed character grid, and
 * lays out seat anchor points around its rail. Pure text-grid math so the exact
 * output can be unit tested without a running terminal.
 */

export interface RingGrid {
	width: number;
	height: number;
	rows: string[];
}

export interface SeatAnchor {
	/** Column, in character units (fractional; round before indexing text). */
	x: number;
	/** Row, in character units (fractional; round before indexing text). */
	y: number;
}

export interface TableLayout {
	width: number;
	height: number;
	rows: string[];
	seatAnchors: SeatAnchor[];
	/** Offset of the ring's own row 0 / column 0 within `rows`. */
	padTop: number;
	padLeft: number;
}

const MIRROR_GLYPH: Record<string, string> = {
	"╭": "╮",
	"╮": "╭",
	"╰": "╯",
	"╯": "╰",
	"─": "─",
	"│": "│",
};

/** Ellipse radii used for the table rail, given the drawable box. */
function railRadii(width: number, height: number) {
	return { a: width / 2 - 3, b: height / 2 - 0.9 };
}

/**
 * Draw a connected terminal oval one scanline at a time.
 *
 * Independently rounded ellipse points leave gaps on a character grid. Each row
 * instead owns a connected horizontal part of the rail and joins the prior row.
 */
export function generateRing(width: number, height: number): RingGrid {
	if (width < 5 || height < 3) throw new Error("A table ring needs at least a 5×3 grid");

	const cx = (width - 1) / 2;
	const cy = (height - 1) / 2;
	const { a } = railRadii(width, height);
	const sampleRadiusY = height / 2;
	const leftEdges = Array.from({ length: height }, (_, y) => {
		// Sampling through the cell center gives the oval a useful flat top rather
		// than collapsing its first row to a single point.
		const normalizedY = Math.abs(y - cy) / sampleRadiusY;
		const extent = a * Math.sqrt(Math.max(0, 1 - normalizedY * normalizedY));
		return Math.round(cx - extent);
	});
	const rows = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));

	const drawHorizontal = (row: string[], from: number, to: number) => {
		for (let x = Math.max(0, from); x <= Math.min(width - 1, to); x++) row[x] = "─";
	};

	for (let y = 0; y < height; y++) {
		const left = leftEdges[y]!;
		const right = width - 1 - left;
		const row = rows[y]!;

		if (y === 0 || y === height - 1) {
			const edge = y === 0 ? left : leftEdges[y - 1]!;
			const oppositeEdge = width - 1 - edge;
			drawHorizontal(row, edge + 1, oppositeEdge - 1);
			row[edge] = y === 0 ? "╭" : "╰";
			row[oppositeEdge] = y === 0 ? "╮" : "╯";
			continue;
		}

		const previousLeft = leftEdges[y - 1]!;
		const previousRight = width - 1 - previousLeft;
		if (left < previousLeft) {
			drawHorizontal(row, left + 1, previousLeft - 1);
			row[left] = "╭";
			row[previousLeft] = "╯";
			row[previousRight] = "╰";
			drawHorizontal(row, previousRight + 1, right - 1);
			row[right] = "╮";
		} else if (left > previousLeft) {
			row[previousLeft] = "╰";
			drawHorizontal(row, previousLeft + 1, left - 1);
			row[left] = "╮";
			row[right] = "╭";
			drawHorizontal(row, right + 1, previousRight - 1);
			row[previousRight] = "╯";
		} else {
			row[left] = "│";
			row[right] = "│";
		}
	}

	// Preserve exact left/right symmetry for even-width grids too.
	for (const row of rows) {
		for (let x = 0; x < Math.floor(width / 2); x++) {
			row[width - 1 - x] = MIRROR_GLYPH[row[x]!] ?? " ";
		}
	}

	return { width, height, rows: rows.map((row) => row.join("")) };
}

/**
 * Angles (degrees, math orientation, y-up) for `count` points spaced evenly by
 * *arc length* around an a×b ellipse. Plain even angle-spacing looks bunched up
 * on a wide, flat table oval, so this walks the perimeter instead.
 */
function ellipseArcAngles(a: number, b: number, count: number, startDeg: number): number[] {
	const samples = 1440;
	const points: { deg: number; x: number; y: number }[] = [];
	for (let i = 0; i <= samples; i++) {
		const deg = startDeg - (360 * i) / samples;
		const rad = (deg * Math.PI) / 180;
		points.push({ deg, x: a * Math.cos(rad), y: b * Math.sin(rad) });
	}
	const cumulative = [0];
	for (let i = 1; i < points.length; i++) {
		const dx = points[i]!.x - points[i - 1]!.x;
		const dy = points[i]!.y - points[i - 1]!.y;
		cumulative.push((cumulative[i - 1] as number) + Math.hypot(dx, dy));
	}
	const total = cumulative[cumulative.length - 1] as number;
	const angles: number[] = [];
	for (let s = 0; s < count; s++) {
		const target = (total * s) / count;
		let idx = cumulative.findIndex((c) => c >= target);
		if (idx < 0) idx = cumulative.length - 1;
		angles.push(points[idx]!.deg);
	}
	return angles;
}

export interface LayoutOptions {
	/** How far outside the rail seat anchors sit, in columns/rows. */
	outsetCols?: number;
	outsetRows?: number;
	/** Half the footprint of a seat box, so it never clips off the canvas. */
	seatHalfWidth?: number;
	seatHalfHeight?: number;
	/** Starting angle (degrees) for seat 0; conventionally "you", bottom-right. */
	startDeg?: number;
}

/**
 * Composes the ring plus a seat layout onto a padded canvas, so seat boxes can
 * safely overhang the ring's own bounding box without clipping.
 */
export function layoutTable(ringWidth: number, ringHeight: number, seatCount: number, options: LayoutOptions = {}): TableLayout {
	const outsetCols = options.outsetCols ?? 8.5;
	const outsetRows = options.outsetRows ?? 3;
	const seatHalfWidth = options.seatHalfWidth ?? 9;
	const seatHalfHeight = options.seatHalfHeight ?? 3;
	const startDeg = options.startDeg ?? -58;
	const margin = 1;

	const cx = (ringWidth - 1) / 2;
	const cy = (ringHeight - 1) / 2;
	const { a, b } = railRadii(ringWidth, ringHeight);
	const outerA = a + outsetCols;
	const outerB = b + outsetRows;

	const padLeft = Math.ceil(Math.max(0, outerA - cx)) + seatHalfWidth + margin;
	const padRight = padLeft;
	const padTop = Math.ceil(Math.max(0, outerB - cy)) + seatHalfHeight + margin;
	const padBottom = padTop;

	const ring = generateRing(ringWidth, ringHeight);
	const width = ringWidth + padLeft + padRight;
	const height = ringHeight + padTop + padBottom;
	const rows = Array.from({ length: height }, (_, y) => {
		if (y < padTop || y >= padTop + ringHeight) return " ".repeat(width);
		return " ".repeat(padLeft) + ring.rows[y - padTop] + " ".repeat(padRight);
	});

	const angles = seatCount > 0 ? ellipseArcAngles(outerA, outerB, seatCount, startDeg) : [];
	const seatAnchors = angles.map((deg) => {
		const rad = (deg * Math.PI) / 180;
		return { x: padLeft + cx + outerA * Math.cos(rad), y: padTop + cy - outerB * Math.sin(rad) };
	});

	return { width, height, rows, seatAnchors, padTop, padLeft };
}

/** Overwrites `content` lines onto `rows`, centered on `anchor`, clipped to bounds. */
export function stampBlock(rows: string[], anchor: SeatAnchor, content: string[]): string[] {
	const out = rows.slice();
	const top = Math.round(anchor.y - (content.length - 1) / 2);
	for (let li = 0; li < content.length; li++) {
		const rowIndex = top + li;
		if (rowIndex < 0 || rowIndex >= out.length) continue;
		const line = content[li] as string;
		const left = Math.round(anchor.x - line.length / 2);
		const row = out[rowIndex] as string;
		const chars = row.split("");
		for (let ci = 0; ci < line.length; ci++) {
			const col = left + ci;
			if (col < 0 || col >= chars.length) continue;
			const ch = line[ci] as string;
			if (ch !== " ") chars[col] = ch;
		}
		out[rowIndex] = chars.join("");
	}
	return out;
}

/** Writes `text` centered on a single ring row, without disturbing the border glyphs at both ends. */
export function centerOnRow(row: string, text: string): string {
	const chars = row.split("");
	const first = chars.findIndex((c) => c !== " ");
	const last = chars.length - 1 - [...chars].reverse().findIndex((c) => c !== " ");
	if (first < 0 || last <= first) return row;
	const innerWidth = last - first - 1;
	const pad = Math.max(0, innerWidth - text.length);
	const left = Math.floor(pad / 2);
	const content = " ".repeat(left) + text + " ".repeat(Math.max(0, pad - left));
	return chars.slice(0, first + 1).join("") + content.slice(0, innerWidth) + chars.slice(last).join("");
}
