export type MemberId = string;
export type MessageId = string;
export type ChannelId = string;
export type PrincipalId = MemberId | "user" | "runtime";

export interface TeamMember {
  id: MemberId;
  name: string;
}

/**
 * A MemberId must never be empty/whitespace-only, nor collide with the
 * other two PrincipalId variants ("user", "runtime") — every place that
 * distinguishes a real member from the runtime/user sentinel principals
 * (resolveMemberId, digest state, bounce and audit messages addressed "to
 * runtime") relies on that separation holding.
 */
export function assertValidMemberId(id: MemberId): void {
  if (!id.trim()) throw new Error("Member id must not be empty or whitespace-only");
  if (id === "user" || id === "runtime")
    throw new Error(
      `Member id "${id}" collides with a reserved principal id; choose a different id`,
    );
}

export type Channel =
  | { kind: "public"; id: "public" }
  | { kind: "direct"; id: ChannelId; members: readonly [PrincipalId, MemberId] }
  | { kind: "group"; id: ChannelId; name: string; members: readonly MemberId[] };

export type ChannelTarget =
  | { kind: "public" }
  | { kind: "direct"; memberId: MemberId }
  | { kind: "group"; channelId: ChannelId };

export type WakePolicy = "passive" | "interrupt";

export interface MessageEnvelope {
  id: MessageId;
  sequence: number;
  from: PrincipalId;
  channel: Channel;
  audience: readonly MemberId[];
  body: string;
  wake: WakePolicy;
  /**
   * Members this public speech explicitly addresses. Mentioned members are
   * woken to reply even though the envelope's channel-level wake policy is
   * passive — one public message both shares its content with everyone and
   * hands the floor to its named next speakers, which is how a conversation
   * flows without a follow-up direct message restating it.
   */
  mentions: readonly MemberId[];
  purpose: "speech" | "message" | "handoff" | "system";
  sentAt: number;
}

/**
 * Control-plane team state supplied on every wake so members never reconstruct
 * it from message history. Explicit work claim resources are team-visible by
 * design. A restricted group's implicit channel claim is visible only to that
 * group's members, matching the group's metadata visibility. Groups include
 * only those the waking member belongs to. Polls are open ballots only — once
 * closed, the result is a public message, not live state (released claims drop
 * out of `claims` too).
 */
export interface TeamDigest {
  states: Readonly<Record<MemberId, TeamMemberState>>;
  blockedReasons: Readonly<Record<MemberId, string>>;
  claims: Readonly<Record<string, MemberId>>;
  groups: readonly { id: ChannelId; name: string; members: readonly MemberId[] }[];
  polls: readonly {
    pollId: string;
    initiator: MemberId;
    tally: Readonly<Record<string, number>>;
    abstained: readonly MemberId[];
    autoAbstained: readonly MemberId[];
    missing: readonly MemberId[];
  }[];
}

export interface TeamTurn {
  teamId: string;
  objective: string;
  member: TeamMember;
  peers: readonly TeamMember[];
  observations: readonly MessageEnvelope[];
  digest: TeamDigest;
  turn: number;
}

export type TeamCommand =
  | { type: "say"; body: string; to?: readonly string[] }
  | { type: "broadcast"; body: string }
  | { type: "send"; to: MemberId; body: string }
  | { type: "create-group"; channelId: ChannelId; name: string; members: readonly MemberId[] }
  | { type: "group-send"; channelId: ChannelId; body: string }
  | { type: "claim"; resource: string }
  | { type: "release"; resource: string }
  | {
      type: "vote-open";
      pollId: string;
      initiatorVotes: boolean;
      maxReminders: number;
      onReminderExhausted: "leave-missing" | "abstain";
    }
  | { type: "vote-cast"; pollId: string; choice: string }
  | { type: "vote-abstain"; pollId: string }
  | { type: "vote-close"; pollId: string }
  | { type: "handoff"; to: MemberId; body: string }
  | { type: "finish"; summary: string }
  | { type: "wait" }
  | { type: "block"; reason: string };

/**
 * How a poll resolved: a clear winner, an honest tie (the runtime never
 * breaks it — that's a team decision, not the runtime's to make, same
 * principle as invariant 12: settlement never asserts correctness), or no
 * votes at all.
 */
export type PollOutcome =
  | { kind: "winner"; choice: string }
  | { kind: "tie"; choices: readonly string[] }
  | { kind: "no-votes" };

/**
 * The runtime-computed, code-tallied result of a closed poll. `votes` is
 * the full per-member breakdown — polls are open ballots, not secret, same
 * transparency stance as claim resource names. Abstention is first-class
 * response state and never becomes a tally choice; `autoAbstained` names
 * the members whose configured reminder budget expired. `eligible`
 * excludes terminal non-responders at close time; `missing` contains the
 * remaining eligible members who neither voted nor abstained.
 */
export interface PollResult {
  pollId: string;
  tally: Readonly<Record<string, number>>;
  votes: Readonly<Record<MemberId, string>>;
  abstained: readonly MemberId[];
  autoAbstained: readonly MemberId[];
  eligible: readonly MemberId[];
  missing: readonly MemberId[];
  outcome: PollOutcome;
}

export interface TeamAgent {
  readonly member: TeamMember;
  readonly sessionId: string;
  /**
   * Durable pointer to this member's full first-person history (for Pi
   * agents, the session JSONL file path) when the adapter persists one.
   * The runtime copies it verbatim into the result so a caller can trace
   * what any member saw and did without the runtime carrying transcripts.
   */
  readonly sessionRef?: string;
  act(turn: TeamTurn, signal: AbortSignal): Promise<readonly TeamCommand[]>;
  /**
   * One extra LLM turn after the team settles: the runtime prompts the
   * designated reporter and the final assistant response is returned
   * verbatim as the team's report. Coordination is over by then — the
   * adapter must not queue team commands from this turn.
   */
  report?(prompt: string, signal: AbortSignal): Promise<string>;
  close?(): Promise<void> | void;
}

export interface AuditEvent {
  sequence: number;
  type:
    | "team.started"
    | "channel.created"
    | "message.posted"
    | "message.enqueued"
    | "message.observed"
    | "member.woke"
    | "member.flushWoke"
    | "member.batchHeld"
    | "member.claimed"
    | "member.claimRejected"
    | "claim.released"
    | "poll.opened"
    | "poll.cast"
    | "poll.abstained"
    | "poll.reminded"
    | "poll.closed"
    | "member.finished"
    | "member.errored"
    | "member.blocked"
    | "member.intervened"
    | "report.requested"
    | "report.submitted"
    | "report.failed"
    | "command.failed"
    | "observer.failed"
    | "team.completed"
    | "team.quiescent"
    | "team.exhausted";
  memberId?: MemberId;
  messageId?: MessageId;
  data: Readonly<Record<string, unknown>>;
  previousHash: string;
  hash: string;
}

export type TeamMemberState =
  | "idle"
  | "ready"
  | "running"
  | "waiting"
  | "finished"
  | "errored"
  | "blocked";

export interface TeamProgress {
  teamId: string;
  active: readonly MemberId[];
  finished: readonly MemberId[];
  blocked: readonly MemberId[];
  blockedReasons: Readonly<Record<MemberId, string>>;
  states: Readonly<Record<MemberId, TeamMemberState>>;
  queuedMessages: number;
  turns: number;
  recent: string;
}

export interface TeamActivity {
  sequence: number;
  memberId: PrincipalId;
  kind:
    | "message"
    | "wake"
    | "claim"
    | "vote"
    | "finish"
    | "wait"
    | "block"
    | "channel"
    | "error"
    | "report";
  text: string;
  visibility: "public" | "restricted";
  channel: ChannelTarget;
  targetIds: readonly MemberId[];
  /** For public speech: the members this message mentions (and wakes). */
  mentions?: readonly MemberId[];
  body?: string;
}

export type TeamSettlement =
  | { kind: "completed"; meaning: "all-members-finished" }
  | { kind: "quiescent"; meaning: "no-runnable-members" }
  | { kind: "quiescent"; meaning: "errored-members-remain" }
  | { kind: "quiescent"; meaning: "blocked-members-remain" }
  | { kind: "exhausted"; meaning: "max-turns-reached" };

export interface TeamResult {
  teamId: string;
  settlement: TeamSettlement;
  objectiveVerification: "unverified";
  /**
   * The reporter's post-settlement turn, verbatim. Present only when a
   * reporter existed (designated via options or by holding the "reporter"
   * claim) and its report turn produced a response. The runtime records
   * who reported and what they said; it never judges the content — same
   * discipline as `objectiveVerification`.
   */
  report?: { reporterId: MemberId; body: string };
  /** Why no report exists despite a reporter being designated. */
  reportError?: string;
  members: readonly {
    id: MemberId;
    sessionId: string;
    sessionRef?: string;
    turns: number;
    state: TeamMemberState;
    summary?: string;
    error?: string;
    /** The reason saved by team_block, present only while the member is currently blocked. */
    blockedReason?: string;
  }[];
  publicTranscript: readonly {
    id: MessageId;
    sequence: number;
    from: PrincipalId;
    body: string;
  }[];
  restrictedMessages: readonly {
    id: MessageId;
    sequence: number;
    from: PrincipalId;
    channelKind: "direct" | "group";
    audienceHash: string;
    bodyHash: string;
  }[];
  events: readonly AuditEvent[];
  userInterventions: number;
  auditHead: string;
}
