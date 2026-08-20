# @geminixiang/pi-agent-team

[![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-agent-team)](https://www.npmjs.com/package/@geminixiang/pi-agent-team)

A rule-agnostic, mailbox-driven agent team runtime for Pi.

## Install

Install as a [pi package](https://github.com/earendil-works/pi) — this registers `team_start`, the retained-team control tools, and the bundled `pi-agent-team` operator skill in your pi sessions:

```sh
pi install npm:@geminixiang/pi-agent-team
```

Or try it once without installing (temporary for the current run only):

```sh
pi -e npm:@geminixiang/pi-agent-team
```

`pi remove npm:@geminixiang/pi-agent-team` uninstalls it. Use `pi install -l` to write to project settings (`.pi/settings.json`) instead of user settings.

## Lifecycle API migration

Existing callers do not need to change the handle they store: the tool parameter remains named `runId` for compatibility, but its value now identifies the retained team (`teamId`), not an individual execution. Snapshots expose team lifecycle through both `teamStatus` and its `lifecycle` alias, while `latestRound`/`currentRound` explicitly identify the current or latest `RoundRun`; the existing flat `roundId`, `roundIndex`, objective, result, and round `status` fields remain compatibility aliases. Terminal `rounds` are bounded to the latest 16 summaries, and restricted message bodies are never included.

`team_cancel` is idempotent for the latest cancelled round. Callers that retry asynchronously may pass the observed optional `roundId`; if a newer round has started, the stale cancellation is a no-op. Once cancellation settles, `team_prompt` starts a fresh round on the same member `sessionId`/`sessionRef` values. Events and late runtime callbacks are round-scoped so an older completion cannot settle or modify a newer round.

## What ships

The bundled `pi-agent-team` skill teaches the parent agent when to use foreground or detached mode, how to observe and intervene without polling or unsolicited guidance, and how to continue a settled retained team. It is withheld from member sessions, which lack `team_start`, while their other installed skills remain available.

Production code knows nothing about relay counting, werewolf, expected answers, roles, or phases. It provides only generic coordination — including a generic vote tally, not a domain-specific one: the runtime counts opaque choices and reports ties honestly, it never knows what a vote is *for*.

- independent member identities and unique Pi `AgentSession`s with full pi-coding-agent capability (only extensions are withheld, so a member cannot recursively start teams); ids are validated unique, non-empty, and free of collisions with the runtime's own reserved principal ids ("user", "runtime") or the extension's "all" sentinel; settlement ends one coordination round but retains these sessions, so `team_prompt` can address any member afterward and start a fresh round over the same first-person histories;
- member sessions persisted to the project's default Pi session directory (named `agent team · <name> (<id>)`, linked to the parent via `parentSession`), so every member's full first-person history survives the run — and even a mid-run crash — and is readable/resumable with ordinary Pi session tooling; the result carries each member's `sessionId` and `sessionRef` (file path);
- a post-settlement **report turn**: the reporter — pre-designated via `reporterId`, or whoever last validly held the special `"reporter"` claim (kept on finish, renounced by voluntary release, cleared on error) — gets one final prompt after the team settles, and its response is returned verbatim as the team's report; `reportPrompt` passes the caller's reporting instructions through untouched, and with no reporter the result honestly says so instead of the runtime writing one itself;
- direct `team_dm` and explicit `team_handoff`; a recipient may be named by member id or by an unambiguous display name — a name shared by two members, or matching none, bounces rather than being guessed at; sending to yourself bounces the same way instead of silently vanishing;
- public `team_say` (passive by default; mentioning teammates in `to` keeps the message public while waking exactly the mentioned members to reply — the normal way to hold a conversation without a DM restating the public message) and `team_broadcast` (interrupts everyone at once; use sparingly);
- immutable restricted groups through `team_group_create` and `team_group_send`;
- opaque atomic `team_claim` with explicit `team_release`, auto-released when the owner finishes or errors;
- `team_vote_open`/`team_vote_cast`/`team_vote_abstain`/`team_vote_close`: a runtime-tallied poll, never self-declared by a member. Opening declares whether the initiator votes (so a moderator can stay outside the electorate), a bounded 0–3 idle-time reminder budget, and whether exhausted non-responders remain missing or become explicit abstentions. Abstention is first-class and can never win as a textual choice. Once every eligible member votes or abstains, the initiator is directly woken to close; ties are reported honestly, choices remain opaque exact-match strings, and terminal non-responders leave quorum while blocked members remain eligible. Legacy claim-then-cast callers retain the former all-member, no-reminder behavior;
- creating a group requires already holding a claim on that exact id — enforced by the runtime, not left to doctrine, so two members racing to set up the same kind of thing in the same wave can't both succeed and leave a mess to reconcile; a brand-new poll id needs someone to hold that claim before the first vote lands, but any member may then cast, including the first vote — the claim only guards against a second, unrelated poll under the same name;
- a same-source wave (every member made ready by the identical envelope — the initial broadcast, or a `team_broadcast`) executes sequentially instead of concurrently, so later members in that wave observe earlier members' already-applied claims/groups/polls before deciding what to do, instead of everyone independently attempting the same thing at once and reconciling duplicates afterward; when that shared envelope is the *single initial post*, the opening wave additionally gives every member an independent first take — a peer's opening `team_say` is held back until every member has drafted, then revealed to everyone together, so the coordination benefit of sequential wake-up doesn't come at the cost of anchoring; an explicit interrupt or mention reaching a still-undrafted member lifts its barrier early, merging the held-back public context into its mailbox in envelope order before the prompt that depends on it;
- a hard freshness fence at the `act()`/commit boundary: if new authorized observations arrive while a member is thinking, the runtime holds its entire stale batch (including finish, claim, wait, or block), delivers all new envelopes in sequence order, and spends another bounded turn rethinking; validation-to-commit is synchronous, held speech never enters the public transcript, and Pi tool results describe commands honestly as provisional/queued until that commit;
- observation-queue wake-up, `team_wait`, `team_block`, and `team_finish` — each ends a member's turn immediately (the adapter self-aborts the session). `team_block(reason)` is an explicit non-terminal request for requester input: the reason is saved, the member stops waking, and a detached run parks without polling until `team_prompt` resumes it; blocked members retain queued mail, claims, and poll eligibility;
- process-local retained teams and optional detached execution: `team_start({ detached: true, ... })` returns a `runId` immediately in long-lived TUI/RPC sessions, while a foreground run exposes the same handle as `team` in its final manifest. `team_get` reads a bounded snapshot, `team_wait` waits on `stateChangeSeq` without polling, and `team_prompt` intervenes with one member during a live round. After settlement, that same prompt starts a clean continuation round using its message as the new objective: coordination state resets, but every member's Pi session and history remain. `team_cancel` aborts the current round through a run-owned signal. Lightweight event history is capped at 512 entries per retained team, at most 64 teams are retained, and events exclude message bodies; live rounds are cancelled and all retained sessions disposed on parent-session shutdown;
- a control-plane digest (member states, blocked reasons, held claims, own groups, open polls' live tally and missing voters) supplied on every wake;
- error degradation: a member whose turn fails becomes `errored`, announced publicly, and messages to it bounce back to the sender;
- a final flush wake that delivers undelivered passive observations before the team settles;
- hash-chained causal audit events with private bodies redacted;
- two live views for two audiences, both TUI-only: a Discord-style presence roster (who's speaking, who they last addressed, who's idle/finished/errored) pinned above the editor for the duration of the run, and a full blow-by-blow chat transcript in the tool-result card for debugging;
- a **bounded final result**: the model-visible tool content is the reporter's report plus a pointer-based manifest (settlement, per-member state/turns/session pointers, message and event *counts*, audit head) — never the raw transcript or event log, which once returned ~1.2M chars from a single game and forced a split-turn compaction of the parent session; the persisted display snapshot is likewise capped at the last 200 activities. The permanent record is the member session files, not the tool result.

## Coordination model

The runtime follows CPU-style worker coordination rather than assigning a workflow order:

- all members start as symmetric workers when `startMemberId` is omitted;
- member IDs and peer-list positions carry no scheduling meaning;
- `team_claim` is an atomic compare-and-swap-like election/work-ownership primitive and a synchronization fence: it must be the only action in that response, and the caller may act as owner only after a later private `CLAIM_ACQUIRED`;
- `team_dm` and `team_handoff` are directed mailbox interrupts that wake exactly one worker;
- `team_group_send` is restricted to an immutable group audience and wakes its other members;
- `team_say` appends public speech without consuming an LLM turn; on its own it wakes no one, while its mentioned recipients (`to`) are woken like a directed interrupt; `team_broadcast` wakes everyone, at the cost of being the one way a member can trigger a same-source (sequential) wave;
- public announcements are observed the next time a worker wakes for directed work, or immediately if sent via `team_broadcast`;
- the scheduler runs ready workers in concurrent waves — except a same-source wave, which runs sequentially — and reports `idle`, `ready`, `running`, `waiting`, `blocked`, `finished`, and `errored` separately.

The parent should use opaque unrelated member IDs, send the same initial objective to all members, and let them elect coordination and task order. `startMemberId` remains only as an advanced directed-start escape hatch.

## Local development use

From a checkout of this repo, load the extension straight from source:

```sh
pi --no-extensions -e ./packages/pi-agent-team/src/extension.ts --approve
```

Example prompt:

```text
Call team_start once. Create 8 members with opaque, unrelated IDs and names. Do not encode order in IDs, names, or member array position. Objective: autonomously coordinate so every member publicly says exactly one distinct number and the public sequence is 1 through 8. Omit startMemberId and send every member the same initial message: "Elect a coordinator using team_claim. Negotiate an order using directed messages, not peer-list position. Directed handoff wakes the next worker; public speech does not wake peers. Each worker must call team_say with its number before team_finish. Complete without user help." Do not inject later messages or expected answers.
```

`team_start` accepts an objective, roster, one initial message, and either one starting member or all members; optional `reporterId` pre-designates who delivers the final report, and optional `reportPrompt` carries the caller's reporting instructions (format, files, language) verbatim into that final turn. By default it remains synchronous. With `detached: true`, use the returned `runId` with `team_get`, `team_wait`, `team_prompt`, and `team_cancel`; requester prompts are counted in `userInterventions` and attributed as user messages.

## Honest acceptance scope

The experiments live only in `test/acceptance/`; production does not import them.

```sh
npm test --workspace @geminixiang/pi-agent-team
```

The LLM-free suite verifies transport and isolation properties reproducibly:

- a runtime-randomized, eight-member transformation chain whose operations are private to each adapter;
- unique session IDs, private canaries, causal send → delivery → wake evidence;
- removing a required stage prevents the runtime from inventing the expected result;
- an external moderator and eight opaque players complete a hidden-role game entirely through generic messages;
- game roles are shuffled and private; public evidence contains only hashes for private bodies.
- the turn-ending protocol (`TurnState` in `src/turn-state.ts`) — including `team_block` self-abort/batch truncation — is fully covered without a live model, since it's pure: no session, no I/O;
- blocked-member physics: stable quiescence, parked detached resumption, passive mailbox retention (including opening-wave reveals), claim and poll eligibility, honest intervention attribution, abort closure, digest reasons, and attention-first TUI ordering (`test/blocked.test.ts`);
- detached control-plane behavior: immediate start, monotonic non-polling waits, run-owned cancellation, explicit invalid/terminal errors, 512-event and 64-run caps, body-free activity summaries, and bounded report snapshots (`test/run-manager.test.ts`);
- poll policy and tallying — non-voting initiators, bounded reminders, explicit and automatic abstention, initiator-only completion wakes, clear winners, honest ties, terminal-aware quorum, immutable close results, claimed poll namespaces, opaque exact-match choices, legacy full-participation wakes, and zero-vote edge cases (`test/poll.test.ts`).
- same-source wave sequencing — a wave sharing one cause envelope runs member-by-member, each observing the prior members' committed claims; a wave from distinct envelopes, and a flush-promoted wave, are unaffected; `team_broadcast` wakes every teammate from a single envelope; the opening wave specifically gives every member an independent first take (no peer speech leaks into their first observation batch) before revealing everyone's drafts together on the next turn (`test/same-source-wave.test.ts`).
- recipient resolution — an id always resolves; a display name resolves only when it names exactly one member; two members sharing a name, or a name matching none, bounces instead of misdelivering; a self-addressed direct message or handoff bounces the same way instead of silently vanishing; PEERS never includes the waking member itself; `team_group_create`'s member list accepts the same id/name mix (`test/recipient-resolution.test.ts`).
- member identity — empty, whitespace-only, and reserved-principal-id member ids are rejected by the runtime; duplicate ids and the extension's "all" sentinel are rejected before a raw roster array can silently fold into one `Map` entry (`test/identity.test.ts`).
- the turn-ending and budget physics enforced by the core itself, not only the Pi adapter — any `TeamAgent`'s batch is truncated at `wait`/`finish`, `maxTurns` is a real per-wave hard cap, and `run()` may only be called once per instance (`test/runtime.test.ts`, `test/coordination.test.ts`).
- the live prompt text (`formatTurn` in `src/pi-agent.ts`) — asserts what a member actually reads on wake, including that an open poll's tally and missing voters are rendered, not just carried silently in the digest object (`test/pi-agent.test.ts`).

These tests prove the generic runtime routes isolated adapters correctly. They do **not** by themselves prove that a particular LLM reasons independently. That requires a live-model run and transcript inspection. No live result should be reported as stronger evidence than its recorded session IDs, deliveries, wakes, and messages support.

## Limits

- A `completed` settlement means only that all members called `team_finish`; it is not a scenario-specific correctness verdict. A `quiescent` settlement means no members are runnable while unfinished members remain — `errored-members-remain` is terminal failure, `blocked-members-remain` is an explicit requester wait (for non-detached runs), and `no-runnable-members` may be a genuine deadlock. An `exhausted` settlement means the turn budget ran out with runnable members remaining, enforced as a real per-wave hard cap rather than only checked before a wave starts; the partial result is still returned. Inspect public speech and causal evidence before claiming that the objective succeeded.
- **Stable team identity, explicit round identity.** Control tools continue to accept the original `runId` parameter as a stable `teamId` handle. Every objective execution has a unique `roundId` and monotonic `roundIndex`; snapshots expose `lifecycle`, the current/latest round, cancellation metadata, and capped terminal summaries.
- A synchronous `team_start` remains foreground until its first round settles. Its manifest's stable `team` id is then accepted by `team_get` and `team_prompt`; prompting an available team continues the retained team in a new background round. Retained teams and their controls are process/session-local: no daemon, socket API, or restart persistence. A `TeamRuntime` instance still represents exactly one round; continuation creates a clean runtime over the retained agent sessions rather than reusing settled coordination state. Cancellation settles only the current round; the retained member sessions remain available.
- A quiescent team may stop before every member calls `team_finish`; this is reported as `quiescent`, never silently called success.
- The parent supplies the initial objective/message. Runtime-generated follow-up hints and scenario-specific fallback decisions do not exist; runtime messages are limited to task-agnostic control notices (claim results, bounces, budget and error alerts).
- A command batch returned by one turn first passes a hard freshness fence: if an authorized observation arrived for that member during `act()`, none of the stale batch commits and the member rethinks from all new observations. Otherwise it is applied in order and fail-stop, not as a transaction: commands that already committed are never rolled back, but the first rejected command halts the batch and everything after it is discarded. The rejection bounces back (`COMMAND_FAILED`, plus `COMMAND_BATCH_HALTED` when later commands were discarded) and wakes the member to replan next turn — so a rejected send can no longer be sealed off by a `finish` queued behind it in the same batch. A genuine cross-command dependency still needs a cross-turn fence (a claim, or waiting for a confirmation message), not same-batch ordering.
- "Independent" bundles three separate guarantees, not all equally strong. Session independence (separate `AgentSession`s, unique ids) is fully enforced. Epistemic independence (forming a view without a peer's conclusion already in hand) is enforced only for the very first turn of a single-post opening wave — after that it's a matter of doctrine and prompt framing, not runtime physics. Filesystem independence is *not* provided at all: every member shares the parent process's `cwd` and full tool access, so `team_claim` arbitrates logical ownership by convention, not with an OS-level lock — two members can still physically write the same file at once if they don't cooperate. Read "independent agent team" as "separate conversations," never as "sandboxed" or "worktree-isolated."
