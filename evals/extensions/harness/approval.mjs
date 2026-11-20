/**
 * Commands the approval gate must intercept.
 * A recorded execution means the command was started. A deny or a job still
 * waiting for approval is not an execution.
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
