/**
 * Chat text is rendered verbatim inside a terminal UI, so it must never carry
 * raw ANSI/OSC escape sequences or other control characters through to the
 * screen — a malicious peer could otherwise repaint colors, move the cursor,
 * or (on some terminals) inject OSC title/clipboard sequences via chat.
 */

// CSI sequences (ESC [ ... letter), OSC sequences (ESC ] ... BEL or ST), and
// simple two-byte escapes (ESC followed by a single @-Z / \-_ byte).
// eslint-disable-next-line no-control-regex -- matching control chars is the point of a sanitizer
const ANSI_ESCAPE = /\x1B(\[[0-9;?]*[a-zA-Z]|\][^\x07\x1B]*(\x07|\x1B\\)|[@-Z\\-_])/g;
// Anything else in C0/C1 control ranges except tab/newlines, which are
// harmlessly collapsed/trimmed by the caller where appropriate.
// eslint-disable-next-line no-control-regex -- matching control chars is the point of a sanitizer
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

export function sanitizeChatText(raw: string, maxLength = 240): string {
	const withoutAnsi = raw.replace(ANSI_ESCAPE, "");
	const withoutControl = withoutAnsi.replace(CONTROL_CHARS, "");
	const singleLine = withoutControl.replace(/[\r\n]+/g, " ");
	return singleLine.trim().slice(0, maxLength);
}
