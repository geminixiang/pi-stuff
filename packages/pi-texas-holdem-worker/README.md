# pi-texas-holdem-worker

A self-hosted Cloudflare Worker + Durable Object backend for private `pi-texas-holdem` rooms. Each room creator deploys this package to **their own Cloudflare account**; there is no shared service, account, credential, or domain in this repository.

## MVP

- `POST /rooms` creates an unguessable room and returns its shareable WebSocket URL.
- `GET /rooms/:uuid` upgrades to a WebSocket routed to one Durable Object per room.
- The Durable Object persists authoritative engine state and uses the WebSocket Hibernation API (`acceptWebSocket`, attachments, hibernation event handlers).
- Existing engine state transitions, redacted views, and protocol v2 messages are reused directly.
- Rooms expire by alarm (default 24 hours, configurable from 5 minutes to 7 days).
- `hello`, `welcome`, `state`, `action`, `startHand`, `ping`/`pong`, capacity and protocol errors work. Joins wait until the current hand finishes. Disconnects fold while preserving committed chips during a hand, then free seats when disconnected between hands.

The terminal extension supports this backend through `/poker create` when `PI_POKER_WORKER_URL` and `PI_POKER_CREATE_SECRET` are configured. Public directory browsing and server-side chat are not included in this MVP.

## Local setup and deployment

Requirements: Node.js 22+, a personal Cloudflare account, and Durable Objects availability on that account. No deployment or login is performed by repository scripts.

```sh
npm install
cp packages/pi-texas-holdem-worker/wrangler.example.jsonc \
  packages/pi-texas-holdem-worker/wrangler.jsonc
# Pick your own globally unique Worker name in wrangler.jsonc.
# Set a long random deployer-only secret; the value is never committed.
printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put CREATE_ROOM_SECRET \
  --config packages/pi-texas-holdem-worker/wrangler.jsonc
npx wrangler dev --config packages/pi-texas-holdem-worker/wrangler.jsonc
```

Only when you intentionally want to publish to your own account:

```sh
npx wrangler login
npx wrangler deploy --config packages/pi-texas-holdem-worker/wrangler.jsonc
```

Do not commit credentials, account IDs, routes, or custom domains. The example uses the account's ordinary `workers.dev` URL and contains no organization-specific resource.

## HTTP/WebSocket example

```sh
curl -X POST https://YOUR-WORKER.workers.dev/rooms \
  -H 'authorization: Bearer YOUR_PRIVATE_CREATE_ROOM_SECRET' \
  -H 'content-type: application/json' \
  -d '{"seatCount":6,"smallBlind":5,"bigBlind":10,"startingStack":500,"telemetry":false}'
```

The response contains two URLs:

- `url`: the guest URL to share, e.g. `wss://YOUR-WORKER.workers.dev/rooms/<random-uuid>`.
- `creatorUrl`: the private host URL containing an unguessable `?creator=...` capability. Do not share this URL; only a connection presenting this capability may start hands. The Durable Object stores only its SHA-256 hash, and public table state never contains it.

Both URLs use the existing protocol's `hello` first. The current `RoomClient` automatically copies the `creator` query capability into this optional field; guests omit it:

```json
{"type":"hello","protocolVersion":2,"playerId":"ephemeral-client-id","displayName":"Alice","creatorCapability":"creator-only-if-present"}
```

A guest room URL is a bearer secret: anyone with it can join until the room fills or expires. Use HTTPS/WSS and share it privately. The stronger creator URL additionally authorizes starting hands and must remain with the creator.

`POST /rooms` is protected by the deployer-configured `CREATE_ROOM_SECRET` bearer secret so strangers cannot consume a personal Free Plan's room quota. Configure it only with `wrangler secret put`; never place it in `wrangler.jsonc`, source, shell history, or a share URL. Missing server configuration fails closed with HTTP 401.

## Privacy and federation boundaries

### Directory (not implemented)

`RoomDirectory` in `src/types.ts` documents the future optional seam. This MVP has no D1 binding and never lists or registers a room. A future public-room directory must be a separate optional service and require an explicit creator action; private room creation must remain unregistered by default.

### Telemetry (collector intentionally not implemented)

`telemetry: true` is the sole opt-in and defaults to false. Consent is stored with room metadata, but this package sends nothing because no telemetry destination is configured. A future implementation may submit only daily anonymous counters (`room_created`, `player_joined`) through `AnonymousTelemetry`. It must not send or derive stable player/room identifiers, display names, IP addresses, full timestamps, room URLs, or cross-day linkage. It must also remain inert when consent is absent.

## Lifecycle and limits

Each random UUID deterministically selects one Durable Object. The object stores room metadata and `TableState`, persists after every mutation, and uses one alarm for both room expiry and pending-handshake cleanup. Expiry closes sockets and deletes all room storage.

Per room, at most 12 WebSockets may exist, of which at most 4 may be pending the initial `hello`. This preserves ordinary 2–6 seat play while bounding unauthenticated hibernating sockets. A pending socket must send one valid `hello` within 10 seconds; the deadline is stored in its hibernation attachment and enforced by the Durable Object alarm. Binary/oversized/malformed pre-auth messages, non-`hello` pre-auth messages, and repeated `hello` messages close the socket with policy code 1008 rather than leaving it resident.

These conservative limits are designed for personal Free Plan deployments; actual Cloudflare quotas and Durable Objects Free Plan availability can change, so check current Cloudflare documentation before deployment.

No authentication or reconnect token exists in protocol v2. Duplicate live `playerId` values are rejected, but IDs are client-provided and are not credentials.

## Integration gaps

- The terminal client can create a room through `/poker create`, consume guest/creator URLs, and join direct `ws://`/`wss://` room URLs. The creation secret is sent only in the authenticated HTTP `Authorization` header.
- Protocol v2 now has an optional `creatorCapability` on `hello`; the creator URL carries it into the WebSocket handshake so only the creator can start hands.
- Protocol decoding in the core package only checks `type`. The Worker applies stricter boundary validation locally, including sanitizing display names with the existing ANSI/OSC/control sanitizer before enforcing the 40-character limit.
- Chat messages receive a nonfatal `error` response (`Chat is not available in the worker MVP`). The connection remains usable; no unsafe chat content is broadcast.
- Durable Object storage serializes `TableState` structurally, including hidden deck/hole cards. Redaction still occurs per viewer before every state broadcast.

## Verification

```sh
npm run check --workspace @geminixiang/pi-texas-holdem-worker
npm test --workspace @geminixiang/pi-texas-holdem-worker
```
