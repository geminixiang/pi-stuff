import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type Component } from "@earendil-works/pi-tui";
import type { ChannelTarget, TeamActivity, TeamMemberState, TeamProgress, TeamResult } from "./domain.js";
import { accentWrap } from "./member-colors.js";

export interface TeamDisplayDetails {
  members: readonly { id: string; name: string }[];
  activities: readonly TeamActivity[];
  progress?: TeamProgress;
  result?: TeamResult;
}

export interface TeamChatViewOptions {
  expanded: boolean;
  isPartial: boolean;
}

interface ChatRow {
  render(width: number): string[];
}

function speakerDisplayName(
  memberId: string,
  members: readonly { id: string; name: string }[],
): string {
  if (memberId === "user") return "You";
  if (memberId === "runtime") return "Runtime";
  return members.find((member) => member.id === memberId)?.name ?? memberId;
}

/** message/finish/error activities: a full bubble with a speaker-colored accent bar and markdown body. */
class MessageRow implements ChatRow {
  private readonly markdown: Markdown;
  private readonly headerLine: string;
  private readonly accentBar: string;

  constructor(item: TeamActivity, members: readonly { id: string; name: string }[], theme: Theme) {
    const speakerName = speakerDisplayName(item.memberId, members);
    this.accentBar = accentWrap(item.memberId, "┃");
    const tag =
      item.kind === "finish"
        ? theme.fg("success", "✓ finished")
        : item.kind === "error"
          ? theme.fg("error", "✗ errored")
          : channelTag(item, members, theme);
    this.headerLine = `${accentWrap(item.memberId, theme.bold(speakerName))} ${theme.fg("dim", `(${item.memberId})`)}  ${tag}`;
    this.markdown = new Markdown(item.body ?? item.text, 0, 0, getMarkdownTheme());
  }

  render(width: number): string[] {
    const bodyLines = this.markdown.render(Math.max(1, width - 2));
    return [`${this.accentBar} ${this.headerLine}`, ...bodyLines.map((line) => `${this.accentBar} ${line}`)];
  }
}

/** wait/claim/channel/wake activities: a single dim, muted line. No markdown parsing needed. */
class CompactRow implements ChatRow {
  private readonly line: string;

  constructor(item: TeamActivity, members: readonly { id: string; name: string }[], theme: Theme) {
    const speakerName = speakerDisplayName(item.memberId, members);
    this.line =
      item.kind === "claim"
        ? `  ${theme.fg("muted", "⚙")} ${accentWrap(item.memberId, speakerName)} ${theme.fg("dim", item.text)}`
        : `  ${theme.fg("dim", `· ${speakerName} ${item.text}`)}`;
  }

  render(): string[] {
    return [this.line];
  }
}

function channelTag(
  item: TeamActivity,
  members: readonly { id: string; name: string }[],
  theme: Theme,
): string {
  const target = channelLabel(item, members);
  const icon = item.visibility === "restricted" ? "🔒" : "📣";
  return theme.fg("muted", `${icon} ${target}`);
}

function memberLabel(memberId: string, members: readonly { id: string; name: string }[]): string {
  const name = members.find((member) => member.id === memberId)?.name;
  return name ? `${name} (${memberId})` : memberId;
}

function channelLabel(
  item: TeamActivity,
  members: readonly { id: string; name: string }[],
): string {
  const { channel } = item;
  if (channel.kind === "public") {
    const mentions = item.mentions?.map((memberId) => memberLabel(memberId, members)).join(", ");
    return mentions ? `# everyone → ${mentions}` : "# everyone";
  }
  if (channel.kind === "group") return `# ${channel.channelId}`;
  return `@ ${memberLabel(channel.memberId, members)}`;
}

/**
 * Incrementally-rendered team chat. Reused across renderResult calls via
 * ToolRenderContext.state so historical rows are built once, not on every
 * activity tick — pi-tui's own Markdown/Text caching then also skips
 * recomputation whenever the terminal width is unchanged between renders.
 */
export class TeamChatView implements Component {
  private rows: ChatRow[] = [];
  private syncedCount = 0;
  private details: TeamDisplayDetails = { members: [], activities: [] };
  private options: TeamChatViewOptions = { expanded: false, isPartial: true };

  constructor(private theme: Theme) {}

  update(details: TeamDisplayDetails, options: TeamChatViewOptions, theme: Theme): void {
    this.details = details;
    this.options = options;
    if (theme !== this.theme) {
      this.theme = theme;
      this.syncedCount = 0;
      this.rows = [];
    }
    for (let index = this.syncedCount; index < details.activities.length; index++) {
      const item = details.activities[index];
      this.rows.push(
        item.kind === "message" || item.kind === "finish" || item.kind === "error"
          ? new MessageRow(item, details.members, this.theme)
          : new CompactRow(item, details.members, this.theme),
      );
    }
    this.syncedCount = details.activities.length;
  }

  invalidate(): void {
    this.syncedCount = 0;
    this.rows = [];
  }

  render(width: number): string[] {
    const { details, options, theme } = this;
    const finished = new Set(
      details.result?.members.filter((member) => member.summary).map((member) => member.id) ??
        details.progress?.finished ??
        [],
    );
    const lines = [
      `${options.isPartial ? theme.fg("warning", "●") : theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("agent team"))} ${theme.fg("muted", `${details.progress?.turns ?? details.result?.members.reduce((sum, member) => sum + member.turns, 0) ?? 0} turns`)}`,
      ...details.members.map((member) => {
        const state: TeamMemberState = finished.has(member.id)
          ? "finished"
          : (details.progress?.states[member.id] ?? "idle");
        return `${memberStateVisual(state, theme)} ${theme.fg("text", member.name)} ${theme.fg("dim", `(${member.id}) · ${state}`)}`;
      }),
      "",
    ];

    const visibleIndices = options.expanded
      ? [...details.activities.keys()]
      : selectChatIndices(details.activities);
    if (!options.expanded && details.activities.length > visibleIndices.length)
      lines.push(
        theme.fg(
          "muted",
          `──────── chat · ${details.activities.length - visibleIndices.length} earlier events (expand for all) ────────`,
        ),
      );
    else lines.push(theme.fg("muted", "──────────────────── team chat ────────────────────"));

    if (!visibleIndices.length) lines.push(theme.fg("muted", "  Waiting for the first message…"));
    for (const index of visibleIndices) {
      const row = this.rows[index];
      if (!row) continue;
      lines.push(...row.render(width));
      if (details.activities[index].kind === "message" || details.activities[index].kind === "finish") lines.push("");
    }

    if (details.result)
      lines.push(
        "",
        theme.fg(
          // Only a genuine `completed` settlement reads as success. Prior
          // code also colored `errored-members-remain` green because it's a
          // *stable* terminal state (unlike `no-runnable-members`) — but
          // stable isn't the same as successful: real members errored out,
          // and green next to that reads as "the run went fine."
          details.result.settlement.kind === "completed" ? "success" : "warning",
          `Runtime status: ${details.result.settlement.kind} (${details.result.settlement.meaning}; objective correctness is not verified)`,
        ),
      );
    return lines;
  }
}

export function selectChatIndices(activities: readonly TeamActivity[]): number[] {
  const meaningful = activities
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind !== "wake" && item.kind !== "wait");
  return meaningful.slice(-14).map(({ index }) => index);
}

function memberStateVisual(state: TeamMemberState, theme: Theme): string {
  if (state === "finished") return theme.fg("success", "✓");
  if (state === "errored") return theme.fg("error", "✗");
  if (state === "running") return theme.fg("warning", "◉");
  if (state === "ready") return theme.fg("accent", "→");
  if (state === "waiting") return theme.fg("muted", "…");
  return theme.fg("dim", "○");
}
