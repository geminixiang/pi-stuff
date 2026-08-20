# Agent Team Lifecycle Improvement Evaluation

## Decision under evaluation

Separate a retained team identity from each objective execution:

- `TeamHandle`: stable roster and retained member sessions.
- `RoundRun`: one objective, one execution lifecycle, and one outcome.
- Cancelling a round must not destroy the retained team; a later prompt can start a new round.

This evaluation is intentionally domain-neutral. Werewolf is one stress scenario, not part of the production model.

## Why this is first

Today one run identifier and one status surface conflate the retained team, its current round, and the latest outcome. That makes cancellation and continuation ambiguous. The change is successful only if it makes those states explicit without weakening channel isolation, bounded snapshots, or existing foreground/detached behavior.

## Frozen success criteria

### Gate A — Identity and history correctness (must pass)

1. One stable `teamId` survives at least three rounds.
2. Every round has a unique `roundId` and monotonic `roundIndex`.
3. A round snapshot identifies both `teamId` and `roundId`.
4. The retained team exposes bounded summaries for completed/cancelled rounds; a new round does not overwrite the identity of an older one.
5. Existing member `sessionId` and `sessionRef` values remain stable across continuation rounds.

### Gate B — Cancellation semantics (must pass)

1. Cancelling a running round reaches a terminal round outcome within the existing cancellation timeout.
2. After cancellation, the team becomes available rather than permanently terminal.
3. `team_prompt` after cancellation starts a new round over the same member sessions.
4. Messages or completion from the cancelled round cannot mutate the new round.
5. Repeated cancel is deterministic and does not create an extra round.

### Gate C — Backward compatibility (must pass)

1. `team_start`, `team_get`, `team_wait`, `team_prompt`, and `team_cancel` remain usable through the existing retained handle.
2. The foreground manifest still provides one handle that can be passed to continuation tools.
3. Existing settlement meanings remain unchanged: `completed`, `quiescent`, and `exhausted` describe a round outcome, not objective correctness.
4. Existing public/direct/restricted-group routing and redaction tests remain green.
5. Existing bounded-output limits remain enforced.

### Gate D — Observability (must pass)

A snapshot must let an operator answer, without reading member transcripts:

- Is the team available, running, closing, or closed?
- Which round is current/latest?
- What was that round's objective and terminal outcome?
- Was cancellation requested, and why?
- Which member sessions are retained?

No restricted message body may be added to snapshots, round summaries, or events.

### Gate E — Efficiency guardrails (must not regress)

Use deterministic scripted agents; do not use live-model token cost as a CI gate.

1. Starting a continuation creates no replacement member sessions.
2. Cancellation plus continuation adds no polling loop.
3. `team_wait` remains event-driven through monotonic `stateChangeSeq`.
4. Event history remains capped at the existing limit.
5. Round summaries must have an explicit fixed cap; exceeding it evicts oldest summaries without invalidating the stable team handle.

## Required automated scenarios

Create a focused lifecycle evaluation test suite covering:

| Scenario | Required assertions |
|---|---|
| Three completed rounds | Stable `teamId`; three unique `roundId`s; indices 1, 2, 3; stable member sessions |
| Cancel then continue | Round 1 cancelled; team available; round 2 runs and settles normally |
| Cancel race | Late round-1 completion cannot settle or write into round 2 |
| Wait across transitions | `stateChangeSeq` strictly increases for cancel request, round settlement, and next-round start |
| History cap | Oldest round summary evicted at cap; latest/current identity remains correct |
| Privacy regression | Round metadata contains no direct/group plaintext canary |
| Existing channels | Public, DM, and restricted group tests remain unchanged and green |
| Foreground manifest | Stable team handle plus explicit latest round identity/outcome |

## Baseline to record before implementation

Run from repository root:

```sh
npm test --workspace @geminixiang/pi-agent-team
npm run check --workspace @geminixiang/pi-agent-team
```

Record:

- passing/failing test count;
- wall-clock test duration;
- current snapshot shape for start → settle → continue;
- current cancel → prompt behavior;
- current bounded event/result limits.

A known pre-change failure that demonstrates the lifecycle ambiguity is allowed only in the new focused evaluation test. All pre-existing tests must remain green before implementation begins.

## Acceptance command

After implementation:

```sh
npm test --workspace @geminixiang/pi-agent-team
npm run check --workspace @geminixiang/pi-agent-team
```

The change is accepted only when:

1. Gates A–E pass in automated tests.
2. No pre-existing test is deleted or weakened to pass.
3. Public API changes are documented with a migration note.
4. A reviewer verifies that production code remains scenario-neutral.
5. The final diff contains no werewolf-specific production symbols.

## Before / after evaluation table

| Question | Before | Required after |
|---|---|---|
| What does the retained ID identify? | Team and latest run are conflated | Stable team handle only |
| Can a cancelled team continue? | Cancellation leaves an unusable retained record | A new round starts on the same team |
| Can two rounds be distinguished? | No first-class round identity/history | Unique `roundId`, index, bounded summaries |
| What does status describe? | Manager/run status mixes control plane and outcome | Team lifecycle and round lifecycle are separate |
| Are member histories retained? | Yes | Yes, with the same session identities |
| Does this add domain logic? | No | No; lifecycle remains rule-agnostic |

## Non-goals for this change

Do not combine these into the lifecycle patch:

- werewolf/game state;
- durable recovery after parent-process restart;
- typed claim namespaces;
- block-reason confidentiality redesign;
- wait-abort UI wording;
- semantic/idempotent group aliases.

Those require separate evaluations and diffs. Keeping them out makes lifecycle regression attribution possible.
