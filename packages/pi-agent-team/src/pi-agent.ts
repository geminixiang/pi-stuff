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

interface SessionLike {
  readonly sessionId: string;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  getLastAssistantText(): string | undefined;
  dispose(): Promise<void> | void;
}

export class PiTeamAgent implements TeamAgent {
  private session?: SessionLike;
  private outbox: TeamCommand[] = [];
  private claimPending = false;
  private turnEnded = false;
  private readonly provisionalSessionId = crypto.randomUUID();

  constructor(
    readonly member: TeamMember,
    private readonly cwd: string,
    private readonly context: ExtensionContext,
  ) {}

  get sessionId(): string {
    return this.session?.sessionId ?? this.provisionalSessionId;
  }

  async act(turn: TeamTurn, signal: AbortSignal): Promise<readonly TeamCommand[]> {
    const session = await this.getSession();
    this.outbox = [];
    this.claimPending = false;
    this.turnEnded = false;
    if (signal.aborted) throw signal.reason;
    const onAbort = () => void session.abort().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await session.prompt(formatTurn(turn));
    } catch (cause) {
      if (signal.aborted) throw signal.reason;
      // A terminal team action (wait/finish/claim) self-aborts the prompt to
      // stop further tool-call rounds; the queued command still stands. Only
      // rethrow if nothing was queued, which means a real failure occurred.
      if (!this.outbox.length) throw cause;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw signal.reason;
    if (this.outbox.length) return Object.freeze([...this.outbox]);
    return parseCommands(session.getLastAssistantText() ?? "");
  }

  async close(): Promise<void> {
    await this.session?.dispose();
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
        `Team mechanics: team_say is public speech visible to the whole team but does not wake peers. team_dm is a private interrupt to one member. team_group_create creates a restricted group; team_group_send privately interrupts its members. team_handoff is a private interrupt that transfers the next action. team_claim is a synchronization fence: call it alone, stop, and wait for CLAIM_ACQUIRED or CLAIM_REJECTED; team_release returns a claim you own. Claim resource names are visible to the whole team, so use non-revealing names for private coordination. team_wait ends your turn without acting. team_finish is control state, not speech.`,
        `Communication doctrine: (a) Public speech is only for conclusions, decisions, and results the team or user must know; it wakes no one. (b) To make someone act, use a direct message or handoff, and make it self-sufficient: situation, what is done, what they must do, whom to notify after. (c) Briefly acknowledge a received handoff before acting on it. (d) If you are the last step of a chain, notify the initiator or coordinator by direct message before finishing. (e) When blocked, rejected, or uncertain, escalate by direct message immediately; never wait silently. (f) Before modifying a shared resource such as a file, claim it first and release it when done. (g) If nothing you could say would change anyone's next action, call team_wait. (h) A finish summary states only what you actually did; if the objective requires an answer or public statement, call team_say before team_finish.`,
      ].join("\n\n"),
    });
    await loader.reload();
    const customTools: ToolDefinition[] = [
      {
        name: "team_say",
        label: "Speak publicly",
        description: "Post public speech to the team chat. This does not wake waiting peers.",
        parameters: Type.Object({ body: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { body: string }) =>
          this.queue({ type: "say", body: params.body }, "spoken publicly"),
      },
      {
        name: "team_dm",
        label: "Direct message",
        description: "Send a private message that wakes exactly one teammate.",
        parameters: Type.Object(
          { to: Type.String(), body: Type.String() },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { to: string; body: string }) =>
          this.queue({ type: "send", to: params.to, body: params.body }, "private message queued"),
      },
      {
        name: "team_group_create",
        label: "Create private group",
        description:
          "Create an immutable restricted group containing yourself and the listed teammates.",
        parameters: Type.Object(
          {
            channelId: Type.String(),
            name: Type.String(),
            members: Type.Array(Type.String(), { minItems: 1 }),
          },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { channelId: string; name: string; members: string[] }) =>
          this.queue(
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
          this.queue(
            { type: "group-send", channelId: params.channelId, body: params.body },
            "group message queued",
          ),
      },
      {
        name: "team_handoff",
        label: "Hand off work",
        description: "Privately transfer the next action and context to exactly one teammate.",
        parameters: Type.Object(
          { to: Type.String(), body: Type.String() },
          { additionalProperties: false },
        ),
        execute: async (_id, params: { to: string; body: string }) =>
          this.queue({ type: "handoff", to: params.to, body: params.body }, "handed off"),
      },
      {
        name: "team_claim",
        label: "Claim team resource",
        description:
          "Atomically claim an opaque resource. This must be the only action in the response.",
        parameters: Type.Object({ resource: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { resource: string }) => {
          if (this.outbox.length || this.claimPending || this.turnEnded)
            return toolText(
              "claim rejected locally: team_claim must be the only action in this response",
            );
          this.claimPending = true;
          this.turnEnded = true;
          this.outbox.push({ type: "claim", resource: params.resource });
          void this.session?.abort().catch(() => {});
          return toolText("claim queued; stop now and wait for the runtime result");
        },
      },
      {
        name: "team_release",
        label: "Release claimed resource",
        description: "Release a resource you currently own so others can claim it.",
        parameters: Type.Object({ resource: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { resource: string }) =>
          this.queue({ type: "release", resource: params.resource }, "release queued"),
      },
      {
        name: "team_wait",
        label: "Wait",
        description: "End your turn without acting; you will wake on the next interrupt.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => this.queue({ type: "wait" }, "waiting"),
      },
      {
        name: "team_finish",
        label: "Finish team work",
        description: "Mark your work finished. This is not a public message.",
        parameters: Type.Object({ summary: Type.String() }, { additionalProperties: false }),
        execute: async (_id, params: { summary: string }) =>
          this.queue({ type: "finish", summary: params.summary }, "finished"),
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
      sessionManager: SessionManager.inMemory(this.cwd),
    });
    this.session = created.session;
    return created.session;
  }

  private queue(command: TeamCommand, confirmation: string) {
    if (this.claimPending) return claimFenceText();
    if (this.turnEnded) return turnEndedText();
    this.outbox.push(command);
    if (endsTurn(command)) {
      this.turnEnded = true;
      void this.session?.abort().catch(() => {});
    }
    return toolText(confirmation);
  }
}

/**
 * wait and finish mean "nothing more to do this turn"; a model that keeps
 * calling tools after either one just burns turn latency and risks the
 * per-agent timeout. Ending the turn here is what makes the timeout budget
 * cover team decisions instead of internal re-polling.
 */
export function endsTurn(command: TeamCommand): boolean {
  return command.type === "wait" || command.type === "finish" || command.type === "claim";
}

function formatTurn(turn: TeamTurn): string {
  return [
    `TEAM OBJECTIVE: ${turn.objective}`,
    `YOUR ID: ${turn.member.id}`,
    `PEERS (UNORDERED): ${turn.peers.map((member) => `${member.id} (${member.name})`).join(", ")}`,
    `TURN: ${turn.turn}`,
    ...formatDigest(turn),
    "NEW CHANNEL OBSERVATIONS:",
    ...(turn.observations.length ? turn.observations.map(formatObservation) : ["(none)"]),
    "Use public speech for anything the team or user must hear. Use direct/group messages or handoff to wake peers. A finish summary is not speech. If no action is needed, call team_wait.",
  ].join("\n");
}

function formatDigest(turn: TeamTurn): string[] {
  const { states, claims, groups } = turn.digest;
  const lines = [
    `TEAM STATE: ${turn.peers
      .map((member) => `${member.id}=${states[member.id] ?? "idle"}`)
      .join(", ")}`,
  ];
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
  return lines;
}

function formatObservation(message: MessageEnvelope): string {
  const channel =
    message.channel.kind === "public"
      ? "# public"
      : message.channel.kind === "group"
        ? `# ${message.channel.name}`
        : "direct";
  return `[${message.id}] ${channel} · ${message.from}: ${message.body}`;
}

/** A turn that ends with no team tool call is leniently treated as waiting. */
export function parseCommands(_text: string): readonly TeamCommand[] {
  return [{ type: "wait" }];
}

function claimFenceText() {
  return toolText("blocked by pending claim: stop and wait for CLAIM_ACQUIRED or CLAIM_REJECTED");
}

function turnEndedText() {
  return toolText("turn already ended by a prior wait/finish/claim this response; stop calling tools");
}

function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}
