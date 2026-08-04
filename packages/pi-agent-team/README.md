# @geminixiang/pi-agent-team

A rule-agnostic, mailbox-driven agent team runtime for Pi.

## What ships

Production code knows nothing about relay counting, werewolf, expected answers, roles, or phases. It provides only generic coordination — including a generic vote tally, not a domain-specific one: the runtime counts opaque choices and reports ties honestly, it never knows what a vote is *for*.

- independent member identities and unique Pi `AgentSession`s with full pi-coding-agent capability (only extensions are withheld, so a member cannot recursively start teams);
- direct `team_dm` and explicit `team_handoff`; a recipient may be named by member id or by an unambiguous display name — a name shared by two members, or matching none, bounces rather than being guessed at;
- public `team_say` (passive) and `team_broadcast` (interrupts everyone at once — the only member-originated public interrupt; use sparingly);
- immutable restricted groups through `team_group_create` and `team_group_send`;
- opaque atomic `team_claim` with explicit `team_release`, auto-released when the owner finishes or errors;
- `team_vote_cast`/`team_vote_close`: a runtime-tallied poll, never self-declared by a member — a tie is reported honestly and never broken automatically, and the result names which expected voters never cast before close; `choice` is opaque and exact-match, so voting for a member should use their id consistently — two spellings of the same candidate tally as different options, not one; casting is otherwise silent, so once every eligible member has cast, the runtime posts one `POLL_FULLY_CAST` notice waking everyone — otherwise a fully-voted poll can sit forever with nobody ever prompted to close it;
- creating a group requires already holding a claim on that exact id — enforced by the runtime, not left to doctrine, so two members racing to set up the same kind of thing in the same wave can't both succeed and leave a mess to reconcile; a brand-new poll id needs someone to hold that claim before the first vote lands, but any member may then cast, including the first vote — the claim only guards against a second, unrelated poll under the same name;
- a same-source wave (every member made ready by the identical envelope — the initial broadcast, or a `team_broadcast`) executes sequentially instead of concurrently, so later members in that wave observe earlier members' already-applied claims/groups/polls before deciding what to do, instead of everyone independently attempting the same thing at once and reconciling duplicates afterward;
- observation-queue wake-up, `team_wait`, and `team_finish` — each ends a member's turn immediately (the adapter self-aborts the session) instead of letting a member re-poll the same tool dozens of times within one turn;
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
- `team_say` appends public speech but does not wake every worker or consume an LLM turn; `team_broadcast` does wake everyone, at the cost of being the one way a member can trigger a same-source (sequential) wave;
- public announcements are observed the next time a worker wakes for directed work, or immediately if sent via `team_broadcast`;
- the scheduler runs ready workers in concurrent waves — except a same-source wave, which runs sequentially — and reports `idle`, `ready`, `running`, `waiting`, and `finished` separately.

The parent should use opaque unrelated member IDs, send the same initial objective to all members, and let them elect coordination and task order. `startMemberId` remains only as an advanced directed-start escape hatch.

## Local use

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
- poll tallying — clear winners, honest ties, quorum that excludes errored non-voters, that a poll locks in permanently on its first close, that opening a truly unclaimed poll id is rejected, that once claimed any member (not just the claimant) may cast the first vote, that `choice` is opaque exact-match (two spellings of one candidate tally as separate options — a documented behavior, not a bug), and that full participation with nobody sending a single coordinating message still ends in `POLL_FULLY_CAST` and a closed poll rather than a silent deadlock (`test/poll.test.ts`).
- same-source wave sequencing — a wave sharing one cause envelope runs member-by-member, each observing the prior members' committed claims; a wave from distinct envelopes, and a flush-promoted wave, are unaffected; `team_broadcast` wakes every teammate from a single envelope (`test/same-source-wave.test.ts`).
- recipient resolution — an id always resolves; a display name resolves only when it names exactly one member; two members sharing a name, or a name matching none, bounces instead of misdelivering; `team_group_create`'s member list accepts the same mix (`test/recipient-resolution.test.ts`).
- the live prompt text (`formatTurn` in `src/pi-agent.ts`) — asserts what a member actually reads on wake, including that an open poll's tally and missing voters are rendered, not just carried silently in the digest object (`test/pi-agent.test.ts`).

These tests prove the generic runtime routes isolated adapters correctly. They do **not** by themselves prove that a particular LLM reasons independently. That requires a live-model run and transcript inspection. No live result should be reported as stronger evidence than its recorded session IDs, deliveries, wakes, and messages support.

## Limits

- A `completed` settlement means only that all members called `team_finish`; it is not a scenario-specific correctness verdict. A `quiescent` settlement means no members are runnable while unfinished members remain — `errored-members-remain` is a stable terminal state (every survivor finished; the rest can never resume), while `no-runnable-members` may still be genuinely stuck. An `exhausted` settlement means the turn budget ran out with runnable members remaining; the partial result is still returned. Inspect public speech and causal evidence before claiming that the objective succeeded.
- Foreground, process-local execution; no mid-run operator injection (`userInterventions` is always 0).
- A quiescent team may stop before every member calls `team_finish`; this is reported as `quiescent`, never silently called success.
- The parent supplies the initial objective/message. Runtime-generated follow-up hints and scenario-specific fallback decisions do not exist; runtime messages are limited to task-agnostic control notices (claim results, bounces, budget and error alerts).
