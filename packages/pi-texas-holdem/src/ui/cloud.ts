export interface PersonalWorkerConfig {
	endpoint: string;
	creationSecret?: string;
}

export interface CreatedPersonalRoom {
	/** URL safe to share with invited players. */
	shareUrl: string;
	/** Creator-authorized URL; may contain a bearer capability and must not be shared accidentally. */
	creatorUrl: string;
	expiresAt?: number;
}

export interface CreatePersonalRoomOptions {
	seatCount?: number;
	smallBlind?: number;
	bigBlind?: number;
	startingStack?: number;
}

export function normalizeWorkerEndpoint(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("Set a valid personal Worker URL, for example https://my-poker.workers.dev.");
	}
	if (url.username || url.password) throw new Error("The Worker URL cannot contain credentials.");
	const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
	if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
		throw new Error("Personal Worker URLs must use HTTPS (HTTP is allowed only for local development).");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function capabilityUrl(shareUrl: string, capability: string): string {
	const url = new URL(shareUrl);
	url.searchParams.set("creator", capability);
	return url.toString();
}

/** Create a room without ever placing the creation secret in a URL or returned error. */
export async function createPersonalRoom(
	config: PersonalWorkerConfig,
	options: CreatePersonalRoomOptions = {},
	fetchImpl: typeof fetch = fetch,
): Promise<CreatedPersonalRoom> {
	const endpoint = normalizeWorkerEndpoint(config.endpoint);
	const headers = new Headers({ "content-type": "application/json" });
	if (config.creationSecret) headers.set("authorization", `Bearer ${config.creationSecret}`);

	let response: Response;
	try {
		response = await fetchImpl(`${endpoint}/rooms`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				seatCount: options.seatCount ?? 6,
				smallBlind: options.smallBlind ?? 10,
				bigBlind: options.bigBlind ?? 20,
				startingStack: options.startingStack ?? 2_000,
				telemetry: false,
			}),
		});
	} catch {
		throw new Error("Could not reach the personal Worker. Check its URL and deployment, then try again.");
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	if (!response.ok) {
		const message = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
			? (body as { error: string }).error
			: `Worker returned HTTP ${response.status}`;
		if (response.status === 401 || response.status === 403) throw new Error("Room creation was denied. Check PI_POKER_CREATE_SECRET and the Worker's creation policy.");
		throw new Error(`Could not create room: ${message}`);
	}
	if (typeof body !== "object" || body === null) throw new Error("Worker returned an invalid room response.");
	const result = body as Record<string, unknown>;
	if (typeof result.url !== "string") throw new Error("Worker response is missing the shareable room URL.");
	const shareUrl = result.url;
	const creatorUrl = typeof result.creatorUrl === "string"
		? result.creatorUrl
		: typeof result.capability === "string"
			? capabilityUrl(shareUrl, result.capability)
			: shareUrl;
	return {
		shareUrl,
		creatorUrl,
		expiresAt: typeof result.expiresAt === "number" ? result.expiresAt : undefined,
	};
}
