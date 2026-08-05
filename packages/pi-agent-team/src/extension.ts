import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { assertValidMemberId, type TeamActivity, type TeamProgress } from "./domain.js";
import { PiTeamAgent } from "./pi-agent.js";
import { TeamRuntime } from "./runtime.js";
import { TeamChatView, type TeamDisplayDetails } from "./team-chat-view.js";
import { TeamRosterWidget } from "./team-roster-widget.js";

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
  pi.registerTool({
    name: "team_start",
    label: "Start independent agent team",
    description:
      "Create independent agent sessions with public, direct, and restricted group channels while showing every member's live activity. The runtime routes observations and wake signals but knows no task rules or expected answers.",
    promptSnippet: "Start an independent mailbox-driven agent team",
    promptGuidelines: [
      "Give the team the user's objective and initial message without adding expected answers.",
      "For autonomous coordination, use opaque member IDs, omit startMemberId, and let all members start symmetrically.",
      "Never encode task order in member IDs, names, array order, objective, or initial message.",
      "After starting, do not act for members or inject additional messages.",
      "Do not guess a maxTurns value; the team runtime supplies a safe default.",
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
        initialMessage: Type.String(),
      },
      { additionalProperties: false },
    ),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      assertUniqueMemberRoster(params.members);
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
        onActivity(activity) {
          activities.push(activity);
          update();
        },
        onProgress(nextProgress) {
          progress = nextProgress;
          update();
        },
      });
      const startMemberId = params.startMemberId?.trim() || "all";
      if (startMemberId !== "all" && !agents.has(startMemberId))
        throw new Error(`Unknown startMemberId: ${startMemberId}`);
      try {
        const result = await runtime.run(
          startMemberId === "all"
            ? { channel: { kind: "public" }, body: params.initialMessage }
            : { channel: { kind: "direct", memberId: startMemberId }, body: params.initialMessage },
          signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { ...details(), result },
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

function summarizeLive(details: TeamDisplayDetails): string {
  const latest = details.activities.at(-1);
  return `${details.progress?.turns ?? 0} turns · ${details.progress?.finished.length ?? 0}/${details.members.length} finished${latest ? ` · ${latest.memberId}: ${latest.text}` : ""}`;
}
