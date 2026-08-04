export type MemberId = string;
export type MessageId = string;
export type ChannelId = string;
export type PrincipalId = MemberId | "user" | "runtime";

export interface TeamMember {
  id: MemberId;
  name: string;
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
  purpose: "speech" | "message" | "handoff" | "system";
  sentAt: number;
}

/**
 * Control-plane team state supplied on every wake so members never reconstruct
 * it from message history. Claim resources are team-visible by design; groups
 * include only those the waking member belongs to. Polls are open ballots
 * only — once closed, the result is a public message, not live state (same
 * lifecycle as claims: released claims drop out of `claims` too).
 */
export interface TeamDigest {
  states: Readonly<Record<MemberId, TeamMemberState>>;
  claims: Readonly<Record<string, MemberId>>;
  groups: readonly { id: ChannelId; name: string; members: readonly MemberId[] }[];
  polls: readonly {
    pollId: string;
    tally: Readonly<Record<string, number>>;
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
  | { type: "say"; body: string }
  | { type: "send"; to: MemberId; body: string }
  | { type: "create-group"; channelId: ChannelId; name: string; members: readonly MemberId[] }
  | { type: "group-send"; channelId: ChannelId; body: string }
  | { type: "claim"; resource: string }
  | { type: "release"; resource: string }
  | { type: "vote-cast"; pollId: string; choice: string }
  | { type: "vote-close"; pollId: string }
  | { type: "handoff"; to: MemberId; body: string }
  | { type: "finish"; summary: string }
  | { type: "wait" };

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
 * transparency stance as claim resource names. `eligible` excludes only
 * errored members at close time (quorum awareness, not vote validity);
 * `missing` is the eligible members who never cast before close, so a
 * closer can tell an honest tie from a premature close.
 */
export interface PollResult {
  pollId: string;
  tally: Readonly<Record<string, number>>;
  votes: Readonly<Record<MemberId, string>>;
  eligible: readonly MemberId[];
  missing: readonly MemberId[];
  outcome: PollOutcome;
}

export interface TeamAgent {
  readonly member: TeamMember;
  readonly sessionId: string;
  act(turn: TeamTurn, signal: AbortSignal): Promise<readonly TeamCommand[]>;
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
    | "member.claimed"
    | "member.claimRejected"
    | "claim.released"
    | "poll.cast"
    | "poll.closed"
    | "member.finished"
    | "member.errored"
    | "command.failed"
    | "team.completed"
    | "team.quiescent"
    | "team.exhausted";
  memberId?: MemberId;
  messageId?: MessageId;
  data: Readonly<Record<string, unknown>>;
  previousHash: string;
  hash: string;
}

export type TeamMemberState = "idle" | "ready" | "running" | "waiting" | "finished" | "errored";

export interface TeamProgress {
  teamId: string;
  active: readonly MemberId[];
  finished: readonly MemberId[];
  states: Readonly<Record<MemberId, TeamMemberState>>;
  queuedMessages: number;
  turns: number;
  recent: string;
}

export interface TeamActivity {
  sequence: number;
  memberId: PrincipalId;
  kind: "message" | "wake" | "claim" | "vote" | "finish" | "wait" | "channel" | "error";
  text: string;
  visibility: "public" | "restricted";
  channel: ChannelTarget;
  targetIds: readonly MemberId[];
  body?: string;
}

export type TeamSettlement =
  | { kind: "completed"; meaning: "all-members-finished" }
  | { kind: "quiescent"; meaning: "no-runnable-members" }
  | { kind: "quiescent"; meaning: "errored-members-remain" }
  | { kind: "exhausted"; meaning: "max-turns-reached" };

export interface TeamResult {
  teamId: string;
  settlement: TeamSettlement;
  objectiveVerification: "unverified";
  members: readonly {
    id: MemberId;
    sessionId: string;
    turns: number;
    state: TeamMemberState;
    summary?: string;
    error?: string;
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
  userInterventions: 0;
  auditHead: string;
}
