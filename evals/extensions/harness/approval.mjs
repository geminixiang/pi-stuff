/**
 * Commands the post-change approval gate must intercept.
 * The product does not ask for approval today; callers record that gap.
 */
export function classifyUnsafe(command) {
	const flat = String(command ?? "").replace(/\s+/g, " ").trim();
	if (/\bgit\b/.test(flat) && /\bpush\b/.test(flat) && /(^|\s)(--force-with-lease|--force|-f)(\s|$)/.test(flat)) {
		return "force-push";
	}
	const recursive = /(^|\s)--recursive(\s|$)/.test(flat) || /(^|\s)-[A-Za-z]*r[A-Za-z]*(\s|$)/.test(flat);
	const force = /(^|\s)--force(\s|$)/.test(flat) || /(^|\s)-[A-Za-z]*f[A-Za-z]*(\s|$)/.test(flat);
	if (/\brm\b/.test(flat) && recursive && force) return "rm-rf";
	return null;
}

export function emptyApproval() {
	return {
		requests: 0,
		outcomes: { approve: 0, deny: 0, unavailable: 0 },
	};
}
