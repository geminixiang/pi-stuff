import { createHash, randomUUID } from "node:crypto";
import type {
  AuditEvent,
  Channel,
  ChannelId,
  ChannelTarget,
  MemberId,
  MessageEnvelope,
  MessageId,
  PollOutcome,
  PollResult,
  PrincipalId,
  TeamActivity,
  TeamAgent,
  TeamCommand,
  TeamDigest,
  TeamMemberState,
  TeamProgress,
  TeamResult,
  WakePolicy,
} from "./domain.js";

export interface TeamRuntimeOptions {
  maxTurns?: number;
  actionTimeoutMs?: number;
  waveConcurrency?: number;
  maxCommandsPerTurn?: number;
  /**
   * Random per-wake delay before a member starts acting, staggering
   * concurrent wave members so a burst of simultaneous contenders doesn't
   * all start (and visually light up) at the exact same instant. Off by
   * default (0ms); a product surface opts in explicitly.
   */
  reactionDelayMs?: { min: number; max: number };
  onProgress?: (progress: TeamProgress) => void;
  onActivity?: (activity: TeamActivity) => void;
}

type InitialPost =
  | { channel: { kind: "public" }; body: string }
  | { channel: { kind: "direct"; memberId: MemberId }; body: string };

export class TeamRuntime {
  readonly teamId = randomUUID();
  private readonly observations = new Map<MemberId, MessageEnvelope[]>();
  private readonly envelopes: MessageEnvelope[] = [];
  private readonly groups = new Map<ChannelId, Extract<Channel, { kind: "group" }>>();
  private readonly events: AuditEvent[] = [];
  private readonly finished = new Map<MemberId, string>();
  private readonly errored = new Map<MemberId, string>();
  private readonly turns = new Map<MemberId, number>();
  private readonly ready = new Set<MemberId>();
  private readonly flushing = new Set<MemberId>();
  /**
   * The envelope id that most recently made each member ready. When an
   * entire wave shares one cause (typically a single broadcast reaching
   * everyone at once), those members are woken sequentially instead of
   * concurrently — each act() call then observes the prior members'
   * already-applied claims/groups/polls in its digest, so N members told
   * the same thing at the same time converge on one coordination structure
   * instead of each independently creating their own and reconciling
   * duplicates afterward. Waves caused by distinct envelopes (directed
   * messages, handoffs) keep running concurrently, unaffected.
   */
  private readonly readyCause = new Map<MemberId, MessageId>();
  private readonly claims = new Map<string, MemberId>();
  private readonly polls = new Map<string, Map<MemberId, string>>();
  private readonly closedPolls = new Map<string, PollResult>();
  private readonly states = new Map<MemberId, TeamMemberState>();
  private activitySequence = 0;
  private auditHead = "0".repeat(64);
  private recent = "Team created";

  constructor(
    readonly objective: string,
    private readonly agents: ReadonlyMap<MemberId, TeamAgent>,
    private readonly options: TeamRuntimeOptions = {},
  ) {
    if (agents.size < 2) throw new Error("A team requires at least two agents");
    for (const [id, agent] of agents) {
      if (id !== agent.member.id) throw new Error(`Agent map identity mismatch: ${id}`);
      this.observations.set(id, []);
      this.turns.set(id, 0);
      this.states.set(id, "idle");
    }
    const sessionIds = [...agents.values()].map((agent) => agent.sessionId);
    if (new Set(sessionIds).size !== sessionIds.length)
      throw new Error("Agent session IDs must be unique");
  }

  async run(
    initial: InitialPost | readonly InitialPost[],
    signal?: AbortSignal,
  ): Promise<TeamResult> {
    try {
      return await this.execute(initial, signal);
    } finally {
      await Promise.allSettled([...this.agents.values()].map((agent) => agent.close?.()));
    }
  }

  progress(): TeamProgress {
    return Object.freeze({
      teamId: this.teamId,
      active: Object.freeze([...this.ready]),
      finished: Object.freeze([...this.finished.keys()]),
      states: Object.freeze(Object.fromEntries(this.states)),
      queuedMessages: [...this.observations.values()].reduce((sum, queue) => sum + queue.length, 0),
      turns: this.totalTurns(),
      recent: this.recent,
    });
  }

  private async execute(
    initial: InitialPost | readonly InitialPost[],
    signal?: AbortSignal,
  ): Promise<TeamResult> {
    this.record("team.started", undefined, undefined, {
      objective: this.objective,
      memberCount: this.agents.size,
    });
    for (const post of Array.isArray(initial) ? initial : [initial])
      this.post("user", post.channel, post.body, "interrupt", "message");

    const maxTurns = this.options.maxTurns ?? Math.max(256, this.agents.size * 32);
    const waveConcurrency = Math.max(1, this.options.waveConcurrency ?? 8);
    let exhausted = false;
    while (!signal?.aborted) {
      if (!this.ready.size && !this.flushStarved()) break;
      if (this.totalTurns() >= maxTurns) {
        exhausted = true;
        break;
      }
      const rankSeed = `${this.teamId}:${this.totalTurns()}`;
      const wave = [...this.ready].sort(
        (left, right) => stableRank(rankSeed, left) - stableRank(rankSeed, right),
      );
      this.ready.clear();
      const cause = this.readyCause.get(wave[0]);
      const sameSource =
        wave.length > 1 && cause !== undefined && wave.every((id) => this.readyCause.get(id) === cause);
      if (sameSource) {
        for (const id of wave) await this.wake(id, signal);
      } else {
        for (let start = 0; start < wave.length; start += waveConcurrency)
          await Promise.all(
            wave.slice(start, start + waveConcurrency).map((id) => this.wake(id, signal)),
          );
      }
      this.options.onProgress?.(this.progress());
    }
    if (signal?.aborted) throw signal.reason;

    const settlement =
      this.finished.size === this.agents.size
        ? ({ kind: "completed", meaning: "all-members-finished" } as const)
        : exhausted
          ? ({ kind: "exhausted", meaning: "max-turns-reached" } as const)
          : this.finished.size + this.errored.size === this.agents.size
            ? // Every non-finished member is terminally errored: this state can
              // never change, unlike a genuine stuck quiescence.
              ({ kind: "quiescent", meaning: "errored-members-remain" } as const)
            : ({ kind: "quiescent", meaning: "no-runnable-members" } as const);
    this.record(
      settlement.kind === "completed"
        ? "team.completed"
        : settlement.kind === "exhausted"
          ? "team.exhausted"
          : "team.quiescent",
      undefined,
      undefined,
      { finished: this.finished.size, errored: this.errored.size },
    );
    return Object.freeze({
      teamId: this.teamId,
      settlement,
      objectiveVerification: "unverified" as const,
      members: Object.freeze(
        [...this.agents.values()].map((agent) =>
          Object.freeze({
            id: agent.member.id,
            sessionId: agent.sessionId,
            turns: this.turns.get(agent.member.id) ?? 0,
            state: this.states.get(agent.member.id) ?? "idle",
            summary: this.finished.get(agent.member.id),
            error: this.errored.get(agent.member.id),
          }),
        ),
      ),
      publicTranscript: Object.freeze(
        this.envelopes
          .filter((envelope) => envelope.channel.kind === "public")
          .map(({ id, sequence, from, body }) => Object.freeze({ id, sequence, from, body })),
      ),
      restrictedMessages: Object.freeze(
        this.envelopes
          .filter(
            (
              envelope,
            ): envelope is MessageEnvelope & { channel: Exclude<Channel, { kind: "public" }> } =>
              envelope.channel.kind !== "public",
          )
          .map((envelope) =>
            Object.freeze({
              id: envelope.id,
              sequence: envelope.sequence,
              from: envelope.from,
              channelKind: envelope.channel.kind,
              audienceHash: sha([...envelope.audience].sort().join("\0")),
              bodyHash: sha(envelope.body),
            }),
          ),
      ),
      events: Object.freeze([...this.events]),
      userInterventions: 0 as const,
      auditHead: this.auditHead,
    });
  }

  /**
   * Before declaring quiescence, wake unfinished members holding undelivered
   * passive observations so no one settles with unread mail. Repeated flush
   * cycles are bounded by maxTurns.
   */
  private flushStarved(): boolean {
    let promoted = false;
    for (const [id, queue] of this.observations) {
      if (!queue.length || !this.runnable(id) || this.flushing.has(id)) continue;
      this.ready.add(id);
      this.flushing.add(id);
      this.states.set(id, "ready");
      // Flush promotion is not a shared broadcast cause; never let a flush
      // wave be mistaken for a same-source wave.
      this.readyCause.delete(id);
      promoted = true;
    }
    return promoted;
  }

  private runnable(memberId: MemberId): boolean {
    return !this.finished.has(memberId) && !this.errored.has(memberId);
  }

  private async reactionDelay(signal?: AbortSignal): Promise<void> {
    const { min, max } = this.options.reactionDelayMs ?? { min: 0, max: 0 };
    const ms = min + Math.random() * Math.max(0, max - min);
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("aborted"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async wake(memberId: MemberId, parentSignal?: AbortSignal): Promise<void> {
    if (!this.runnable(memberId)) return;
    const flush = this.flushing.delete(memberId);
    const observations = this.observations.get(memberId)!.splice(0);
    if (!observations.length) return;
    try {
      await this.reactionDelay(parentSignal);
    } catch (cause) {
      if (parentSignal?.aborted) throw cause;
      this.degrade(memberId, cause);
      return;
    }
    const agent = this.agents.get(memberId)!;
    const turn = (this.turns.get(memberId) ?? 0) + 1;
    this.turns.set(memberId, turn);
    this.states.set(memberId, "running");
    for (const message of observations)
      this.record("message.observed", memberId, message.id, {
        channelId: message.channel.id,
        bodyHash: sha(message.body),
      });
    this.record(flush ? "member.flushWoke" : "member.woke", memberId, undefined, {
      turn,
      observationIds: observations.map((message) => message.id),
      sessionId: agent.sessionId,
    });
    this.activity(
      memberId,
      "wake",
      `turn ${turn} · observed ${observations.length}${flush ? " (final flush)" : ""}`,
      {
        kind: "direct",
        memberId,
      },
      [memberId],
    );
    const controller = new AbortController();
    const relayAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", relayAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error(`Agent ${memberId} timed out`)),
      this.options.actionTimeoutMs ?? 300_000,
    );
    const abortRejection = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason ?? new Error(`Agent ${memberId} aborted`)),
        { once: true },
      );
    });
    abortRejection.catch(() => {});
    try {
      const commands = await Promise.race([
        agent.act(
          {
            teamId: this.teamId,
            objective: this.objective,
            member: agent.member,
            peers: Object.freeze(
              [...this.agents.values()]
                .map((value) => value.member)
                .sort(
                  (left, right) =>
                    stableRank(`${this.teamId}:${memberId}`, left.id) -
                    stableRank(`${this.teamId}:${memberId}`, right.id),
                ),
            ),
            observations: Object.freeze(observations),
            digest: this.digestFor(memberId),
            turn,
          },
          controller.signal,
        ),
        abortRejection,
      ]);
      const claim = commands.find((command) => command.type === "claim");
      if (claim) {
        this.apply(memberId, claim);
        if (commands.length > 1)
          this.activity(
            memberId,
            "wait",
            `claim fence discarded ${commands.length - 1} speculative action${commands.length === 2 ? "" : "s"}`,
            { kind: "direct", memberId },
            [memberId],
          );
      } else {
        const budget = Math.max(1, this.options.maxCommandsPerTurn ?? 16);
        for (const command of commands.slice(0, budget)) this.apply(memberId, command);
        if (commands.length > budget)
          this.post(
            "runtime",
            { kind: "direct", memberId },
            `COMMAND_BUDGET_EXCEEDED applied=${budget} dropped=${commands.length - budget}; resend what still matters next turn`,
            "interrupt",
            "system",
          );
      }
      if (this.runnable(memberId) && !this.ready.has(memberId))
        this.states.set(memberId, "waiting");
    } catch (cause) {
      if (parentSignal?.aborted) throw cause;
      this.degrade(memberId, cause);
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", relayAbort);
    }
  }

  /** A member whose turn failed becomes terminal; the team routes around it. */
  private degrade(memberId: MemberId, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.errored.set(memberId, message);
    this.states.set(memberId, "errored");
    this.ready.delete(memberId);
    this.record("member.errored", memberId, undefined, { error: message });
    this.activity(memberId, "error", message, { kind: "direct", memberId }, [memberId]);
    this.releaseClaims(memberId, "member-errored");
    this.post(
      "runtime",
      { kind: "public" },
      `MEMBER_ERRORED member=${memberId} error=${JSON.stringify(message)}. This member is out; route around it. Messages to it will bounce.`,
      "interrupt",
      "system",
    );
  }

  private apply(from: MemberId, command: TeamCommand): void {
    try {
      this.applyCommand(from, command);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.record("command.failed", from, undefined, { commandType: command.type, error: message });
      this.post(
        "runtime",
        { kind: "direct", memberId: from },
        `COMMAND_FAILED type=${command.type} error=${JSON.stringify(message)}`,
        "interrupt",
        "system",
      );
    }
  }

  private applyCommand(from: MemberId, command: TeamCommand): void {
    if (command.type === "wait") {
      this.activity(from, "wait", "WAIT", { kind: "direct", memberId: from }, [from]);
      return;
    }
    if (command.type === "finish") {
      this.finished.set(from, command.summary);
      this.states.set(from, "finished");
      this.record("member.finished", from, undefined, { summaryHash: sha(command.summary) });
      this.activity(from, "finish", command.summary, { kind: "direct", memberId: from }, [from]);
      this.releaseClaims(from, "member-finished");
      return;
    }
    if (command.type === "claim") {
      this.claim(from, command.resource);
      return;
    }
    if (command.type === "release") {
      const owner = this.claims.get(command.resource);
      if (owner !== from)
        throw new Error(
          `cannot release ${command.resource}: ${owner ? `owned by ${owner}` : "not currently claimed"}`,
        );
      this.releaseClaim(command.resource, from, "released-by-owner");
      return;
    }
    if (command.type === "create-group") {
      this.createGroup(from, command.channelId, command.name, command.members);
      return;
    }
    if (command.type === "vote-cast") {
      this.castVote(from, command.pollId, command.choice);
      return;
    }
    if (command.type === "vote-close") {
      this.closePoll(from, command.pollId);
      return;
    }
    if (command.type === "say") {
      this.post(from, { kind: "public" }, command.body, "passive", "speech");
      return;
    }
    if (command.type === "broadcast") {
      // The only member-originated public interrupt: for the rare case
      // where every member must respond to the same thing right now. Wakes
      // everyone in one wave sharing one envelope, so the same-source
      // sequencing above applies to whatever they do next.
      this.post(from, { kind: "public" }, command.body, "interrupt", "speech");
      return;
    }
    if (command.type === "group-send") {
      this.post(
        from,
        { kind: "group", channelId: command.channelId },
        command.body,
        "interrupt",
        "message",
      );
      return;
    }
    const to = this.resolveMemberId(command.to);
    this.assertDeliverable(to);
    this.post(
      from,
      { kind: "direct", memberId: to },
      command.body,
      "interrupt",
      command.type === "handoff" ? "handoff" : "message",
    );
  }

  /**
   * Members are told each other's opaque id, but also see display names in
   * PEERS and every transcript — mixing the two up is a natural mistake,
   * not a rule violation, so it's resolved rather than just bounced. An id
   * always wins outright; a name resolves only when it unambiguously names
   * exactly one member. Two members sharing a display name is never
   * silently guessed at — that would risk delivering to the wrong person,
   * strictly worse than a bounce.
   */
  private resolveMemberId(candidate: string): MemberId {
    if (this.agents.has(candidate)) return candidate;
    const matches = [...this.agents.values()].filter((agent) => agent.member.name === candidate);
    if (matches.length === 1) return matches[0].member.id;
    if (matches.length > 1)
      throw new Error(
        `ambiguous recipient "${candidate}": multiple members share that name; use one of their ids instead (${matches.map((agent) => agent.member.id).join(", ")})`,
      );
    throw new Error(`unknown recipient "${candidate}"`);
  }

  private assertDeliverable(to: MemberId): void {
    if (this.finished.has(to)) throw new Error(`recipient ${to} has finished and cannot be woken`);
    if (this.errored.has(to)) throw new Error(`recipient ${to} errored and cannot be woken`);
  }

  private claim(from: MemberId, resource: string): void {
    const owner = this.claims.get(resource);
    if (!owner) {
      this.claims.set(resource, from);
      this.record("member.claimed", from, undefined, { resource });
      this.activity(from, "claim", `claimed ${resource}`, { kind: "direct", memberId: from }, [
        from,
      ]);
      this.post(
        "runtime",
        { kind: "direct", memberId: from },
        `CLAIM_ACQUIRED resource=${JSON.stringify(resource)} owner=${from}`,
        "interrupt",
        "system",
      );
      return;
    }
    if (owner !== from) {
      this.record("member.claimRejected", from, undefined, { resource, owner });
      this.activity(
        from,
        "claim",
        `${resource} already claimed by ${owner}`,
        { kind: "direct", memberId: from },
        [from],
      );
    }
    this.post(
      "runtime",
      { kind: "direct", memberId: from },
      `${owner === from ? "CLAIM_ACQUIRED" : "CLAIM_REJECTED"} resource=${JSON.stringify(resource)} owner=${owner}`,
      "interrupt",
      "system",
    );
  }

  private releaseClaims(owner: MemberId, reason: string): void {
    for (const [resource, holder] of this.claims)
      if (holder === owner) this.releaseClaim(resource, owner, reason);
  }

  private releaseClaim(resource: string, owner: MemberId, reason: string): void {
    this.claims.delete(resource);
    this.record("claim.released", owner, undefined, { resource, reason });
    this.activity(owner, "claim", `released ${resource}`, { kind: "direct", memberId: owner }, [
      owner,
    ]);
    this.post(
      "runtime",
      { kind: "public" },
      `CLAIM_RELEASED resource=${JSON.stringify(resource)} former=${owner} reason=${reason}`,
      "passive",
      "system",
    );
  }

  private castVote(from: MemberId, pollId: string, choice: string): void {
    if (this.closedPolls.has(pollId)) throw new Error(`poll already closed: ${pollId}`);
    const isNewPoll = !this.polls.has(pollId);
    // A claim on the pollId reserves the id itself against duplicate polls
    // for the same purpose — it does not require the claim holder
    // specifically to cast the first vote. Once anyone holds the claim,
    // any member may cast, including the very first vote; only a truly
    // unclaimed pollId is blocked, since that's the only case a caller
    // could otherwise spin up a brand-new poll unreserved.
    if (isNewPoll && !this.claims.has(pollId))
      throw new Error(`must claim ${pollId} before opening a new poll with that id`);
    let votes = this.polls.get(pollId);
    if (!votes) {
      votes = new Map();
      this.polls.set(pollId, votes);
    }
    votes.set(from, choice);
    this.record("poll.cast", from, undefined, { pollId, choice });
    this.activity(from, "vote", `voted on ${pollId}`, { kind: "direct", memberId: from }, [from]);
  }

  /**
   * Anyone may close a poll — there is no fixed tally-owner, only a fixed
   * outcome, computed once by the runtime rather than self-reported by a
   * member. Ties are reported honestly, never broken automatically
   * (invariant 12: settlement never asserts correctness; a poll outcome
   * follows the same discipline).
   */
  private closePoll(from: MemberId, pollId: string): void {
    const existing = this.closedPolls.get(pollId);
    if (existing)
      throw new Error(`poll already closed: ${pollId} — ${describePollOutcome(existing.outcome)}`);
    const votes = this.polls.get(pollId) ?? new Map<MemberId, string>();
    const result = this.tallyPoll(pollId, votes);
    this.closedPolls.set(pollId, result);
    this.polls.delete(pollId);
    this.record("poll.closed", from, undefined, {
      pollId,
      tally: result.tally,
      missing: result.missing,
      outcome: result.outcome,
    });
    this.activity(
      from,
      "vote",
      `closed ${pollId}: ${describePollOutcome(result.outcome)}`,
      { kind: "public" },
      [...this.agents.keys()],
    );
    this.post(
      "runtime",
      { kind: "public" },
      `POLL_CLOSED pollId=${JSON.stringify(pollId)} tally=${JSON.stringify(result.tally)} missing=${JSON.stringify(result.missing)} outcome=${JSON.stringify(result.outcome)}`,
      "interrupt",
      "system",
    );
  }

  private tallyPoll(pollId: string, votes: ReadonlyMap<MemberId, string>): PollResult {
    const tally: Record<string, number> = {};
    for (const choice of votes.values()) tally[choice] = (tally[choice] ?? 0) + 1;
    const castIds = new Set(votes.keys());
    const eligible = [...this.agents.keys()].filter((id) => castIds.has(id) || this.runnable(id));
    const missing = eligible.filter((id) => !castIds.has(id));
    const entries = Object.entries(tally);
    const outcome: PollOutcome = !entries.length
      ? { kind: "no-votes" }
      : (() => {
          const max = Math.max(...entries.map(([, count]) => count));
          const winners = entries.filter(([, count]) => count === max).map(([choice]) => choice);
          return winners.length === 1
            ? { kind: "winner", choice: winners[0] }
            : { kind: "tie", choices: Object.freeze(winners) };
        })();
    return Object.freeze({
      pollId,
      tally: Object.freeze(tally),
      votes: Object.freeze(Object.fromEntries(votes)),
      eligible: Object.freeze(eligible),
      missing: Object.freeze(missing),
      outcome,
    });
  }

  private createGroup(
    creator: MemberId,
    channelId: ChannelId,
    name: string,
    requestedMembers: readonly MemberId[],
  ): void {
    if (this.groups.has(channelId)) throw new Error(`Group already exists: ${channelId}`);
    if (this.claims.get(channelId) !== creator)
      throw new Error(`must claim ${channelId} before creating a group with that id`);
    const resolvedMembers = requestedMembers.map((candidate) => this.resolveMemberId(candidate));
    const members = Object.freeze([...new Set([creator, ...resolvedMembers])]);
    const group = Object.freeze({ kind: "group" as const, id: channelId, name, members });
    this.groups.set(channelId, group);
    this.record("channel.created", creator, undefined, {
      channelId,
      audienceHash: sha([...members].sort().join("\0")),
    });
    this.activity(
      creator,
      "channel",
      `created group ${name}`,
      { kind: "group", channelId },
      members,
    );
  }

  private post(
    from: PrincipalId,
    target: ChannelTarget,
    body: string,
    wake: WakePolicy,
    purpose: MessageEnvelope["purpose"],
  ): void {
    const { channel, audience } = this.resolveChannel(from, target);
    const envelope: MessageEnvelope = Object.freeze({
      id: randomUUID(),
      sequence: this.envelopes.length + 1,
      from,
      channel,
      audience: Object.freeze(audience),
      body,
      wake,
      purpose,
      sentAt: Date.now(),
    });
    this.envelopes.push(envelope);
    const restricted = channel.kind !== "public";
    this.record(
      "message.posted",
      from === "user" || from === "runtime" ? undefined : from,
      envelope.id,
      {
        channelKind: channel.kind,
        channelId: channel.id,
        purpose,
        wake,
        audienceHash: sha([...audience].sort().join("\0")),
        bodyHash: sha(body),
      },
    );
    this.activity(from, "message", body, target, audience, body, restricted);
    for (const recipient of audience) {
      if (recipient === from || !this.runnable(recipient)) continue;
      this.observations.get(recipient)!.push(envelope);
      this.record("message.enqueued", recipient, envelope.id, {
        channelId: channel.id,
        bodyHash: sha(body),
      });
      if (wake === "interrupt") {
        this.ready.add(recipient);
        this.states.set(recipient, "ready");
        this.readyCause.set(recipient, envelope.id);
      }
    }
    this.recent = `${from} → ${channel.id}`;
  }

  private digestFor(memberId: MemberId): TeamDigest {
    return Object.freeze({
      states: Object.freeze(Object.fromEntries(this.states)),
      claims: Object.freeze(Object.fromEntries(this.claims)),
      groups: Object.freeze(
        [...this.groups.values()]
          .filter((group) => group.members.includes(memberId))
          .map((group) => Object.freeze({ id: group.id, name: group.name, members: group.members })),
      ),
      polls: Object.freeze(
        [...this.polls.entries()].map(([pollId, votes]) => {
          const result = this.tallyPoll(pollId, votes);
          return Object.freeze({ pollId, tally: result.tally, missing: result.missing });
        }),
      ),
    });
  }

  private resolveChannel(
    from: PrincipalId,
    target: ChannelTarget,
  ): { channel: Channel; audience: MemberId[] } {
    if (target.kind === "public")
      return {
        channel: Object.freeze({ kind: "public", id: "public" }),
        audience: [...this.agents.keys()],
      };
    if (target.kind === "direct") {
      if (!this.agents.has(target.memberId))
        throw new Error(`Unknown recipient: ${target.memberId}`);
      return {
        channel: Object.freeze({
          kind: "direct",
          id: directChannelId(from, target.memberId),
          members: Object.freeze([from, target.memberId] as const),
        }),
        audience: [target.memberId],
      };
    }
    const group = this.groups.get(target.channelId);
    if (!group) throw new Error(`Unknown group: ${target.channelId}`);
    if (from !== "runtime" && from !== "user" && !group.members.includes(from))
      throw new Error(`Member ${from} cannot post to group ${target.channelId}`);
    return { channel: group, audience: [...group.members] };
  }

  private record(
    type: AuditEvent["type"],
    memberId?: MemberId,
    messageId?: MessageId,
    data: Record<string, unknown> = {},
  ): void {
    const sequence = this.events.length + 1;
    const payload = JSON.stringify({
      sequence,
      type,
      memberId,
      messageId,
      data,
      previousHash: this.auditHead,
    });
    const hash = sha(payload);
    this.events.push(
      Object.freeze({
        sequence,
        type,
        memberId,
        messageId,
        data: Object.freeze(data),
        previousHash: this.auditHead,
        hash,
      }),
    );
    this.auditHead = hash;
  }

  private activity(
    memberId: PrincipalId,
    kind: TeamActivity["kind"],
    text: string,
    channel: ChannelTarget,
    targetIds: readonly MemberId[],
    body?: string,
    restricted = channel.kind !== "public",
  ): void {
    this.options.onActivity?.(
      Object.freeze({
        sequence: ++this.activitySequence,
        memberId,
        kind,
        text,
        visibility: restricted ? "restricted" : "public",
        channel,
        targetIds: Object.freeze([...targetIds]),
        body,
      }),
    );
  }

  private totalTurns(): number {
    return [...this.turns.values()].reduce((sum, count) => sum + count, 0);
  }
}

function describePollOutcome(outcome: PollOutcome): string {
  if (outcome.kind === "winner") return `winner=${outcome.choice}`;
  if (outcome.kind === "tie") return `tie=${outcome.choices.join(",")}`;
  return "no votes";
}

function directChannelId(from: PrincipalId, to: MemberId): string {
  return `direct:${[from, to].sort().join(":")}`;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableRank(teamId: string, memberId: string): number {
  return Number.parseInt(sha(`${teamId}:${memberId}`).slice(0, 12), 16);
}

export function verifyAudit(events: readonly AuditEvent[]): boolean {
  let previousHash = "0".repeat(64);
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.sequence !== index + 1 || event.previousHash !== previousHash) return false;
    const payload = JSON.stringify({
      sequence: event.sequence,
      type: event.type,
      memberId: event.memberId,
      messageId: event.messageId,
      data: event.data,
      previousHash: event.previousHash,
    });
    if (sha(payload) !== event.hash) return false;
    previousHash = event.hash;
  }
  return true;
}
