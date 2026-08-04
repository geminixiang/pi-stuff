# Agent Team Domain

## Terms

- **Principal** — an actor that can originate a message: a team member, the user, or the runtime.
- **Channel** — an ordered conversation with stable identity and access rules. A channel is public, direct, or group.
- **Audience** — the immutable snapshot of members authorized to observe an envelope when it is posted.
- **Envelope** — one immutable message containing its sender, channel, audience, body, and wake policy.
- **Observation** — an envelope made visible to one authorized member. Observation does not necessarily wake that member.
- **Wake policy** — whether delivery merely records an observation (`passive`) or also makes the recipient runnable (`interrupt`).
- **Public speech** — an envelope posted to the public channel. It is distinct from finishing work.
- **Direct message** — a restricted envelope between one sender and one member.
- **Group message** — a restricted envelope visible only to the immutable membership of a named group channel.
- **Handoff** — a direct interrupt whose purpose is to transfer the next action to one member.
- **Claim** — an atomic ownership attempt and synchronization fence. The result arrives later as a runtime direct message. Resource names are team-visible.
- **Release** — returning a claimed resource. Explicit by the owner, or automatic when the owner finishes or errors.
- **Errored member** — a member whose turn failed. Terminal like `finished`, publicly announced by the runtime, never silently retried.
- **Flush wake** — a final wake delivering undelivered passive observations before the team settles, so no member settles with unread mail.
- **Settlement** — why scheduling stopped. `completed` means every member finished; `quiescent` means no member is runnable while unfinished members remain (`no-runnable-members` if a genuinely idle member could still be woken later, `errored-members-remain` if every non-finished member is terminally errored and the state can never change); `exhausted` means the turn budget ran out with runnable members remaining.
- **Turn end** — `team_wait`, `team_finish`, and `team_claim` end a member's turn immediately: the adapter self-aborts the underlying session so a member cannot loop calling the same tool dozens of times within one turn and exhaust `actionTimeoutMs` on internal re-polling instead of team decisions.

## Invariants

1. Member IDs, names, and peer-list positions carry no scheduling meaning.
2. An envelope's sender, channel, audience, body, and wake policy never change after posting.
3. Only authorized channel members receive plaintext observations.
4. Public speech is passive; it enters every member's observation queue but does not itself consume an agent turn. The runtime's `MEMBER_ERRORED` alert is the sole public interrupt.
5. Direct messages and handoffs interrupt exactly their recipient. An undeliverable or invalid command bounces to its sender as a runtime notice; it never fails silently or fatally.
6. Group messages interrupt exactly the other current group members.
7. A passive observation is delivered the next time its member wakes for an interrupt, or in a final flush wake before the team settles.
8. `finish` is control-plane state, never public speech. A member must explicitly speak before finishing if the objective requires a public answer.
9. A claim is the only accepted command in its turn. No claimant may act as owner before observing `CLAIM_ACQUIRED`. Only the owner may release a claim; all of a member's claims release automatically when it finishes or errors, announced as public passive speech.
10. Restricted plaintext may be shown to the human operator's live privileged view, but is redacted from durable public results and audit payloads.
11. Audit events contain body hashes and audience hashes, never restricted plaintext.
12. Settlement never asserts that the user objective is correct.
13. Audit distinguishes `message.enqueued` (queued for a member) from `message.observed` (actually delivered at a wake); enqueueing never claims observation.
14. A member whose turn fails becomes `errored`: terminal, publicly announced, its claims released, and further messages to it bounce.
15. Members hold full pi-coding-agent capability plus the team tools; only extensions are withheld so a member cannot recursively start teams. `userInterventions` remains hardcoded to 0 until team execution moves off the foreground and a mid-run operator channel exists.
16. `team_wait`, `team_finish`, and `team_claim` end a member's turn: the adapter self-aborts its session immediately after queuing one, so no member can burn its turn budget on repeated same-turn tool calls when there is nothing new to observe. This protocol is owned by a single `TurnState` (`src/turn-state.ts`), a pure state machine with no session or I/O — every custom tool's `execute()` routes its command through the same `apply()`, so the invariant has exactly one place it can be enforced or drift.
17. A `quiescent` settlement whose remaining unfinished members are all `errored` is a stable terminal state, not a stuck one; it is reported distinctly (`errored-members-remain`) from a genuine stuck quiescence (`no-runnable-members`).
18. A member's wake may be preceded by a random `reactionDelayMs` stagger (off by default; product surfaces opt in) so a burst of concurrent wave members doesn't act, or visually present as active, at the exact same instant.

## Communication qualities

Team communication norms live in two layers. **Physics** is what the runtime enforces — behavior that is possible or impossible. **Culture** is what member doctrine (the system prompt) encourages — behavior that is expected but violable. A norm that can be physics should be physics: culture reloads from scratch every session and decays as context grows; physics does not.

Derived from effective human-team communication, an excellent agent team exhibits:

1. **Shared mental model** — every member, on waking, can see team state (who finished, held claims, recent public speech) without reconstructing it from message history. *Physics: runtime-supplied state digest per wake.*
2. **Closed-loop communication** — sending is not delivering. Undeliverable messages (unknown recipient, finished recipient) bounce back to the sender as runtime notices, never fail silently or fatally. Important directed messages expect acknowledgment. *Physics: delivery bounces. Culture: acknowledgment.*
3. **Audience discipline** — public speech is for conclusions, decisions, and results the team or user must hear; directed messages wake exactly who must act. *Physics: channel kinds. Culture: choosing correctly.*
4. **Structured handoff** — a handoff is self-sufficient: situation, what is done, what the recipient must do, whom to notify after. The recipient never needs to excavate history to act. *Culture.*
5. **Floor control without starvation** — claims arbitrate contention; ownership can end (release or auto-release on finish); no member waits forever on observations that will never wake it. *Physics: claim lifecycle and a final flush wake before quiescence.*
6. **Explicit decisions** — a decision must be spoken publicly to exist; `finish` is control state, never an announcement (invariant 8). *Physics.*
7. **Honest escalation** — blocked, rejected, or uncertain members report immediately by directed message instead of waiting silently; finish summaries claim only what the transcript can support. *Culture.*
8. **Closure discipline** — the last step of a chain notifies its initiator before finishing; a coordinator confirms all members before finishing; no orphaned waiters. *Culture, backstopped by the physics of the final flush wake.*
9. **Signal over noise** — speak only to change someone's next action; otherwise wait. *Physics: public speech never interrupts. Culture: WAIT when idle.*

## Member doctrine

The culture layer above, phrased for the member system prompt:

> (a) Public speech is only for conclusions, decisions, and results the team or user must know; it wakes no one. (b) To make someone act, use a directed message or handoff, and make it self-sufficient: situation, what is done, what they must do, whom to notify after. (c) Briefly acknowledge a received handoff before acting on it. (d) If you are the last step of a chain, notify the initiator or coordinator by directed message before finishing. (e) When blocked, rejected, or uncertain, escalate by directed message immediately; never wait silently. (f) If nothing you could say would change anyone's next action, respond WAIT. (g) A finish summary states only what you actually did and the transcript can support.
