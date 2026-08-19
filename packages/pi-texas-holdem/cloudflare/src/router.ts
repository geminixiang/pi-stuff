import { parseRoomConfig } from "./config.ts";
import type { Env } from "./types.ts";

const ROOM_PATH = /^\/rooms\/([a-f0-9-]{36})$/;

function json(value: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(value), { ...init, headers });
}

function hasCreationAccess(request: Request, secret: string | undefined): boolean {
	if (!secret) return false;
	const authorization = request.headers.get("authorization");
	return authorization === `Bearer ${secret}`;
}

export async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });

	if (request.method === "POST" && url.pathname === "/rooms") {
		if (!hasCreationAccess(request, env.CREATE_ROOM_SECRET)) {
			return json({ error: "Unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
		}
		let body: unknown = {};
		try {
			body = await request.json();
		} catch {
			return json({ error: "Request body must be JSON" }, { status: 400 });
		}
		const roomId = crypto.randomUUID();
		const creatorCapability = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
		const stub = env.POKER_ROOMS.get(env.POKER_ROOMS.idFromName(roomId));
		const created = await stub.fetch("https://room.internal/create", {
			method: "POST",
			body: JSON.stringify({ config: parseRoomConfig(body), creatorCapability }),
		});
		if (!created.ok) return json({ error: "Could not create room" }, { status: 502 });
		const roomUrl = new URL(`/rooms/${roomId}`, url);
		roomUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const metadata = (await created.json()) as { expiresAt: number };
		const creatorUrl = new URL(roomUrl);
		creatorUrl.searchParams.set("creator", creatorCapability);
		return json(
			{ roomId, url: roomUrl.toString(), creatorUrl: creatorUrl.toString(), expiresAt: metadata.expiresAt },
			{ status: 201 },
		);
	}

	const match = ROOM_PATH.exec(url.pathname);
	if (match && (request.method === "GET" || request.method === "HEAD")) {
		const stub = env.POKER_ROOMS.get(env.POKER_ROOMS.idFromName(match[1]!));
		return stub.fetch(request);
	}

	return json({ error: "Not found" }, { status: 404 });
}
