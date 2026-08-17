import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeChatText } from "../src/net/sanitize.ts";

test("strips ANSI color/cursor escape sequences", () => {
	assert.equal(sanitizeChatText("\x1B[31mhello\x1B[0m"), "hello");
	assert.equal(sanitizeChatText("\x1B[2J\x1B[Hpwned"), "pwned");
});

test("strips OSC sequences (e.g. terminal title injection)", () => {
	assert.equal(sanitizeChatText("\x1B]0;evil title\x07hi"), "hi");
});

test("strips other control characters but keeps normal punctuation", () => {
	assert.equal(sanitizeChatText("go\x07od nice hand!"), "good nice hand!");
});

test("collapses embedded newlines into spaces instead of allowing multi-line output", () => {
	assert.equal(sanitizeChatText("line one\nline two\r\nline three"), "line one line two line three");
});

test("trims surrounding whitespace and enforces a max length", () => {
	assert.equal(sanitizeChatText("   hi   "), "hi");
	assert.equal(sanitizeChatText("a".repeat(300), 10), "a".repeat(10));
});

test("leaves normal unicode/CJK text untouched", () => {
	assert.equal(sanitizeChatText("這手牌不錯 nice hand 👍"), "這手牌不錯 nice hand 👍");
});

test("empty or whitespace-only input sanitizes to an empty string", () => {
	assert.equal(sanitizeChatText("   \x1B[31m  \x1B[0m "), "");
});
