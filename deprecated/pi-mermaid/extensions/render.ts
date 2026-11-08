import { renderMermaidASCII } from "beautiful-mermaid";
import { visibleWidth } from "@earendil-works/pi-tui";

export interface MermaidBlock {
	index: number;
	source: string;
}

const ZERO_WIDTH_SPACE = "\u200b";

/**
 * Compensate for renderers that measure text with JavaScript string length.
 *
 * A CJK character has length 1 in JavaScript but occupies 2 terminal columns.
 * Appending an invisible code point makes both measurements agree without
 * changing what the user sees. Astral emoji already use two UTF-16 code units,
 * so they normally need no compensation.
 */
export function compensateTerminalWidth(source: string): string {
	return Array.from(source, (character) => {
		const missingCodeUnits = visibleWidth(character) - character.length;
		return missingCodeUnits > 0
			? character + ZERO_WIDTH_SPACE.repeat(missingCodeUnits)
			: character;
	}).join("");
}

/** Extract fenced Mermaid blocks from Markdown, case-insensitively. */
export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
	const blocks: MermaidBlock[] = [];
	const pattern = /```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(markdown)) !== null) {
		const source = match[1]?.trim();
		if (source) blocks.push({ index: match.index, source });
	}

	return blocks;
}

export function renderDiagram(source: string, useAscii = false): string {
	if (!source.trim()) throw new Error("Mermaid source is empty");

	// beautiful-mermaid expects the diagram header on its own line, while
	// Mermaid itself commonly accepts compact forms such as `graph LR; A --> B`.
	const normalized = compensateTerminalWidth(source.trim()).replace(
		/^(\s*(?:graph|flowchart)\s+(?:TD|TB|BT|RL|LR))\s*;\s*/i,
		"$1\n",
	);

	return renderMermaidASCII(normalized, {
		useAscii,
		colorMode: "none",
		paddingX: 3,
		paddingY: 2,
		boxBorderPadding: 1,
	}).trimEnd();
}
