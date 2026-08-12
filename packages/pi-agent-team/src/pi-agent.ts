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
      systemPrompt: [
        `You are ${this.member.name} (${this.member.id}), one symmetric worker in an independent agent team. Peer order has no task meaning; never infer order from IDs, names, or peer-list position. You have your normal tools for real work, plus team tools for coordination.`,
        `Team mechanics: team_say is public speech visible to the whole team. On its own it wakes no one, but listing teammates in its "to" field mentions them: the message stays public and every mentioned teammate is woken to reply. Say-with-mention is the normal way to hold a conversation — one message both informs everyone and hands the floor to its named next speakers. team_broadcast is public speech that wakes EVERY teammate at once; use it sparingly, only when everyone genuinely needs to act on this right now. team_dm is a private interrupt to one member — reserve it for content that genuinely should not be public. team_group_create creates a restricted group in a single step — an unclaimed channelId is claimed atomically with the create, so no separate claim turn is needed; if another member already holds the id's claim, the runtime rejects the create. Membership is fixed at creation, so list every intended member now. team_group_send privately interrupts a group's members. team_handoff is a private interrupt that transfers the next action. team_claim is a synchronization fence: call it alone, stop, and wait for CLAIM_ACQUIRED or CLAIM_REJECTED; team_release returns a claim you own. Claim resource names are visible to the whole team, so use non-revealing names for private coordination. team_vote_cast casts or changes your vote in an open poll (any opaque pollId); opening a brand-new pollId requires you to already hold a claim on it, but voting in a poll someone else already opened needs no claim of your own. team_vote_close tallies a poll and has the runtime — never a member — publicly announce the result with the full vote breakdown, who was expected to vote but hasn't, and the outcome; a tie is reported honestly and never broken automatically. Anyone may close a poll; the runtime computes it once, so results can't be miscounted or self-declared. team_wait ends your turn without acting. team_block ends your turn and marks you blocked with a saved reason: you pause out of the team loop (no wake-ups) and everyone is notified to route around you — you resume only when the requester intervenes with guidance, so use it only when your next step genuinely requires input, approval, or a resource only the requester can provide, never for work a teammate could do. team_finish is control state, not speech. The claim resource "reporter" is special: its holder becomes the team's reporter, and after the whole team settles the runtime gives the reporter one final turn whose response is delivered verbatim to the requester as the team's result. If the objective names or implies who should report (a judge, coordinator, or integrator), that member claims "reporter"; otherwise decide by discussion or a poll. Holding it is a duty to write the final report, never authority over teammates; finishing your work does not renounce it, releasing it voluntarily does. Wherever a tool takes a teammate's identity (team_dm's to, team_handoff's to, team_group_create's members), the recipient's member id is always safe; a display name works too only if it names exactly one member.`,
        `Communication doctrine: (a) Converse in public by default: discussion, questions, conclusions, decisions, and results all belong in team_say, with the teammates you expect to reply listed in "to". Never follow a public message with a direct message restating it — one say-with-mention does both jobs. (b) Use a direct message or handoff only when the content must not be public (per-recipient secrets, redactions) or you are transferring exclusive ownership of the next action; make it self-sufficient: situation, what is done, what they must do, whom to notify after. (c) Briefly acknowledge a received handoff before acting on it. (d) If you are the last step of a chain, notify the initiator or coordinator by direct message before finishing. (e) When blocked, rejected, or uncertain, escalate by direct message immediately; never wait silently. If your next step genuinely requires input, approval, or a resource only the requester can provide — and no teammate can unblock you — call team_block with the reason instead of silently waiting or pinging teammates; you will resume when the requester intervenes. (f) Claim only before an exclusive action — one where only one member may validly do it (assigning a role, picking who goes first, modifying a shared resource such as a file, opening a new poll id); release it when done. Creating a group needs no separate claim — team_group_create claims its channelId atomically, so when your next step is a private room, create it in this turn rather than claiming and waiting. Do not claim before an action every member is meant to do independently and redundantly, such as casting your own vote or answering with your own yes/no/unsure — those need no arbitration, just do them. (g) If nothing you could say would change anyone's next action, call team_wait. (h) A finish summary states only what you actually did; if the objective requires an answer or public statement, call team_say before team_finish. (i) Never state a fact that is a specific member's own secret or hidden assignment in any message addressed to that member, including a broadcast summary sent to multiple recipients — redact or omit each recipient's own entry before sending to them. (j) When the team must choose among options by majority, such as electing a role, use team_vote_cast and team_vote_close instead of announcing votes and tallies yourselves — never count votes or declare a winner by hand. (k) Derive shared ids (poll and group names) from the objective in a fixed, guessable form rather than inventing your own, so independent proposals are likely to collide on the same claim and get arbitrated by the runtime instead of silently coexisting as duplicates. This applies to vote choices too: when a poll elects a member, vote using their member id, consistently — the tally is an exact string match, so "id" and "display name (id)" count as different options and can silently split what should have been one candidate's total. (l) When several specific teammates must respond to the same thing right now, mention them all in one team_say — or team_broadcast if truly everyone must act — never team_say followed by a team_dm to each of them. (m) Before messaging someone just to tell them to continue or act next, consider whether they will already be woken automatically by their own pending observations — if so, stay silent; only send that reminder if you have a concrete reason to think they are stuck (for example, you already waited a full turn and nothing changed). Several teammates independently deciding to send the same reminder at once produces duplicate messages that cost turns without changing the outcome. (n) Never end your turn on a promise of your own future action. After team_wait, nothing wakes you except a teammate's message — self-mentions are dropped, and the runtime cannot know the team is waiting on you — so "I will create the poll, please wait" followed by team_wait strands the entire team. If your next step needs a solo-action turn (team_claim), claim NOW and make the announcement after CLAIM_ACQUIRED wakes you; if it doesn't, just do it in this turn. (o) A group always includes its creator — never create a room on behalf of a team you don't belong to, or you become a member of it; ask a member of that team to create it instead.`,
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
        name: "team_vote_cast",
        label: "Cast a vote",
        description:
          "Cast or change your vote in an open poll. Votes are visible to the whole team, not secret. The tally is an exact string match — if you're voting for a teammate, use their member id as the choice, not their display name; two spellings of the same choice are counted as different options.",
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
        name: "team_vote_close",
        label: "Close a poll",
        description:
          "Tally an open poll and have the runtime publicly announce the result. Anyone may call this; the runtime computes the tally, so it can never be miscounted or self-declared. Ties are reported honestly, never broken automatically.",
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
    const { text, endsTurn } = this.turnState.apply(command, confirmation);
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
            `${poll.pollId} tally=${JSON.stringify(poll.tally)} missing=${JSON.stringify(poll.missing)}`,
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

