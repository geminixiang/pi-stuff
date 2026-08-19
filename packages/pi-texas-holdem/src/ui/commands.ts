export type PokerCommand =
	| { kind: "open" }
	| { kind: "local"; seatCount: number; legacyAlias: boolean }
	| { kind: "create" }
	| { kind: "join"; address?: string }
	| { kind: "lanHost"; port: number; confirmed: boolean; legacyAlias: boolean }
	| { kind: "rooms" }
	| { kind: "privacy" }
	| { kind: "leave" }
	| { kind: "help" }
	| { kind: "invalid"; input: string };

export const DEFAULT_POKER_PORT = 4551;

/** Parse the user-facing command vocabulary while retaining pre-0.2 aliases. */
export function parsePokerCommand(rawArgs: string): PokerCommand {
	const args = rawArgs.trim().split(/\s+/).filter(Boolean);
	const command = args[0]?.toLowerCase();

	if (!command) return { kind: "open" };
	if (command === "local" || command === "bots") {
		const requestedSeats = Number(args[1]);
		const seatCount = Number.isFinite(requestedSeats) && requestedSeats > 0 ? Math.min(6, Math.max(2, Math.trunc(requestedSeats))) : 6;
		return { kind: "local", seatCount, legacyAlias: command === "bots" };
	}
	if (command === "create" || command === "cloud") return { kind: "create" };
	if (command === "join") return { kind: "join", address: args[1] };
	if (command === "lan-host" || command === "host") {
		const portArg = args.find((arg, index) => index > 0 && !arg.startsWith("--"));
		const requestedPort = Number(portArg);
		const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65_535 ? requestedPort : DEFAULT_POKER_PORT;
		return { kind: "lanHost", port, confirmed: args.includes("--i-know"), legacyAlias: command === "host" };
	}
	if (command === "rooms" || command === "public") return { kind: "rooms" };
	if (command === "privacy" || command === "telemetry") return { kind: "privacy" };
	if (command === "leave" || command === "quit") return { kind: "leave" };
	if (command === "help") return { kind: "help" };
	return { kind: "invalid", input: command };
}

/** Accept shareable HTTP(S) room links as well as direct WebSocket URLs. */
export function normalizeRoomUrl(address: string): string {
	const trimmed = address.trim();
	if (!trimmed) throw new Error("Enter a room URL.");

	let candidate = trimmed;
	if (candidate.startsWith("https://")) candidate = `wss://${candidate.slice("https://".length)}`;
	else if (candidate.startsWith("http://")) candidate = `ws://${candidate.slice("http://".length)}`;
	else if (!candidate.startsWith("ws://") && !candidate.startsWith("wss://")) candidate = `ws://${candidate}`;

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		throw new Error("Enter a valid room URL, such as wss://room.example or 192.168.1.20:4551.");
	}
	if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Room URLs must use https, http, wss, or ws.");
	if (!url.hostname) throw new Error("The room URL is missing a host.");
	if (url.username || url.password) throw new Error("Room URLs cannot contain usernames or passwords.");
	return url.toString();
}

/** Strip creator authority before displaying or sharing a room URL. */
export function shareableRoomUrl(address: string): string {
	const url = new URL(normalizeRoomUrl(address));
	url.searchParams.delete("creator");
	return url.toString();
}
