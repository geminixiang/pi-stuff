# pi-texas-holdem

A [pi](https://github.com/earendil-works/pi) extension that plays Texas Hold'em on an oval table drawn with box-drawing characters, inside the same terminal you're coding in.

## Features

- `/poker` opens the table as a focused overlay; `Esc` drops back to your normal session
- A persistent status widget keeps showing whose turn it is and the pot while you're back to working
- No accounts: your seat name is your machine's hostname
- Today's cumulative token usage is shown in the table header and the widget
- Three explicit entry paths: play locally, create a room on your personal Cloudflare Worker, or join a room URL
- Legacy LAN hosting remains available for trusted friends and existing workflows
- Full no-limit Hold'em rules: blinds, betting rounds, side pots, showdown
- Table chat: talk to the other seats and see fold/call/raise/showdown events in the same feed

## Install

From this checkout:

```sh
npm install
pi install .
```

For development without installing the package:

```sh
npm install
pi -e ./extensions/poker.ts
```

## Choose how to play

### 1. Play locally

```text
/poker local [seats]       start immediately against bots (2-6 seats, default 6)
```

Everything stays in this pi process. This is the fastest path and needs no account or network service.

### 2. Create a room on your personal Cloudflare Worker

The repository includes `@geminixiang/pi-texas-holdem-worker`, a Worker + Durable Object backend that you deploy to **your own Cloudflare account**. Follow [`../pi-texas-holdem-worker/README.md`](../pi-texas-holdem-worker/README.md) to deploy it; pi never logs into Cloudflare or deploys infrastructure for you.

Configure pi before launching it:

```sh
export PI_POKER_WORKER_URL="https://YOUR-WORKER.workers.dev"
# Only when your deployment protects POST /rooms:
export PI_POKER_CREATE_SECRET="your-creation-secret"
pi
```

Then create and enter a room:

```text
/poker create
```

The extension posts private defaults to `POST /rooms` with telemetry disabled, joins the creator URL returned by the Worker, and displays the shareable invite URL after the WebSocket connection succeeds. The creation secret is sent only as an `Authorization: Bearer …` header: it is never placed in a URL, notification, or room invite. Prefer setting it through your shell's secret manager rather than saving it in a checked-in file.

If `PI_POKER_WORKER_URL` is missing or invalid, `/poker create` makes no request and shows setup guidance. The endpoint must use HTTPS, except loopback HTTP for local development.

The creator session can request the first and later hands with `Enter`. A normal invite URL does not grant creator controls; authorization is carried only by the unshareable `?creator=…` capability in `creatorUrl`.

For a trusted LAN, VPN, or manually forwarded port, the advanced fallback remains:

```text
/poker lan-host [port] --i-know
```

The explicit confirmation is required because this machine runs the game and can technically inspect every hand. Do not use it for money.

### 3. Join a room URL

```text
/poker join <room-url>
```

Paste a `wss://`/`https://` share URL, or connect directly with `host:port` on a trusted LAN. HTTPS share links are converted to secure WebSocket URLs. Only join room operators you trust.

### Session and roadmap commands

```text
/poker                     reopen the active table
/poker leave               leave and close the active game
/poker rooms               public directory status (coming soon; makes no request)
/poker privacy             telemetry status and policy
/poker help                show the command summary
```

Public rooms and a searchable directory are intentionally reserved for a later backend. `/poker rooms` does not present fake data. Telemetry is currently off; any future analytics will be clearly opt-in, never enabled merely by creating or joining a room, and will include an obvious way to disable it.

### Compatibility

Existing commands remain supported:

- `/poker bots [seats]` → `/poker local [seats]`
- `/poker host [port] --i-know` → `/poker lan-host [port] --i-know`
- `/poker quit` → `/poker leave`
- `/poker join <host:port>` continues to work

The old aliases show a short migration hint but retain their behavior.

While the table is open:

- `F` fold, `C` check/call, `R` raise, `A` all-in
- While raising: `+`/`-` adjust the amount, `Enter` confirms, `Esc` cancels
- `/` opens a chat line, `Enter` sends it, `Esc` cancels the draft
- `Enter` starts the next hand once at least two seats have chips
- `Esc` closes the table overlay without leaving the game; the widget keeps tracking it

## Development

```sh
npm install
npm test
npm run check
```

## Notes / current limitations

- Legacy LAN hosting binds a plain WebSocket server on your machine. It only works when reachable (LAN, VPN, or a manually forwarded port), and the host is trusted rather than cheat-proof.
- Personal internet rooms use the separately deployed Worker package and remain private, unlisted bearer URLs. Public discovery is not implemented.
- Reconnecting to a room after a dropped connection isn't handled — a disconnect auto-folds the seat's current hand and frees the seat.
- Bots use a simple fold/call/raise heuristic, not real hand-strength evaluation.
- Chat is sanitized (ANSI/control characters stripped, length-capped, rate-limited) before it's ever broadcast, since it's rendered straight into other players' terminals.
- "Today's token usage" sums the current pi session's entries for the local calendar day; it doesn't merge usage from other session files.
