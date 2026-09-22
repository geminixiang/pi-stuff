---
name: rigor-mode
description: Use for non-trivial engineering tasks (bug fixes, features, refactors, investigations, cross-cutting changes) that deserve deliberate investigation and proof rather than a quick guess-and-edit. Loads a short set of engineering principles, routes the task to the right approach, and sets a verification-first bar before anything is reported done.
---

# Rigor mode

AI can produce a lot of code fast. Producing code fast is not the goal — producing code that is
*correct, minimal, and proven to work* is. Rigor mode is a stance to load before starting
non-trivial work: think before typing, prefer the smallest correct change, and never claim
something works without having checked.

Skip this for trivial, obviously-scoped edits (typo fix, one-line config change). Apply it once a
task has more than one plausible approach, touches behavior someone depends on, or its correctness
can't be eyeballed from the diff.

## Principles

**Core**
- **Laziness protocol** — do the least surprising, most direct thing that actually solves the
  problem. Don't build for imagined futures.
- **Attack the premise** — before implementing a request, check whether its framing is even
  correct. A wrong premise makes a well-executed fix wrong.
- **Subtract before you add** — look for what to delete or simplify before reaching for new code.
- **Minimize reader load** — optimize for the next person reading this, not for cleverness. Fewer
  concepts, fewer branches, fewer things to hold in your head.
- **Outcome-oriented execution** — judge progress by the outcome achieved, not by the number of
  actions taken or files touched.
- **Exhaust the design space** — when a decision has real trade-offs, consider more than one
  approach before committing to the first one that comes to mind.

**Architecture**
- **Model the domain** — get the domain model right before wiring plumbing around it.
- **Boundary discipline** — respect module/service/package boundaries; don't reach through them
  because it's convenient this one time.
- **Migrate callers, then delete** — when replacing an API, move every caller to the new path
  before removing the old one. Never leave both live indefinitely "for safety."

**Verification**
- **Prove it works** — verify against the real artifact (a running process, an actual test run,
  real output) — never against a proxy like "the diff reads correctly."
- **Fix root causes** — trace symptoms to their actual cause instead of patching where the
  symptom surfaced.
- **Sequence verifiable units** — break work into steps that can each be checked independently,
  rather than landing one large unverified change.
- **Test behavior, not implementation** — a test should still pass after a correct refactor that
  doesn't change behavior.

**Delegation**
- **Guard the context window** — keep your own working context focused on the decision at hand;
  push open-ended exploration or research into a subagent instead of inlining it.
- **Don't block on the human** — when you can make a reasonable, reversible call, make it and keep
  moving. Ask only when a decision is genuinely irreversible, ambiguous, or outside what you were
  authorized to do.

**Meta**
- **Encode lessons in structure** — when you learn something durable about this codebase, write
  it into the repo (a skill, `AGENTS.md`, a test, a comment where the WHY is non-obvious) instead
  of only holding it in this session's memory.

## Route the task

| Task shape | Approach |
| --- | --- |
| Investigation ("why does X happen") | Reproduce first, then read the actual code path. Don't theorize ahead of evidence. |
| Bug fix | Reproduce → find the root cause → fix → confirm the repro is now gone. |
| New feature | Model the domain before writing code against it. Exhaust 2–3 approaches when the design has real trade-offs; don't default to the first idea. |
| Refactor / cleanup | Confirm behavior is unchanged before and after. In this repo, lean on `pi-simplify`'s `/code-smell` and `/simplify` for a structured pass. |
| Multi-file / cross-cutting change | Sequence into independently verifiable steps rather than one large unreviewed diff. |
| Durable decision or hard-won lesson | Record it, don't just remember it — this repo's `pi-remember` skill writes it into `AGENTS.md`. |
| Something needs proof it still works | If this repo has a verification plan, run it through `pi-verification` instead of eyeballing the change. |

## Before reporting done

- Did you actually run or observe the thing changing — a test, a command, a running server — or
  did you only read the diff and assume it works?
- Would you bet on this working if someone else ran it right now, on a clean checkout?
- If verification wasn't possible (no test harness, no way to run it here), did you say that
  explicitly instead of letting silence imply success?

## Guardrails

- Throughput without a verified outcome is not progress. Don't report a task as done on an
  unverified change.
- Don't add code, abstractions, or comments that don't earn their place — see this repo's own
  `pi-simplify` package for what that looks like in practice.
- Don't silently make an irreversible or genuinely ambiguous call — surface it instead.
