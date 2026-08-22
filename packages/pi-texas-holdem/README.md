# pi-texas-holdem

Play Texas Hold'em inside [pi](https://github.com/earendil-works/pi).

## Quick start

From this checkout:

```sh
npm install
pi -e ./packages/pi-texas-holdem/extensions/poker.ts
```

Play locally against bots:

```text
/poker local
```

## Online rooms

To create internet rooms, first deploy [the bundled Cloudflare backend](cloudflare/README.md) to your personal Cloudflare account. Then start pi with:

```sh
export PI_POKER_WORKER_URL="https://YOUR-WORKER.workers.dev"
export PI_POKER_CREATE_SECRET="your-creation-secret"
pi
```

Create a room and share the displayed invite URL:

```text
/poker create
```

Join a room:

```text
/poker join <room-url>
```

## Commands

```text
/poker local [seats]       play against bots (2-6 seats, default 6)
/poker create              create a room on your personal Worker
/poker join <room-url>     join an online room
/poker                     reopen the active table
/poker leave               leave the current game
/poker help                show command help
```

## Controls

```text
F       fold
C       check/call
R       raise
A       all-in
/       chat
Enter   confirm raise or start the next hand
Esc     cancel or close the table overlay
```

## Development

```sh
npm test --workspace @geminixiang/pi-texas-holdem
npm run check --workspace @geminixiang/pi-texas-holdem
```
