# @geminixiang/pi-agent-team

[![npm](https://img.shields.io/npm/v/%40geminixiang%2Fpi-agent-team)](https://www.npmjs.com/package/@geminixiang/pi-agent-team)

A rule-agnostic, mailbox-driven agent team runtime for Pi.

## Install

Install as a [pi package](https://github.com/earendil-works/pi) — this registers the `team_start` tool in your pi sessions:

```sh
pi install npm:@geminixiang/pi-agent-team
```

Or try it once without installing (temporary for the current run only):

```sh
pi -e npm:@geminixiang/pi-agent-team
```

`pi remove npm:@geminixiang/pi-agent-team` uninstalls it. Use `pi install -l` to write to project settings (`.pi/settings.json`) instead of user settings.

## What ships

Production code knows nothing about relay counting, werewolf, expected answers, roles, or phases. It provides only generic coordination — including a generic vote tally, not a domain-specific one: the runtime counts opaque choices and reports ties honestly, it never knows what a vote is *for*.

- independent member identities and unique Pi `AgentSession`s with full pi-coding-agent capability (only extensions are withheld, so a member cannot recursively start teams); ids are validated unique, non-empty, and free of collisions with the runtime's own reserved principal ids ("user", "runtime") or the extension's "all" sentinel;
- direct `team_dm` and explicit `team_handoff`; a recipient may be named by member id or by an unambiguous display name — a name shared by two members, or matching none, bounces rather than being guessed at; sending to yourself bounces the same way instead of silently vanishing;
- public `team_say` (passive by default; mentioning teammates in `to` keeps the message public while waking exactly the mentioned members to reply — the normal way to hold a conversation without a DM restating the public message) and `team_broadcast` (interrupts everyone at once; use sparingly);
- immutable restricted groups through `team_group_create` and `team_group_send`;
- opaque atomic `team_claim` with explicit `team_release`, auto-released when the owner finishes or errors;
- `team_vote_cast`/`team_vote_close`: a runtime-tallied poll, never self-declared by a member — a tie is reported honestly and never broken automatically, and the result names which expected voters never cast before close; `choice` is opaque and exact-match, so voting for a member should use their id consistently — two spellings of the same candidate tally as different options, not one; casting is otherwise silent, so once every eligible member has cast, the runtime posts one `POLL_FULLY_CAST` notice waking everyone — otherwise a fully-voted poll can sit forever with nobody ever prompted to close it; eligibility is quorum-aware (`finish`/`error` shrink it, not only a cast), so the notice still fires when the last outstanding voter finishes instead of casting, without ever vacuously firing for a poll nobody voted in;
- creating a group requires already holding a claim on that exact id — enforced by the runtime, not left to doctrine, so two members racing to set up the same kind of thing in the same wave can't both succeed and leave a mess to reconcile; a brand-new poll id needs someone to hold that claim before the first vote lands, but any member may then cast, including the first vote — the claim only guards against a second, unrelated poll under the same name;
- a same-source wave (every member made ready by the identical envelope — the initial broadcast, or a `team_broadcast`) executes sequentially instead of concurrently, so later members in that wave observe earlier members' already-applied claims/groups/polls before deciding what to do, instead of everyone independently attempting the same thing at once and reconciling duplicates afterward; when that shared envelope is the *single initial post*, the opening wave additionally gives every member an independent first take — a peer's opening `team_say` is held back until every member has drafted, then revealed to everyone together, so the coordination benefit of sequential wake-up doesn't come at the cost of anchoring; an explicit interrupt or mention reaching a still-undrafted member lifts its barrier early, merging the held-back public context into its mailbox in envelope order before the prompt that depends on it;
- observation-queue wake-up, `team_wait`, and `team_finish` — each ends a member's turn immediately (the adapter self-aborts the session) instead of letting a member re-poll the same tool dozens of times within one turn; the runtime independently truncates any returned command batch at the same points (claim alone, or cut after the first wait/finish) so this physics holds for any `TeamAgent`, not only the Pi adapter's `TurnState`-gated one;
- a control-plane digest (member states, held claims, own groups, open polls' live tally and missing voters) supplied on every wake;
- error degradation: a member whose turn fails becomes `errored`, announced publicly, and messages to it bounce back to the sender;
- a final flush wake that delivers undelivered passive observations before the team settles;
- hash-chained causal audit events with private bodies redacted;
- two live views for two audiences, both TUI-only: a Discord-style presence roster (who's speaking, who they last addressed, who's idle/finished/errored) pinned above the editor for the duration of the run, and a full blow-by-blow chat transcript in the tool-result card for debugging and as the permanent session record.

## Coordination model

The runtime follows CPU-style worker coordination rather than assigning a workflow order:

- all members start as symmetric workers when `startMemberId` is omitted;
- member IDs and peer-list positions carry no scheduling meaning;
- `team_claim` is an atomic compare-and-swap-like election/work-ownership primitive and a synchronization fence: it must be the only action in that response, and the caller may act as owner only after a later private `CLAIM_ACQUIRED`;
- `team_dm` and `team_handoff` are directed mailbox interrupts that wake exactly one worker;
- `team_group_send` is restricted to an immutable group audience and wakes its other members;
- `team_say` appends public speech without consuming an LLM turn; on its own it wakes no one, while its mentioned recipients (`to`) are woken like a directed interrupt; `team_broadcast` wakes everyone, at the cost of being the one way a member can trigger a same-source (sequential) wave;
- public announcements are observed the next time a worker wakes for directed work, or immediately if sent via `team_broadcast`;
- the scheduler runs ready workers in concurrent waves — except a same-source wave, which runs sequentially — and reports `idle`, `ready`, `running`, `waiting`, and `finished` separately.

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

`team_start` accepts an objective, roster, one initial message, and either one starting member or all members. After launch, only member tool calls route subsequent messages.

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
- the turn-ending protocol (`TurnState` in `src/turn-state.ts`) — accept/reject decisions, guard-text distinctions, and the queued-command set — fully covered without a live model, since it's pure: no session, no I/O.
- poll tallying — clear winners, honest ties, quorum that excludes any terminal (errored or finished) non-voter, that a poll locks in permanently on its first close, that opening a truly unclaimed poll id is rejected, that once claimed any member (not just the claimant) may cast the first vote, that `choice` is opaque exact-match (two spellings of one candidate tally as separate options — a documented behavior, not a bug), that full participation with nobody sending a single coordinating message still ends in `POLL_FULLY_CAST` and a closed poll rather than a silent deadlock, that the last outstanding voter finishing instead of casting still triggers the notice, and that a never-voted poll is never vacuously announced fully cast just because everyone eventually finished (`test/poll.test.ts`).
- same-source wave sequencing — a wave sharing one cause envelope runs member-by-member, each observing the prior members' committed claims; a wave from distinct envelopes, and a flush-promoted wave, are unaffected; `team_broadcast` wakes every teammate from a single envelope; the opening wave specifically gives every member an independent first take (no peer speech leaks into their first observation batch) before revealing everyone's drafts together on the next turn (`test/same-source-wave.test.ts`).
- recipient resolution — an id always resolves; a display name resolves only when it names exactly one member; two members sharing a name, or a name matching none, bounces instead of misdelivering; a self-addressed direct message or handoff bounces the same way instead of silently vanishing; PEERS never includes the waking member itself; `team_group_create`'s member list accepts the same id/name mix (`test/recipient-resolution.test.ts`).
- member identity — empty, whitespace-only, and reserved-principal-id member ids are rejected by the runtime; duplicate ids and the extension's "all" sentinel are rejected before a raw roster array can silently fold into one `Map` entry (`test/identity.test.ts`).
- the turn-ending and budget physics enforced by the core itself, not only the Pi adapter — any `TeamAgent`'s batch is truncated at `wait`/`finish`, `maxTurns` is a real per-wave hard cap, and `run()` may only be called once per instance (`test/runtime.test.ts`, `test/coordination.test.ts`).
- the live prompt text (`formatTurn` in `src/pi-agent.ts`) — asserts what a member actually reads on wake, including that an open poll's tally and missing voters are rendered, not just carried silently in the digest object (`test/pi-agent.test.ts`).

These tests prove the generic runtime routes isolated adapters correctly. They do **not** by themselves prove that a particular LLM reasons independently. That requires a live-model run and transcript inspection. No live result should be reported as stronger evidence than its recorded session IDs, deliveries, wakes, and messages support.

## Limits

- A `completed` settlement means only that all members called `team_finish`; it is not a scenario-specific correctness verdict. A `quiescent` settlement means no members are runnable while unfinished members remain — `errored-members-remain` is a stable terminal state (every survivor finished; the rest can never resume), while `no-runnable-members` may still be genuinely stuck. An `exhausted` settlement means the turn budget ran out with runnable members remaining, enforced as a real per-wave hard cap rather than only checked before a wave starts; the partial result is still returned. Inspect public speech and causal evidence before claiming that the objective succeeded.
- Foreground, process-local execution; no mid-run operator injection (`userInterventions` is always 0). A `TeamRuntime` instance runs exactly once — construct a new one for another run rather than calling `run()` twice.
- A quiescent team may stop before every member calls `team_finish`; this is reported as `quiescent`, never silently called success.
- The parent supplies the initial objective/message. Runtime-generated follow-up hints and scenario-specific fallback decisions do not exist; runtime messages are limited to task-agnostic control notices (claim results, bounces, budget and error alerts).
- A command batch returned by one turn is applied in order as ordered best-effort, not as a transaction: a failed command bounces on its own without skipping or rolling back whatever follows it in the same batch. A genuine cross-command dependency needs a cross-turn fence (a claim, or waiting for a confirmation message), not same-batch ordering.
- "Independent" bundles three separate guarantees, not all equally strong. Session independence (separate `AgentSession`s, unique ids) is fully enforced. Epistemic independence (forming a view without a peer's conclusion already in hand) is enforced only for the very first turn of a single-post opening wave — after that it's a matter of doctrine and prompt framing, not runtime physics. Filesystem independence is *not* provided at all: every member shares the parent process's `cwd` and full tool access, so `team_claim` arbitrates logical ownership by convention, not with an OS-level lock — two members can still physically write the same file at once if they don't cooperate. Read "independent agent team" as "separate conversations," never as "sandboxed" or "worktree-isolated."
