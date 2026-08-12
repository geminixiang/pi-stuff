import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  assertValidMemberId,
  type TeamActivity,
  type TeamProgress,
  type TeamResult,
} from "./domain.js";
import { PiTeamAgent } from "./pi-agent.js";
import { TeamRunManager, type TeamRunSnapshot } from "./run-manager.js";
import { TeamRuntime } from "./runtime.js";
import { TeamChatView, type TeamDisplayDetails } from "./team-chat-view.js";
import { TeamRosterWidget } from "./team-roster-widget.js";

/**
 * The final tool result is written into the parent session's JSONL and (for
 * `content`) into the parent model's context, so both must stay bounded no
 * matter how chatty the team was. A live werewolf run once returned ~1.2M
 * chars of content plus ~1.2M chars of details and forced a split-turn
 * compaction of the parent session; the cap below plus renderFinalContent's
 * pointer-based manifest is what prevents a recurrence. Full histories are
 * not lost — every member session is persisted to disk and referenced by
 * path in the manifest.
 */
const MAX_FINAL_ACTIVITIES = 200;

/**
 * Runs before `params.members` collapses into a `Map<MemberId, TeamAgent>`
 * (`new Map(members.map((m) => [m.id, ...]))`): a Map is inherently
 * deduplicated by key, so a duplicate id in the raw array would otherwise
 * silently fold into one entry — the caller's intended member count quietly
 * shrinks with no error anywhere. "all" is reserved separately from
 * assertValidMemberId's "user"/"runtime" check because it's meaningful only
 * to this extension's startMemberId convention, not to TeamRuntime itself.
 */
export function assertUniqueMemberRoster(members: readonly { id: string; name: string }[]): void {
  for (const member of members) {
    assertValidMemberId(member.id);
    if (member.id === "all")
      throw new Error(
        `Member id "all" is reserved for startMemberId's "send to everyone" sentinel; choose a different id`,
      );
  }
  const ids = members.map((member) => member.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Duplicate member id "${duplicate}": member ids must be unique`);
}

export default function agentTeam(pi: ExtensionAPI): void {
  const runs = new TeamRunManager();
  pi.on("session_shutdown", () => runs.shutdown());
  registerTeamControlTools(pi, runs);

  pi.registerTool({
    name: "team_start",
    label: "Start independent agent team",
    description:
      "Create independent agent sessions with public, direct, and restricted group channels. By default this waits and shows live activity; detached mode returns a runId for team_get/team_wait/team_prompt/team_cancel. The runtime knows no task rules or expected answers.",
    promptSnippet: "Start an independent mailbox-driven agent team",
    promptGuidelines: [
      "Give the team the user's objective and initial message without adding expected answers.",
      "For autonomous coordination, use opaque member IDs, omit startMemberId, and let all members start symmetrically.",
      "Never encode task order in member IDs, names, array order, objective, or initial message.",
      "After starting, do not act for members or inject messages unless the requester asks or a detached member explicitly blocks for requester input.",
      "Do not guess a maxTurns value; the team runtime supplies a safe default.",
      'When the request implies a natural reporter (a judge, coordinator, or integrator), pass reporterId; otherwise state in the objective how the team should decide who claims the "reporter" resource.',
      "Use reportPrompt to pass the user's requirements for the final report (format, files, language) verbatim.",
    ],
    parameters: Type.Object(
      {
        objective: Type.String(),
        members: Type.Array(
          Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: false }),
          { minItems: 2, maxItems: 32 },
        ),
        startMemberId: Type.Optional(
          Type.String({
            description:
              "Advanced directed-start escape hatch. Omit for symmetric autonomous coordination.",
          }),
        ),
        reporterId: Type.Optional(
          Type.String({
            description:
              'Member who must deliver the team\'s final report after settlement. Omit to let the team choose during play by claiming the "reporter" resource.',
          }),
        ),
        reportPrompt: Type.Optional(
          Type.String({
            description:
              "Instructions for the final report turn (format, files, language, audience). Omit for a generic final-report request.",
          }),
        ),
        detached: Type.Optional(
          Type.Boolean({
            description:
              "Run in the background and return a runId immediately. Available in long-lived TUI/RPC sessions only.",
          }),
        ),
        initialMessage: Type.String(),
      },
      { additionalProperties: false },
    ),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      assertUniqueMemberRoster(params.members);
      const reporterId = params.reporterId?.trim() || undefined;
      if (reporterId && !params.members.some((member) => member.id === reporterId))
        throw new Error(`Unknown reporterId: ${reporterId}`);
      const startMemberId = params.startMemberId?.trim() || "all";
      if (
        startMemberId !== "all" &&
        !params.members.some((member) => member.id === startMemberId)
      )
        throw new Error(`Unknown startMemberId: ${startMemberId}`);
      const initial =
        startMemberId === "all"
          ? ({ channel: { kind: "public" as const }, body: params.initialMessage } as const)
          : ({
              channel: { kind: "direct" as const, memberId: startMemberId },
              body: params.initialMessage,
            } as const);

      if (params.detached) {
        if (ctx.mode !== "tui" && ctx.mode !== "rpc")
          throw new Error("detached teams require a long-lived TUI or RPC session");
        const agents = new Map(
          params.members.map((member) => [member.id, new PiTeamAgent(member, ctx.cwd, ctx)]),
        );
        let runtime!: TeamRuntime;
        runtime = new TeamRuntime(params.objective, agents, {
          reactionDelayMs: { min: 50, max: 500 },
          waitForIntervention: true,
          reporterId,
          reportPrompt: params.reportPrompt,
          onActivity: (activity) => runs.observeActivity(runtime.teamId, activity),
          onProgress: (progress) => runs.observeProgress(runtime.teamId, progress),
        });
        const snapshot = runs.start(runtime, initial);
        return {
          content: [{ type: "text", text: renderRunSnapshot(snapshot) }],
          details: snapshot,
        };
      }

      const activities: TeamActivity[] = [];
      let progress: TeamProgress | undefined;
      const details = (): TeamDisplayDetails => ({
        members: params.members,
        activities: Object.freeze([...activities]),
        progress,
      });

      // A standalone widget pinned above the editor: a compact, Discord-style
      // presence roster (who's speaking, who they last addressed, who's
      // idle/finished/errored) for end users watching the team work. The
      // full blow-by-blow narration stays in the tool-result card below
      // (TeamChatView) for debugging; the two views serve different readers.
      const widgetKey = `pi-agent-team:${toolCallId}`;
      const usesWidget = ctx.mode === "tui";
      let widgetView: TeamRosterWidget | undefined;
      let widgetTheme: Theme | undefined;
      if (usesWidget)
        ctx.ui.setWidget(
          widgetKey,
          (_tui, theme) => {
            widgetTheme = theme;
            return (widgetView = new TeamRosterWidget(theme));
          },
          { placement: "aboveEditor" },
        );

      const update = () => {
        onUpdate?.({
          content: [{ type: "text", text: summarizeLive(details()) }],
          details: details(),
        });
        if (widgetView && widgetTheme) widgetView.update(details(), widgetTheme);
      };
      const agents = new Map(
        params.members.map((member) => [member.id, new PiTeamAgent(member, ctx.cwd, ctx)]),
      );
      const runtime = new TeamRuntime(params.objective, agents, {
        // Staggers who starts (and visually lights up) within a concurrent
        // wave, so a burst of claim contenders doesn't glow all at once.
        reactionDelayMs: { min: 50, max: 500 },
        reporterId,
        reportPrompt: params.reportPrompt,
        onActivity(activity) {
          activities.push(activity);
          update();
        },
        onProgress(nextProgress) {
          progress = nextProgress;
          update();
        },
      });
      try {
        const result = await runtime.run(initial, signal);
        return {
          content: [{ type: "text", text: renderFinalContent(result, params.members) }],
          details: finalDetails(details(), result),
        };
      } finally {
        if (usesWidget) ctx.ui.setWidget(widgetKey, undefined);
      }
    },
    // The tool card always stacks this call component above the result
    // component (pi-coding-agent's ToolExecutionComponent.updateDisplay adds
    // both children unconditionally), so keep this minimal — TeamChatView
    // in renderResult owns the live roster and per-member state once it exists.
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold(`agent team · ${args.members.length} members`)),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as TeamDisplayDetails | undefined;
      if (!details) {
        const content = result.content[0];
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      // Reused across renders via ToolRenderContext.state so historical rows
      // are built once instead of re-parsing the whole transcript every tick.
      const state = context.state as { view?: TeamChatView };
      const view = (state.view ??= new TeamChatView(theme));
      view.update(details, { expanded, isPartial }, theme);
      return view;
    },
  });
}

function registerTeamControlTools(pi: ExtensionAPI, runs: TeamRunManager): void {
  registerTeamGet(pi, runs);
  registerTeamWait(pi, runs);
  registerTeamPrompt(pi, runs);
  registerTeamCancel(pi, runs);
}

function snapshotResult(snapshot: TeamRunSnapshot) {
  return { content: [{ type: "text" as const, text: renderRunSnapshot(snapshot) }], details: snapshot };
}

function registerTeamGet(pi: ExtensionAPI, runs: TeamRunManager): void {
  pi.registerTool({
    name: "team_get",
    label: "Get background team",
    description:
      "Get a bounded detached-run snapshot: lifecycle, member progress, lightweight events, and final report/manifest.",
    parameters: Type.Object({ runId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      return snapshotResult(runs.get(params.runId));
    },
  });
}

function registerTeamWait(pi: ExtensionAPI, runs: TeamRunManager): void {
  pi.registerTool({
    name: "team_wait",
    label: "Wait for background team",
    description:
      "Wait without polling until a detached team changes after afterSeq, settles, or reaches timeoutMs. Omit afterSeq to wait for the next change.",
    parameters: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 300_000 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal) {
      return snapshotResult(
        await runs.wait(params.runId, {
          afterSeq: params.afterSeq,
          timeoutMs: params.timeoutMs,
          signal,
        }),
      );
    },
  });
}

function registerTeamPrompt(pi: ExtensionAPI, runs: TeamRunManager): void {
  pi.registerTool({
    name: "team_prompt",
    label: "Prompt background team member",
    description:
      "Send requester guidance to one non-terminal detached member, waking it and resuming it when blocked.",
    parameters: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        memberId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1, maxLength: 8_000 }),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return snapshotResult(runs.prompt(params.runId, params.memberId, params.message));
    },
  });
}

function registerTeamCancel(pi: ExtensionAPI, runs: TeamRunManager): void {
  pi.registerTool({
    name: "team_cancel",
    label: "Cancel background team",
    description: "Request cancellation of a running detached team.",
    parameters: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      return snapshotResult(runs.cancel(params.runId, params.reason));
    },
  });
}

function renderRunSnapshot(snapshot: TeamRunSnapshot): string {
  const lines = [
    `team run: ${snapshot.runId}`,
    `status: ${snapshot.status}`,
    `stateChangeSeq: ${snapshot.stateChangeSeq}`,
  ];
  if (snapshot.progress)
    lines.push(
      `progress: ${snapshot.progress.turns} turns · ${snapshot.progress.finished.length} finished · ${snapshot.progress.blocked.length} blocked`,
      `states: ${JSON.stringify(snapshot.progress.states)}`,
      ...(snapshot.progress.blocked.length
        ? [`blocked reasons: ${JSON.stringify(snapshot.progress.blockedReasons)}`]
        : []),
    );
  if (snapshot.result) {
    lines.push(
      `settlement: ${snapshot.result.settlement.kind} (${snapshot.result.settlement.meaning}; objective correctness unverified)`,
    );
    if (snapshot.result.report)
      lines.push(
        `FINAL REPORT — ${snapshot.result.report.reporterId}:`,
        snapshot.result.report.body,
      );
    else lines.push(`NO FINAL REPORT: ${snapshot.result.reportError ?? "no reporter"}`);
    lines.push("members:");
    for (const member of snapshot.result.members) {
      lines.push(
        `- ${member.id} · ${member.state} · ${member.turns} turns · session ${member.sessionId}${member.sessionRef ? ` · ${member.sessionRef}` : ""}`,
      );
      if (member.summary) lines.push(`  finish summary: ${member.summary}`);
      if (member.error) lines.push(`  error: ${member.error}`);
      if (member.blockedReason) lines.push(`  blocked: ${member.blockedReason}`);
    }
    lines.push(
      `messages: ${snapshot.result.messageCounts.public} public · ${snapshot.result.messageCounts.restricted} restricted`,
      `audit: ${snapshot.result.audit.events} events · head ${snapshot.result.audit.head}`,
      `user interventions: ${snapshot.result.userInterventions}`,
    );
  }
  if (snapshot.error) lines.push(`error: ${snapshot.error}`);
  const latest = snapshot.events.at(-1);
  if (latest) lines.push(`latest event: #${latest.sequence} ${latest.type} · ${latest.summary}`);
  return lines.join("\n");
}

function summarizeLive(details: TeamDisplayDetails): string {
  const latest = details.activities.at(-1);
  return `${details.progress?.turns ?? 0} turns · ${details.progress?.finished.length ?? 0}/${details.members.length} finished${latest ? ` · ${latest.memberId}: ${latest.text}` : ""}`;
}

/**
 * The model-visible tool result: the reporter's verbatim report (naturally
 * bounded — it is one LLM turn's final response) plus a pointer-based
 * manifest. Transcripts, restricted messages, and audit events appear only
 * as counts; the durable detail lives in the per-member session files the
 * manifest points at.
 */
export function renderFinalContent(
  result: TeamResult,
  members: readonly { id: string; name: string }[],
): string {
  const nameOf = (id: string) => members.find((member) => member.id === id)?.name ?? id;
  const lines: string[] = [];
  if (result.report) {
    lines.push(
      `FINAL REPORT — ${nameOf(result.report.reporterId)} (${result.report.reporterId}):`,
      "",
      result.report.body,
      "",
      "---",
    );
  } else {
    lines.push(
      `NO FINAL REPORT: ${result.reportError ?? 'no member was designated or claimed "reporter"'}. The finish summaries below are the only per-member conclusions.`,
      "",
      "---",
    );
  }
  lines.push(
    "TEAM MANIFEST",
    `team: ${result.teamId}`,
    `settlement: ${result.settlement.kind} (${result.settlement.meaning}; objective correctness unverified)`,
    "members:",
  );
  for (const member of result.members) {
    lines.push(
      `- ${member.id} (${nameOf(member.id)}) · ${member.state} · ${member.turns} turns · session ${member.sessionId}${member.sessionRef ? ` · ${member.sessionRef}` : ""}`,
    );
    if (member.summary) lines.push(`  finish summary: ${member.summary}`);
    if (member.error) lines.push(`  error: ${member.error}`);
  }
  lines.push(
    `messages: ${result.publicTranscript.length} public · ${result.restrictedMessages.length} restricted (bodies not included here)`,
    `audit: ${result.events.length} events · head ${result.auditHead}`,
    "Each member's full first-person history is in its session file listed above.",
  );
  return lines.join("\n");
}

/**
 * The persisted display snapshot: bounded activities suffix plus the
 * settlement slice TeamChatView renders — never the full TeamResult, whose
 * transcript/events would otherwise be serialized into the parent session
 * a second time.
 */
export function finalDetails(live: TeamDisplayDetails, result: TeamResult): TeamDisplayDetails {
  const omitted = Math.max(0, live.activities.length - MAX_FINAL_ACTIVITIES);
  return {
    members: live.members,
    activities: Object.freeze(live.activities.slice(-MAX_FINAL_ACTIVITIES)),
    ...(omitted ? { omittedActivities: omitted } : {}),
    progress: live.progress,
    result: {
      settlement: result.settlement,
      members: result.members.map((member) => ({
        id: member.id,
        turns: member.turns,
        summary: member.summary,
      })),
      ...(result.report ? { report: { reporterId: result.report.reporterId } } : {}),
      ...(result.reportError !== undefined ? { reportError: result.reportError } : {}),
    },
  };
}
