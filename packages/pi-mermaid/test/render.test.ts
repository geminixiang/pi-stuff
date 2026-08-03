import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { compensateTerminalWidth, extractMermaidBlocks, renderDiagram } from "../extensions/render.ts";

test("extracts Mermaid fences and ignores other code", () => {
	const markdown = [
		"Before",
		"```ts",
		"const x = 1",
		"```",
		"```mermaid",
		"graph LR; A --> B",
		"```",
		"```MERMAID  ",
		"sequenceDiagram",
		"  Alice->>Bob: Hello",
		"```",
	].join("\n");

	assert.deepEqual(
		extractMermaidBlocks(markdown).map(({ source }) => source),
		["graph LR; A --> B", "sequenceDiagram\n  Alice->>Bob: Hello"],
	);
});

test("compensates characters that occupy two terminal columns", () => {
	assert.equal(compensateTerminalWidth("開始"), "開\u200b始\u200b");
	assert.equal(compensateTerminalWidth("Start"), "Start");
	assert.equal(visibleWidth(compensateTerminalWidth("開始")), 4);
});

test("keeps CJK node borders aligned", () => {
	const lines = renderDiagram("graph LR; A[開始] --> B[完成]").split("\n");
	assert.equal(lines.length, 5);
	assert.equal(new Set(lines.map(visibleWidth)).size, 1);
	assert.equal(lines[0], "┌──────┐   ┌──────┐");
	assert.match(lines[2] ?? "", /│ 開​始​ ├──►│ 完​成​ │/);
});

test("renders a flowchart as Unicode", () => {
	const output = renderDiagram("graph LR; A --> B");
	assert.match(output, /A/);
	assert.match(output, /B/);
	assert.match(output, /[┌┐└┘─│►]/);
});

test("supports pure ASCII output", () => {
	const output = renderDiagram("graph LR; A --> B", true);
	assert.match(output, /\+---/);
	assert.doesNotMatch(output, /[┌┐└┘]/);
});
