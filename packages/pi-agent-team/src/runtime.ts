import { createHash, randomUUID } from "node:crypto";
import {
  assertValidMemberId,
  type AuditEvent,
  type Channel,
  type ChannelId,
  type ChannelTarget,
  type MemberId,
  type MessageEnvelope,
  type MessageId,
  type PollOutcome,
  type PollResult,
  type PrincipalId,
  type TeamActivity,
  type TeamAgent,
  type TeamCommand,
  type TeamDigest,
  type TeamMemberState,
  type TeamProgress,
  type TeamResult,
  type WakePolicy,
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
  private readonly fullyCastPolls = new Set<string>();
  private readonly states = new Map<MemberId, TeamMemberState>();
  /**
   * The members made ready together by a *single* initial post — the common
   * "objective sent to everyone" case. Same-source sequencing (see
   * `readyCause` above) makes that opening wave converge on shared
   * coordination structures, but sequential wake-up also means an earlier
   * member's passive public speech would otherwise land in a later member's
   * mailbox before that later member has taken even its own first turn,
   * anchoring their first take on a peer's conclusion instead of the raw
   * objective. `openingWaveDrafted`/`heldBackForReveal` below implement a
   * barrier for exactly this round: null once every member here has drafted
   * (or become terminal) and the held-back speech has been revealed.
   */
  private openingWaveMembers: Set<MemberId> | null = null;
  private readonly openingWaveDrafted = new Set<MemberId>();
  private readonly heldBackForReveal = new Map<MemberId, MessageEnvelope[]>();
  private activitySequence = 0;
  private auditHead = "0".repeat(64);
  private recent = "Team created";
  private started = false;

  constructor(
    readonly objective: string,
    private readonly agents: ReadonlyMap<MemberId, TeamAgent>,
    private readonly options: TeamRuntimeOptions = {},
  ) {
    if (agents.size < 2) throw new Error("A team requires at least two agents");
    for (const [id, agent] of agents) {
      if (id !== agent.member.id) throw new Error(`Agent map identity mismatch: ${id}`);
      assertValidMemberId(id);
      this.observations.set(id, []);
      this.turns.set(id, 0);
      this.states.set(id, "idle");
    }
    const sessionIds = [...agents.values()].map((agent) => agent.sessionId);
    if (new Set(sessionIds).size !== sessionIds.length)
      throw new Error("Agent session IDs must be unique");
  }

  /**
   * A TeamRuntime instance runs exactly once. Its state (finished, errored,
   * claims, polls, envelopes, events) accumulates across the single run and
   * its agents are closed in the finally block below; calling run() again
   * would resume scheduling over already-terminal members and already-
   * disposed agent sessions, silently producing a second, semantically
   * broken team.started/settlement pair in the same audit chain. Construct
   * a new TeamRuntime for another run instead.
   */
  async run(
    initial: InitialPost | readonly InitialPost[],
    signal?: AbortSignal,
  ): Promise<TeamResult> {
    if (this.started)
      throw new Error(
        "TeamRuntime.run() may only be called once per instance; construct a new TeamRuntime for another run",
      );
    this.started = true;
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
    // A single initial post (not an array of distinct per-member envelopes)
    // is exactly the case same-source sequencing applies to; only then does
    // the first-turn barrier below have anything to protect against.
    if (!Array.isArray(initial)) this.openingWaveMembers = new Set(this.ready);

    const maxTurns = this.options.maxTurns ?? Math.max(256, this.agents.size * 32);
    const waveConcurrency = Math.max(1, this.options.waveConcurrency ?? 8);
    let exhausted = false;
    while (!signal?.aborted) {
      if (!this.ready.size && !this.promoteStarvedMembers()) break;
      const remaining = maxTurns - this.totalTurns();
      if (remaining <= 0) {
        exhausted = true;
        break;
      }
      const rankSeed = `${this.teamId}:${this.totalTurns()}`;
      const fullWave = [...this.ready].sort(
        (left, right) => stableRank(rankSeed, left) - stableRank(rankSeed, right),
      );
      // Cap the wave to the remaining budget so a wave of N ready members
      // can never consume more than N turns beyond maxTurns — previously
      // this was only checked *before* building a wave, so a wave larger
      // than the remaining budget (whether run sequentially as same-source,
      // or concurrently in one waveConcurrency chunk) still ran to
      // completion, letting totalTurns overshoot maxTurns before the next
      // check ever saw it. Anyone cut here stays in `ready` for the next
      // iteration — or, if the budget is now spent, is correctly reported
      // as still-ready in the exhausted settlement rather than silently run.
      const wave = fullWave.slice(0, remaining);
      const deferredByBudget = fullWave.slice(remaining);
      this.ready.clear();
      for (const id of deferredByBudget) this.ready.add(id);
      const waveCause = this.readyCause.get(wave[0]);
      const sameSource =
        wave.length > 1 &&
        waveCause !== undefined &&
        wave.every((id) => this.readyCause.get(id) === waveCause);
      if (sameSource) {
        for (const id of wave) await this.wake(id, signal);
      } else {
        for (let start = 0; start < wave.length; start += waveConcurrency)
          await Promise.all(
            wave.slice(start, start + waveConcurrency).map((id) => this.wake(id, signal)),
          );
      }
      // Once every opening-wave member has independently drafted a first
      // take (or become terminal without ever getting the chance), reveal
      // whatever peer speech was held back from each of them — the barrier
      // only needs to last for exactly this one round.
      if (
        this.openingWaveMembers &&
        [...this.openingWaveMembers].every(
          (id) => this.openingWaveDrafted.has(id) || !this.runnable(id),
        )
      ) {
        this.revealOpeningWaveDrafts();
        this.openingWaveMembers = null;
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
              audienceHash: sha256([...envelope.audience].sort().join("\0")),
              bodyHash: sha256(envelope.body),
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
  private promoteStarvedMembers(): boolean {
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

  private heldBackQueue(memberId: MemberId): MessageEnvelope[] {
    let queue = this.heldBackForReveal.get(memberId);
    if (!queue) {
      queue = [];
      this.heldBackForReveal.set(memberId, queue);
    }
    return queue;
  }

  /**
   * Delivers everything held back during the opening wave and wakes every
   * recipient that has any — a same-source reveal of the round's exchanged
   * first takes, all at once, rather than a silent trickle-in whenever some
   * unrelated later event happens to wake each recipient. A member with
   * nothing held back (typically whoever drafted first, before any peer had
   * spoken) is left alone; it has nothing new to reveal.
   */
  private revealOpeningWaveDrafts(): void {
    for (const [memberId, envelopes] of this.heldBackForReveal) {
      if (!envelopes.length || !this.runnable(memberId)) continue;
      this.observations.get(memberId)!.push(...envelopes);
      this.ready.add(memberId);
      this.states.set(memberId, "ready");
      this.readyCause.set(memberId, OPENING_WAVE_REVEAL_CAUSE);
    }
    this.heldBackForReveal.clear();
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
    // Marks this member's opening-wave barrier as lifted the instant its own
    // first wake begins — unconditionally, so a member is never left
    // permanently undrafted (and so permanently hoarding held-back mail)
    // even on a call that turns out to have nothing to observe below.
    if (this.openingWaveMembers?.has(memberId)) this.openingWaveDrafted.add(memberId);
    if (!this.runnable(memberId)) return;
    const flush = this.flushing.delete(memberId);
    const observations = this.observations.get(memberId)!.splice(0);
    if (!observations.length) return;
    try {
      await this.reactionDelay(parentSignal);
    } catch (cause) {
      if (parentSignal?.aborted) throw cause;
      this.markErrored(memberId, cause);
      return;
    }
    const agent = this.agents.get(memberId)!;
    const turn = (this.turns.get(memberId) ?? 0) + 1;
    this.turns.set(memberId, turn);
    this.states.set(memberId, "running");
    for (const message of observations)
      this.record("message.observed", memberId, message.id, {
        channelId: message.channel.id,
        bodyHash: sha256(message.body),
      });
    this.record(flush ? "member.flushWoke" : "member.woke", memberId, undefined, {
      turn,
      observationIds: observations.map((message) => message.id),
      sessionId: agent.sessionId,
    });
    this.emitActivity(
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
                .filter((member) => member.id !== memberId)
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
        this.applyCommand(memberId, claim);
        if (commands.length > 1)
          this.emitActivity(
            memberId,
            "wait",
            `claim fence discarded ${commands.length - 1} speculative action${commands.length === 2 ? "" : "s"}`,
            { kind: "direct", memberId },
            [memberId],
          );
      } else {
        // Invariant 16 (turn-ending protocol): once wait/finish appears in
        // the batch, nothing after it applies. PiTeamAgent's TurnState
        // already enforces this on the way in, so a well-behaved adapter's
        // array is already correctly truncated here — but TeamAgent is a
        // public interface, and this is the one place the invariant holds
        // for *any* implementation, not only PiTeamAgent's.
        const terminalIndex = commands.findIndex(
          (command) => command.type === "wait" || command.type === "finish",
        );
        const effective = terminalIndex === -1 ? commands : commands.slice(0, terminalIndex + 1);
        const budget = Math.max(1, this.options.maxCommandsPerTurn ?? 16);
        for (const command of effective.slice(0, budget)) this.applyCommand(memberId, command);
        if (effective.length > budget)
          this.post(
            "runtime",
            { kind: "direct", memberId },
            `COMMAND_BUDGET_EXCEEDED applied=${budget} dropped=${effective.length - budget}; resend what still matters next turn`,
            "interrupt",
            "system",
          );
        const discardedAfterTurnEnd = commands.length - effective.length;
        if (discardedAfterTurnEnd > 0)
          this.emitActivity(
            memberId,
            "wait",
            `turn already ended by wait/finish; discarded ${discardedAfterTurnEnd} action${discardedAfterTurnEnd === 1 ? "" : "s"} queued after it`,
            { kind: "direct", memberId },
            [memberId],
          );
      }
      if (this.runnable(memberId) && !this.ready.has(memberId))
        this.states.set(memberId, "waiting");
    } catch (cause) {
      if (parentSignal?.aborted) throw cause;
      this.markErrored(memberId, cause);
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", relayAbort);
    }
  }

  /** A member whose turn failed becomes terminal; the team routes around it. */
  private markErrored(memberId: MemberId, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.errored.set(memberId, message);
    this.states.set(memberId, "errored");
    this.ready.delete(memberId);
    this.record("member.errored", memberId, undefined, { error: message });
    this.emitActivity(memberId, "error", message, { kind: "direct", memberId }, [memberId]);
    this.releaseClaims(memberId, "member-errored");
    this.recheckOpenPollsAfterTerminalTransition();
    this.post(
      "runtime",
      { kind: "public" },
      `MEMBER_ERRORED member=${memberId} error=${JSON.stringify(message)}. This member is out; route around it. Messages to it will bounce.`,
      "interrupt",
      "system",
    );
  }

  private applyCommand(from: MemberId, command: TeamCommand): void {
    try {
      this.executeCommand(from, command);
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

  private executeCommand(from: MemberId, command: TeamCommand): void {
    if (command.type === "wait") {
      this.emitActivity(from, "wait", "WAIT", { kind: "direct", memberId: from }, [from]);
      return;
    }
    if (command.type === "finish") {
      this.finished.set(from, command.summary);
      this.states.set(from, "finished");
      this.record("member.finished", from, undefined, { summaryHash: sha256(command.summary) });
      this.emitActivity(from, "finish", command.summary, { kind: "direct", memberId: from }, [from]);
      this.releaseClaims(from, "member-finished");
      this.recheckOpenPollsAfterTerminalTransition();
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
    if (to === from) throw new Error(`cannot ${command.type} to yourself`);
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
      this.emitActivity(from, "claim", `claimed ${resource}`, { kind: "direct", memberId: from }, [
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
      this.emitActivity(
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
    this.emitActivity(owner, "claim", `released ${resource}`, { kind: "direct", memberId: owner }, [
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
    this.emitActivity(from, "vote", `voted on ${pollId}`, { kind: "direct", memberId: from }, [from]);
    this.maybeAnnounceFullyCast(pollId, votes);
  }

  /**
   * Casting a vote is otherwise silent — unlike a claim or a group, it posts
   * nothing observable. Without this, every eligible voter can cast and then
   * WAIT, and nothing ever wakes anyone to notice the poll is ready to
   * close: a live run showed exactly this, four members voting and then the
   * whole team going quiescent with no poll ever closed. This notice states
   * only the objective fact that every eligible member has now cast — never
   * that anyone should close it — so the runtime stays rule-agnostic about
   * when a poll's tally is meant to be final.
   *
   * `eligible`/`missing` are computed from `runnable()`, which changes on
   * every finish or error — not only on a cast. A poll can therefore become
   * fully cast without anyone casting: the last outstanding voter simply
   * finishes or errors instead. Every terminal transition re-runs this check
   * for every still-open poll (see `executeCommand`'s finish branch and
   * `markErrored`), not just `castVote`, or a voter who cast early could
   * wait forever on a notice that never fires.
   */
  private maybeAnnounceFullyCast(pollId: string, votes: ReadonlyMap<MemberId, string>): void {
    if (this.fullyCastPolls.has(pollId) || votes.size === 0) return;
    const result = this.tallyPoll(pollId, votes);
    if (result.missing.length !== 0) return;
    this.fullyCastPolls.add(pollId);
    this.post(
      "runtime",
      { kind: "public" },
      `POLL_FULLY_CAST pollId=${JSON.stringify(pollId)} voters=${JSON.stringify(result.eligible)}`,
      "interrupt",
      "system",
    );
  }

  /**
   * Re-evaluates every currently open poll's fully-cast status after a
   * terminal transition (finish or error), since `runnable()` — and
   * therefore `eligible`/`missing` — just changed for every poll, not only
   * the one (if any) the transitioning member was part of.
   */
  private recheckOpenPollsAfterTerminalTransition(): void {
    for (const [pollId, votes] of this.polls) this.maybeAnnounceFullyCast(pollId, votes);
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
    this.emitActivity(
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
      audienceHash: sha256([...members].sort().join("\0")),
    });
    this.emitActivity(
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
    this.record(
      "message.posted",
      from === "user" || from === "runtime" ? undefined : from,
      envelope.id,
      {
        channelKind: channel.kind,
        channelId: channel.id,
        purpose,
        wake,
        audienceHash: sha256([...audience].sort().join("\0")),
        bodyHash: sha256(body),
      },
    );
    this.emitActivity(from, "message", body, target, audience, body);
    for (const recipient of audience) {
      if (recipient === from || !this.runnable(recipient)) continue;
      // First-turn barrier: public passive speech (team_say) posted while
      // this recipient is still an undrafted opening-wave member is held
      // back from its regular mailbox and revealed only once every opening-
      // wave member has drafted (see revealOpeningWaveDrafts). Direct,
      // handoff, and broadcast messages are never held back — those are
      // the sender explicitly choosing to reach this recipient right now,
      // not a passive conclusion that could anchor an undrafted first take.
      const holdBackForReveal =
        wake === "passive" &&
        channel.kind === "public" &&
        this.openingWaveMembers?.has(recipient) === true &&
        !this.openingWaveDrafted.has(recipient);
      (holdBackForReveal ? this.heldBackQueue(recipient) : this.observations.get(recipient)!).push(
        envelope,
      );
      this.record("message.enqueued", recipient, envelope.id, {
        channelId: channel.id,
        bodyHash: sha256(body),
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
    const hash = sha256(payload);
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

  private emitActivity(
    memberId: PrincipalId,
    kind: TeamActivity["kind"],
    text: string,
    channel: ChannelTarget,
    targetIds: readonly MemberId[],
    body?: string,
  ): void {
    this.options.onActivity?.(
      Object.freeze({
        sequence: ++this.activitySequence,
        memberId,
        kind,
        text,
        visibility: channel.kind !== "public" ? "restricted" : "public",
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

/**
 * A synthetic readyCause shared by every member revealed together at the end
 * of the opening wave, so the scheduler's same-source check recognizes them
 * as one wave and wakes them sequentially — the reveal is a genuinely shared
 * cause (the round of first-turn speech as a whole), same as any other
 * same-source wave.
 */
const OPENING_WAVE_REVEAL_CAUSE: MessageId = "reveal:opening-wave";

function describePollOutcome(outcome: PollOutcome): string {
  if (outcome.kind === "winner") return `winner=${outcome.choice}`;
  if (outcome.kind === "tie") return `tie=${outcome.choices.join(",")}`;
  return "no votes";
}

function directChannelId(from: PrincipalId, to: MemberId): string {
  return `direct:${[from, to].sort().join(":")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableRank(seed: string, memberId: string): number {
  return Number.parseInt(sha256(`${seed}:${memberId}`).slice(0, 12), 16);
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
    if (sha256(payload) !== event.hash) return false;
    previousHash = event.hash;
  }
  return true;
}
