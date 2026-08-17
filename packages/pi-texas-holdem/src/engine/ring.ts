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

const BORDER_GLYPHS = ["│", "╮", "─", "╭", "│", "╰", "─", "╯"] as const;

function borderGlyph(dx: number, dy: number): string {
	const angle = (Math.atan2(-dy, dx) * 180) / Math.PI;
	const normalized = ((angle % 360) + 360) % 360;
	const idx = Math.floor(((normalized + 22.5) % 360) / 45);
	return BORDER_GLYPHS[idx] as string;
}

/** Ellipse radii used for the table rail, given the drawable box. */
function railRadii(width: number, height: number) {
	return { a: width / 2 - 3, b: height / 2 - 0.9 };
}

export function generateRing(width: number, height: number): RingGrid {
	const cx = (width - 1) / 2;
	const cy = (height - 1) / 2;
	const { a, b } = railRadii(width, height);
	const grid: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));

	const setCell = (x: number, y: number) => {
		const xi = Math.round(x);
		const yi = Math.round(y);
		if (xi < 0 || xi >= width || yi < 0 || yi >= height) return;
		grid[yi]![xi] = borderGlyph(xi - cx, yi - cy);
	};

	// Round the radius offset once, then apply it symmetrically to both sides of the
	// integer center. Rounding cx-d and cx+d independently instead can pick different
	// directions for a .5 offset and skew the oval by a column.
	for (let xi = 0; xi < width; xi++) {
		const ndx = (xi - cx) / a;
		if (Math.abs(ndx) > 1) continue;
		const dy = Math.round(b * Math.sqrt(Math.max(0, 1 - ndx * ndx)));
		setCell(xi, cy - dy);
		setCell(xi, cy + dy);
	}
	for (let yi = 0; yi < height; yi++) {
		const ndy = (yi - cy) / b;
		if (Math.abs(ndy) > 1) continue;
		const dx = Math.round(a * Math.sqrt(Math.max(0, 1 - ndy * ndy)));
		setCell(cx - dx, yi);
		setCell(cx + dx, yi);
	}

	return { width, height, rows: grid.map((row) => row.join("")) };
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
