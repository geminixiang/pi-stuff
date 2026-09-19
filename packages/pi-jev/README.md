# @geminixiang/pi-jev

Ask [Jev](https://docs.typesafe.ai/), TypeSafe's calibrated decision model, typed
boolean/choice/score questions from any [Pi](https://pi.dev) conversation. Jev never
generates text; it returns probabilities against options you define, so a `jev` call is
a cheap, calibrated alternative to judging something by eye.

Backed by [`@geminixiang/jev`](https://www.npmjs.com/package/@geminixiang/jev), a
pi-ai-shaped SDK covering TypeSafe, OpenRouter, Vercel AI Gateway, and Cloudflare
Workers AI as interchangeable backends.

## Install

```sh
pi install npm:@geminixiang/pi-jev
```

Requires Pi **0.82.1 or newer** (native provider registration and provider-level auth
resolution). After installing, restart Pi or `/reload`, then configure a backend with
Pi's interactive `/login`:

| Jev backend  | Pi login                                                  |
| ------------ | --------------------------------------------------------- |
| `typesafe`   | `/login typesafe` (added by this extension)               |
| `openrouter` | `/login openrouter`                                       |
| `vercel`     | `/login vercel-ai-gateway`                                |
| `cloudflare` | `/login cloudflare-workers-ai` (API token and account ID) |

TypeSafe prompts for a **plain API key**, not OAuth. Pi owns credential persistence
and `/logout typesafe` removes the saved key. The registration has no chat models:
TypeSafe appears in `/login`, not `/model`; use the `jev` tool to call it. OpenRouter's
browser login is also usable: it mints an OpenRouter API key billed from your credits.
No Jev-specific copy of Pi's auth file is needed.

Alternatively, keep using Jev's existing environment variables:

| Env var                                          | Backend                  |
| ------------------------------------------------ | ------------------------ |
| `TYPESAFE_API_KEY`                               | TypeSafe AI direct       |
| `OPENROUTER_API_KEY`                             | OpenRouter Decisions API |
| `AI_GATEWAY_API_KEY` (or `VERCEL_API_KEY`)       | Vercel AI Gateway        |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Workers AI    |

The tool checks backends in this order: **TypeSafe → OpenRouter → Vercel →
Cloudflare**. Within each backend, compatible Pi-resolved auth takes precedence;
otherwise it falls back to that backend's Jev environment configuration. An earlier
backend's environment key still wins over a later backend's Pi key. Pass `provider`
in a call to restrict selection to one Jev backend ID from the table above.

Credentials are resolved from the executing tool's `ctx.modelRegistry` on every call,
so Pi handles saved keys, configured key expressions, and runtime overrides. The active
chat model does not select the Jev backend, and unrelated subscription credentials
(such as Codex or Claude) are never reused. Cloudflare reuse is limited to **Workers
AI**, not Cloudflare **AI Gateway**; the resolved Workers account ID accompanies its
bearer key. Provider-specific environment values are not copied wholesale.

For safety, Pi credential reuse is limited to the standard service endpoints and a
resolved API key with no custom headers. Redirected providers, custom auth headers,
header-only auth, and incomplete Workers account configuration are skipped in favor
of Jev's environment fallback. Chat base URLs are never passed to the decision API.
Pi auth-resolution errors stop the call with a sanitized login hint; evaluation
failures are not retried on another backend. Configure a Jev environment key if your
Pi proxy configuration is incompatible. `/logout` does not disable environment keys.
The account/key must also have access to Jev on the selected service; configuration
alone does not verify permissions or billing.

## Skill

Installing the package also installs the [`jev` skill](skills/jev/SKILL.md), which tells
the agent when to reach for the tool (classification, detection, scoring, ranking,
routing, extraction over known candidates, verification) and the rules that keep its use
sound: ask narrow atomic questions, batch everything about one state into one call, rank
with one score question per item rather than a choice over orderings, and read
`confidence` before acting on an uncertain answer.

## Tool

```
jev({ label, state, questions: { <id>: { type, instructions, criteria? } }, provider? })
```

A direct pass-through of the Jev decisions API: `state` is text or a JSON object/array,
`questions` is any number of `boolean` / `choice` / `score` questions evaluated against
that state in one request. See the [skill](skills/jev/SKILL.md) for question shapes and
an example, and [`@geminixiang/jev`](https://github.com/geminixiang/jev) for the full API
this wraps.

## Development

```sh
npm test --workspace @geminixiang/pi-jev
npm run check --workspace @geminixiang/pi-jev
```

## License

MIT
