# pi-texas-holdem

A [pi](https://github.com/earendil-works/pi) extension that plays Texas Hold'em on an oval table drawn with box-drawing characters, inside the same terminal you're coding in.

## Features

- `/poker` opens the table as a focused overlay; `Esc` drops back to your normal session
- A persistent status widget keeps showing whose turn it is and the pot while you're back to working
- No accounts: your seat name is your machine's hostname
- Today's cumulative token usage is shown in the table header and the widget
- Play solo against simple bots, or host/join a private room over the LAN
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

## Usage

```text
/poker bots [seats]        start a solo game against bots (2-6 seats, default 6)
/poker host [port]         host a private room (default port 4551) and wait for others
/poker join <host:port>    join someone else's room
/poker                     reopen the table for the session already in progress
/poker leave               close the current session
```

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

- Hosting binds a plain WebSocket server on your machine; players connect with `/poker join <your-ip>:<port>`, so this only works when reachable (LAN, VPN, or a manually forwarded port). A relay/matchmaking server for public games without port-forwarding is a possible follow-up, not built here yet.
- Reconnecting to a room after a dropped connection isn't handled — a disconnect auto-folds the seat's current hand and frees the seat.
- Bots use a simple fold/call/raise heuristic, not real hand-strength evaluation.
- Chat is sanitized (ANSI/control characters stripped, length-capped, rate-limited) before it's ever broadcast, since it's rendered straight into other players' terminals.
- "Today's token usage" sums the current pi session's entries for the local calendar day; it doesn't merge usage from other session files.
