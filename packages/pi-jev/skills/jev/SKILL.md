---
name: jev
description: Use the jev tool for classification, detection, scoring, ranking, routing, extraction over known candidates, or verification that would otherwise require judging by eye. Use when a decision needs a calibrated probability instead of a guess, or when there are too many items to read and judge one by one.
---

# jev

`jev` asks Jev, TypeSafe's calibrated decision model, typed questions about a
`state` and returns probabilities — never generated text. It does not read
files or run commands; you supply everything it should judge.

```
jev({ label, state, questions: { <id>: { type, instructions, criteria? } } })
```

## When to reach for it

Use `jev` instead of judging in your own reasoning whenever the task is one of:

- **Classification / routing** — which category, team, or handler fits a message
- **Detection** — does this text contain X (a claim, a policy violation, a jailbreak attempt)
- **Scoring** — where does this fall on an ordered scale (severity, quality, urgency)
- **Ranking** — which of several items is most/least something
- **Extraction over known candidates** — which of these already-found spans is the answer (pair with `bash`/`grep` to find candidates first; `jev` never invents a value, only selects one)
- **Verification** — does a claim hold up against a source, does a summary overstate the original

Do **not** use it for open-ended generation, math, or anything requiring a written answer — `jev` only returns probabilities against options you define.

## Question types

| Type      | Answer                                                                                                   | Use for                         |
| --------- | -------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `boolean` | `probability` (0–1) that the instructions hold                                                           | yes/no detection                |
| `choice`  | one `choice` id, `probabilities` per option, and (when the backend reports it) `confidence`              | picking a category or candidate |
| `score`   | a fractional `score` over an ordered rubric, `probabilities` per level, and (when reported) `confidence` | rating something on a scale     |

## Core rules

1. **Ask narrow, atomic questions.** A question that hides several judgments behind one answer cannot be inspected or tuned. Split "is this a bug report and how severe" into two questions.
2. **Batch everything about one state into a single call**, including speculative questions you might not need — they run in parallel and cost nothing extra. Decide in your own reasoning which answers are relevant.
3. **To rank N items, ask one `score` question per item** (or one call per item-pair), not a single `choice` whose options are orderings of all items — that only scales to a handful of items and asks you to pre-judge the ranking yourself.
4. **To verify a summary or claim, ask one `boolean` per atomic claim** against the source, not one broad "is this accurate" question.
5. **Never pre-judge and ask jev to confirm.** If you already decided the answer and phrase a `choice` question so only one option makes sense, you have not used jev — you have used yourself and dressed it up. Ask the real, undecided question.
6. **Structure state and criteria as JSON when it has parts.** `state: { message, policy }` beats interpolating both into one string. For `choice`, structure a description as `{ what, not_for, examples }` when a plain sentence would blur the boundary between two options.
7. **Read `confidence` before acting on `choice`/`score`.** Below ~0.5, Jev is not sure between options — say so, or fall back to a broader/human decision, instead of presenting the top answer as settled. Not every backend reports `confidence`; treat it as possibly absent.
8. **Copy extracted values verbatim.** When selecting among candidates found by other tools, the `choice` id is the answer — do not re-type or reformat it.

## Example

```
jev({
  label: "route support ticket",
  state: { message: "My card was charged twice for order A-104." },
  questions: {
    department: {
      type: "choice",
      instructions: "Which team should handle this message?",
      criteria: {
        billing: "Charges, invoices, refunds, subscriptions",
        orders: "Order status, delivery, cancellation, returns",
        account: "Login, password, profile, security",
      },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this ticket?",
      criteria: ["Can wait", "This week", "Now"],
    },
  },
})
```

```json
{
  "answers": {
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.97, "orders": 0.02, "account": 0.01 },
      "confidence": 0.95
    },
    "urgency": {
      "type": "score",
      "score": 1.2,
      "probabilities": { "0": 0.1, "1": 0.6, "2": 0.3 },
      "confidence": 0.62
    }
  },
  "provider": "openrouter",
  "model": "jev-1.13.0"
}
```

## Setup

`jev` needs one configured backend. Set any one of:

- `TYPESAFE_API_KEY` — TypeSafe AI direct
- `OPENROUTER_API_KEY` — OpenRouter Decisions API
- `AI_GATEWAY_API_KEY` (or `VERCEL_API_KEY`) — Vercel AI Gateway
- `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` — Cloudflare Workers AI

The tool tries them in that order and uses the first one configured. Pass
`provider` to force a specific backend. If none is configured, the tool call
fails with a clear error naming the missing env vars — fall back to judging
the input yourself.
