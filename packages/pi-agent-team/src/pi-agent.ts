import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MessageEnvelope, TeamAgent, TeamCommand, TeamMember, TeamTurn } from "./domain.js";
import { TurnState } from "./turn-state.js";

const TEAM_OPERATOR_SKILL = "pi-agent-team";

export function excludeTeamOperatorSkill<T extends { name: string }>(skills: readonly T[]): T[] {
  return skills.filter((skill) => skill.name !== TEAM_OPERATOR_SKILL);
}

interface SessionLike {
  readonly sessionId: string;
  readonly sessionFile?: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void> | void;
  setSessionName?(name: string): void;
  getLastAssistantText?(): string | undefined;
}

export class PiTeamAgent implements TeamAgent {
  private session?: SessionLike;
  private readonly turnState = new TurnState();
  private readonly provisionalSessionId = crypto.randomUUID();
  /**
   * True only during the post-settlement report turn. Team tools stay
   * registered on the session, but coordination is over — queueCommand
   * answers them with a settled notice instead of queueing (or aborting
   * the prompt), so a reporter reflexively calling team_say cannot reopen
   * the settled runtime or cut its own report short.
   */
  private reporting = false;

  constructor(
    readonly member: TeamMember,
    private readonly cwd: string,
    private readonly context: ExtensionContext,
  ) {}

  get sessionId(): string {
    return this.session?.sessionId ?? this.provisionalSessionId;
  }

  get sessionRef(): string | undefined {
    return this.session?.sessionFile;
  }

  async act(turn: TeamTurn, signal: AbortSignal): Promise<readonly TeamCommand[]> {
    const session = await this.getSession();
    this.turnState.reset();
    if (signal.aborted) throw signal.reason;
    const onAbort = () => void session.abort().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(formatTurn(turn));
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      // A turn-ending team action (wait/block/finish/claim) self-aborts the prompt
      // to stop further tool-call rounds; the queued commands still stand.
      // That self-abort is the only failure this turn expects, and TurnState
      // records it as endedTurn. Any other failure — a provider dying after
      // a say was queued, say — must surface as this member's error rather
      // than silently committing the half batch it left behind.
      if (!this.turnState.endedTurn) throw cause;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw signal.reason;
    if (this.turnState.queued.length) return Object.freeze([...this.turnState.queued]);
    // A turn that ends with no team tool call is leniently treated as waiting.
    return Object.freeze([{ type: "wait" as const }]);
  }

  async close(): Promise<void> {
    await this.session?.dispose();
  }

  async report(prompt: string, signal: AbortSignal): Promise<string> {
    const session = await this.getSession();
    if (signal.aborted) throw signal.reason;
    this.reporting = true;
    const onAbort = () => void session.abort().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(prompt);
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.reporting = false;
    }
    if (signal.aborted) throw signal.reason;
    const body = session.getLastAssistantText?.();
    if (!body?.trim()) throw new Error("reporter produced no final response");
    return body;
  }

  private async getSession(): Promise<SessionLike> {
    if (this.session) return this.session;
    if (!this.context.model) throw new Error("Parent session has no model");
    const modelRuntime = (
      this.context.modelRegistry as unknown as {
        runtime?: NonNullable<Parameters<typeof createAgentSession>[0]>["modelRuntime"];
      }
    ).runtime;
    if (!modelRuntime) throw new Error("Parent ModelRuntime is unavailable");
    const loader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      // Members get full pi capability; only extensions stay off so a member
      // cannot recursively start teams via team_start.
      noExtensions: true,
      noThemes: true,
      // The bundled pi-agent-team skill teaches the parent how to operate
      // team_start and retained runs. Members do not have team_start; keep
      // every other useful skill while withholding only that operator skill.
      skillsOverride: (base) => ({
        skills: excludeTeamOperatorSkill(base.skills),
        diagnostics: base.diagnostics,
      }),
      systemPrompt: [
        `You are ${this.member.name} (${this.member.id}), one symmetric worker in an independent agent team. Use your normal tools for real work and team tools for coordination.`,
        "Act only from posted messages and live state actually shown. Publish optimistically; if the runtime holds a stale batch, reread the new observations and recompute.",
        "Contribute what the objective still needs. If someone is absent or stuck, cover the gap rather than waiting for an imagined turn order.",
        "Keep your own judgment. Do not change a conclusion merely to agree with a teammate, and do not repeat work or speech that adds nothing.",
        "Communicate the minimum useful state. Prefer public speech; restrict only genuinely private content. Use claims for exclusive shared work, never for conversational turns.",
        'Tool results are provisional until the runtime commits the complete returned batch. The special claim "reporter" assigns its holder the final post-settlement report turn.',
      ].join("\n\n"),
    });
    await loader.reload();
    const parentSession = this.context.sessionManager?.getSessionFile?.() || undefined;
    const customTools: ToolDefinition[] = [
      {
        name: "team_say",
        label: "Speak publicly",
        description:
          "Post public speech to the team chat. List teammates in `to` to mention them: the message stays visible to everyone and each mentioned teammate is woken to reply — the normal way to hold a conversation. Without mentions, no one wakes.",
        parameters: Type.Object(
          {
            body: Type.String(),
            to: Type.Optional(
              Type.Array(
                Type.String({
                  description:
                    "A teammate to mention and wake — member id (see PEERS), or an unambiguous display name.",
                }),
              ),
            ),
          },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { body: string; to?: string[] }) =>
          this.queueCommand(
            params.to?.length
              ? { type: "say", body: params.body, to: params.to }
              : { type: "say", body: params.body },
            params.to?.length
              ? `spoken publicly, waking ${params.to.join(", ")}`
              : "spoken publicly",
          ),
      },
      {
        name: "team_broadcast",
        label: "Broadcast publicly",
        description:
          "Post public speech that wakes every teammate at once, unlike team_say. Use only when everyone genuinely needs to respond to this right now (e.g. you asked all of them a question); overuse defeats the point.",
        parameters: Type.Object({ body: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { body: string }) =>
          this.queueCommand({ type: "broadcast", body: params.body }, "broadcast, waking everyone"),
      },
      {
        name: "team_dm",
        label: "Direct message",
        description: "Send a private message that wakes exactly one teammate.",
        parameters: Type.Object(
          {
            to: Type.String({
              description:
                "The recipient's member id (see PEERS). A display name also works if it names exactly one member; if two members share it, or it names none, this bounces instead of guessing — prefer the id.",
            }),
            body: Type.String(),
          },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { to: string; body: string }) =>
          this.queueCommand({ type: "send", to: params.to, body: params.body }, "private message queued"),
      },
      {
        name: "team_group_create",
        label: "Create private group",
        description:
          "Create an immutable restricted group containing yourself and the listed teammates, in one step: an unclaimed channelId is claimed atomically with the create; an id claimed by someone else is rejected. Membership is fixed at creation — list every intended member now.",
        parameters: Type.Object(
          {
            channelId: Type.String(),
            name: Type.String(),
            members: Type.Array(
              Type.String({
                description:
                  "A teammate's member id (see PEERS), or an unambiguous display name — prefer the id.",
              }),
              { minItems: 1 },
            ),
          },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { channelId: string; name: string; members: string[] }) =>
          this.queueCommand(
            {
              type: "create-group",
              channelId: params.channelId,
              name: params.name,
              members: params.members,
            },
            "group created",
          ),
      },
      {
        name: "team_group_send",
        label: "Message private group",
        description: "Post to a restricted group and wake its other members.",
        parameters: Type.Object(
          { channelId: Type.String(), body: Type.String() },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { channelId: string; body: string }) =>
          this.queueCommand(
            { type: "group-send", channelId: params.channelId, body: params.body },
            "group message queued",
          ),
      },
      {
        name: "team_handoff",
        label: "Hand off work",
        description: "Privately transfer the next action and context to exactly one teammate.",
        parameters: Type.Object(
          {
            to: Type.String({
              description:
                "The recipient's member id (see PEERS). A display name also works if it names exactly one member; if two members share it, or it names none, this bounces instead of guessing — prefer the id.",
            }),
            body: Type.String(),
          },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { to: string; body: string }) =>
          this.queueCommand({ type: "handoff", to: params.to, body: params.body }, "handed off"),
      },
      {
        name: "team_claim",
        label: "Claim team resource",
        description:
          "Atomically claim an opaque resource. This must be the only action in the response. Claim first, announce after: the runtime's CLAIM_ACQUIRED/CLAIM_REJECTED reply wakes you for a next turn, so when a claim is your next step, do it immediately — never announce that you will claim and then wait, since nothing would ever wake you again.",
        parameters: Type.Object({ resource: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { resource: string }) =>
          this.queueCommand(
            { type: "claim", resource: params.resource },
            "claim queued; stop now and wait for the runtime result",
          ),
      },
      {
        name: "team_release",
        label: "Release claimed resource",
        description: "Release a resource you currently own so others can claim it.",
        parameters: Type.Object({ resource: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { resource: string }) =>
          this.queueCommand({ type: "release", resource: params.resource }, "release queued"),
      },
      {
        name: "team_vote_open",
        label: "Open a poll",
        description:
          "Open a claimed poll and declare its liveness policy. Choose whether you, the initiator, vote; when the team would otherwise go idle, missing eligible voters are reminded up to maxReminders times. After that they either remain missing or are recorded as first-class abstentions. Opening does not end your turn, so announce or hand off to voters in the same response.",
        parameters: Type.Object(
          {
            pollId: Type.String({ minLength: 1 }),
            initiatorVotes: Type.Boolean({
              description: "False for a non-voting moderator or judge; true when the initiator is also a voter.",
            }),
            maxReminders: Type.Optional(
              Type.Integer({ minimum: 0, maximum: 3, default: 1 }),
            ),
            onReminderExhausted: Type.Optional(
              Type.Union([Type.Literal("leave-missing"), Type.Literal("abstain")], {
                default: "abstain",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        execute: async (
          _id,
          params: {
            pollId: string;
            initiatorVotes: boolean;
            maxReminders?: number;
            onReminderExhausted?: "leave-missing" | "abstain";
          },
        ) =>
          this.queueCommand(
            {
              type: "vote-open",
              pollId: params.pollId,
              initiatorVotes: params.initiatorVotes,
              maxReminders: params.maxReminders ?? 1,
              onReminderExhausted: params.onReminderExhausted ?? "abstain",
            },
            "poll opened",
          ),
      },
      {
        name: "team_vote_cast",
        label: "Cast a vote",
        description:
          "Cast or change your vote in an open poll. Votes are visible to the whole team, not secret. The tally is an exact string match — if you're voting for a teammate, use their member id as the choice. Use team_vote_abstain instead of casting a textual 'abstain' choice.",
        parameters: Type.Object(
          {
            pollId: Type.String(),
            choice: Type.String({
              description:
                "The option you're voting for. When voting for a member, use their member id — never their display name or a mix of formats — so identical votes don't fragment the tally.",
            }),
          },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { pollId: string; choice: string }) =>
          this.queueCommand(
            { type: "vote-cast", pollId: params.pollId, choice: params.choice },
            "vote cast",
          ),
      },
      {
        name: "team_vote_abstain",
        label: "Abstain from a poll",
        description:
          "Respond to an open poll without choosing an option. Abstention is recorded separately and can never win the tally as if it were a candidate.",
        parameters: Type.Object({ pollId: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { pollId: string }) =>
          this.queueCommand({ type: "vote-abstain", pollId: params.pollId }, "abstention recorded"),
      },
      {
        name: "team_vote_close",
        label: "Close a poll",
        description:
          "Tally an open poll and have the runtime publicly announce votes, abstentions, missing voters, and the outcome. The poll initiator is directly woken once every eligible member voted or abstained. Anyone may close; ties are reported honestly.",
        parameters: Type.Object({ pollId: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { pollId: string }) =>
          this.queueCommand({ type: "vote-close", pollId: params.pollId }, "poll closed; see the public result"),
      },
      {
        name: "team_wait",
        label: "Wait",
        description: "End your turn without acting; you will wake on the next interrupt.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => this.queueCommand({ type: "wait" }, "waiting"),
      },
      {
        name: "team_block",
        label: "Block on external input",
        description:
          "End your turn and enter the blocked state, saving your reason: you pause out of the team loop (no wake-ups) and the team is notified to route around you. Only external intervention from the requester resumes you with guidance — so use it only when your next step genuinely requires input, approval, or a resource only the requester can provide, never for work a teammate could do.",
        parameters: Type.Object(
          { reason: Type.String({ minLength: 1, description: "Why you are blocked and what external input you need." }) },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { reason: string }) =>
          this.queueCommand({ type: "block", reason: params.reason }, `blocked: ${params.reason}`),
      },
      {
        name: "team_finish",
        label: "Finish team work",
        description: "Mark your work finished. This is not a public message.",
        parameters: Type.Object({ summary: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { summary: string }) =>
          this.queueCommand({ type: "finish", summary: params.summary }, "finished"),
      },
    ];
    const created = await createAgentSession({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      model: this.context.model,
      modelRuntime,
      thinkingLevel: this.context.thinkingLevel === "max" ? "medium" : this.context.thinkingLevel,
      customTools,
      resourceLoader: loader,
      // Persisted to the project's default Pi session directory (not
      // in-memory) so every member's full first-person history — what it
      // observed, thought, and did — survives the run and even a mid-run
      // crash, and is resumable/readable with ordinary Pi session tooling.
      // parentSession links it back to the session that started the team.
      sessionManager: SessionManager.create(
        this.cwd,
        undefined,
        parentSession ? { parentSession } : undefined,
      ),
    });
    this.session = created.session;
    created.session.setSessionName?.(`agent team · ${this.member.name} (${this.member.id})`);
    return created.session;
  }

  private queueCommand(command: TeamCommand, confirmation: string) {
    if (this.reporting)
      return {
        content: [
          {
            type: "text" as const,
            text: "TEAM_SETTLED: coordination tools are inactive during the final report; write the report itself as your response.",
          },
        ],
        details: {},
      };
    const provisional = `queued provisionally (not yet published; the runtime validates the complete batch): ${confirmation}`;
    const { text, endsTurn } = this.turnState.apply(command, provisional);
    if (endsTurn) void this.session?.abort().catch(() => {});
    return { content: [{ type: "text" as const, text }], details: {} };
  }
}

export function formatTurn(turn: TeamTurn): string {
  return [
    `TEAM OBJECTIVE: ${turn.objective}`,
    `YOUR ID: ${turn.member.id}`,
    `PEERS (UNORDERED): ${turn.peers.map((member) => `${member.id} (${member.name})`).join(", ")}`,
    `TURN: ${turn.turn}`,
    ...formatDigest(turn),
    "NEW CHANNEL OBSERVATIONS:",
    ...(turn.observations.length
      ? turn.observations.map((message) => formatObservation(message, turn.member.id))
      : ["(none)"]),
    "Act from actual posted state. Team tool results are provisional until the runtime commits your complete batch; publish optimistically, but if fresh observations hold it, reread and recompute rather than blindly repeating peers or inventing speaking slots.",
    "Converse in public: team_say with teammates in `to` wakes them to reply. Reserve direct/group messages and handoff for genuinely private coordination. A finish summary is not speech. If no action is needed, call team_wait.",
  ].join("\n");
}

function formatDigest(turn: TeamTurn): string[] {
  const { states, blockedReasons, claims, groups, polls } = turn.digest;
  const lines = [
    `TEAM STATE: ${turn.peers
      .map((member) => `${member.id}=${states[member.id] ?? "idle"}`)
      .join(", ")}`,
  ];
  const blocked = Object.entries(blockedReasons);
  if (blocked.length)
    lines.push(
      `BLOCKED: ${blocked.map(([memberId, reason]) => `${memberId}=${JSON.stringify(reason)}`).join(", ")}`,
    );
  const held = Object.entries(claims);
  if (held.length)
    lines.push(
      `HELD CLAIMS: ${held.map(([resource, owner]) => `${resource}→${owner}`).join(", ")}`,
    );
  if (groups.length)
    lines.push(
      `YOUR GROUPS: ${groups
        .map((group) => `${group.name} (${group.id}): ${group.members.join(", ")}`)
        .join("; ")}`,
    );
  // Open polls are otherwise only visible by re-reading past public speech;
  // surfacing the live tally here means a member can tell whether a poll is
  // still open, and who's missing, without reconstructing it from history
  // (invariant 1 — a shared mental model supplied on every wake).
  if (polls.length)
    lines.push(
      `OPEN POLLS: ${polls
        .map(
          (poll) =>
            `${poll.pollId} initiator=${poll.initiator} tally=${JSON.stringify(poll.tally)} abstained=${JSON.stringify(poll.abstained)} autoAbstained=${JSON.stringify(poll.autoAbstained)} missing=${JSON.stringify(poll.missing)}`,
        )
        .join("; ")}`,
    );
  return lines;
}

function formatObservation(message: MessageEnvelope, selfId: string): string {
  const channel =
    message.channel.kind === "public"
      ? // A mention marker tells the member *why* it was woken: this public
        // message named it as the expected next speaker.
        `# public${message.mentions.includes(selfId) ? " (mentions you)" : ""}`
      : message.channel.kind === "group"
        ? `# ${message.channel.name}`
        : "direct";
  return `[${message.id}] ${channel} · ${message.from}: ${message.body}`;
}

