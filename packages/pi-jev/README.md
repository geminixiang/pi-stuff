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

Set one of these so the tool has a configured backend:

| Env var                                          | Backend                  |
| ------------------------------------------------ | ------------------------ |
| `TYPESAFE_API_KEY`                               | TypeSafe AI direct       |
| `OPENROUTER_API_KEY`                             | OpenRouter Decisions API |
| `AI_GATEWAY_API_KEY` (or `VERCEL_API_KEY`)       | Vercel AI Gateway        |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Workers AI    |

The tool tries them in that order and uses the first one configured, or pass `provider`
in a call to force one.

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
