import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { TeamActivity, TeamMemberState } from "./domain.js";
import type { TeamDisplayDetails } from "./team-chat-view.js";

const ESC = "\x1b";

const MEMBER_PALETTE = [39, 78, 141, 173, 175, 179, 203, 208, 213, 75, 222, 114] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

function accentCode(memberId: string): number {
  return MEMBER_PALETTE[hashString(memberId) % MEMBER_PALETTE.length];
}

type Role = "speaking" | "addressed" | "finished" | "errored" | "idle";

/**
 * The most recent directed message worth glowing over. CLAIM_REJECTED
 * notices are excluded on purpose: the recipient lost the contention and is
 * not about to speak, so lighting them up would read as "many people
 * fighting for the floor" instead of "one person about to talk."
 */
function lastDirectedMessage(activities: readonly TeamActivity[]): TeamActivity | undefined {
  for (let index = activities.length - 1; index >= 0; index--) {
    const item = activities[index];
    if (item.kind !== "message" || item.channel.kind === "public") continue;
    if (item.memberId === "runtime" && (item.body ?? item.text).startsWith("CLAIM_REJECTED")) continue;
    return item;
  }
  return undefined;
}

/**
 * The last message actually spoken by a team member. Runtime broadcasts
 * (CLAIM_RELEASED, MEMBER_ERRORED, ...) are also posted as kind "message" —
 * they must be skipped here, not just fail to match a speaker, or the most
 * recent runtime notice silently suppresses the bubble entirely.
 */
function lastMemberMessage(
  details: TeamDisplayDetails,
): { activity: TeamActivity; member: { id: string; name: string } } | undefined {
  for (let index = details.activities.length - 1; index >= 0; index--) {
    const item = details.activities[index];
    if (item.kind !== "message") continue;
    const member = details.members.find((candidate) => candidate.id === item.memberId);
    if (member) return { activity: item, member };
  }
  return undefined;
}

/** A speech bubble for the most recent utterance, sitting above the roster. */
function renderBubble(
  activity: TeamActivity | undefined,
  member: { id: string; name: string } | undefined,
  theme: Theme,
  width: number,
): string[] {
  if (!activity || !member) return [];
  const bubbleWidth = Math.max(20, Math.min(width, 64));
  const innerWidth = bubbleWidth - 4;
  const code = accentCode(member.id);
  const color = (text: string) => `${ESC}[38;5;${code}m${text}${ESC}[39m`;
  const title = theme.bold(member.name);
  const dashes = Math.max(1, bubbleWidth - 5 - visibleWidth(member.name));
  const top = color(`╭─ ${title} ${"─".repeat(dashes)}╮`);
  const bottom = color(`╰${"─".repeat(bubbleWidth - 2)}╯`);
  const bodyLines = wrapTextWithAnsi(theme.fg("text", activity.body ?? activity.text), innerWidth);
  const capped = bodyLines.slice(0, 3);
  if (bodyLines.length > capped.length) capped[capped.length - 1] = `${capped[capped.length - 1]}…`;
  const middle = capped.map((line) => {
    const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
    return `${color("│")} ${line}${pad} ${color("│")}`;
  });
  return [top, ...middle, bottom];
}

/**
 * Discord-style presence roster: who's actively speaking glows bright, who
 * they last addressed stays lit a shade dimmer, everyone else fades. This is
 * the end-user view — the verbose blow-by-blow narration lives in the
 * tool-result card (TeamChatView) for debugging, not here.
 */
function classify(details: TeamDisplayDetails): Map<string, Role> {
  const roles = new Map<string, Role>();
  const states: Readonly<Record<string, TeamMemberState>> = details.progress?.states ?? {};
  const directed = lastDirectedMessage(details.activities);
  for (const member of details.members) {
    const state = states[member.id] ?? "idle";
    if (state === "running") roles.set(member.id, "speaking");
    else if (state === "finished") roles.set(member.id, "finished");
    else if (state === "errored") roles.set(member.id, "errored");
    else roles.set(member.id, "idle");
  }
  if (directed) {
    const involved = [directed.memberId, ...directed.targetIds];
    for (const id of involved) if (roles.get(id) === "idle") roles.set(id, "addressed");
  }
  return roles;
}

function chip(member: { id: string; name: string }, role: Role, theme: Theme): string {
  const code = accentCode(member.id);
  const bright = (text: string) => `${ESC}[38;5;${code}m${text}${ESC}[39m`;
  if (role === "speaking") return `${bright(theme.bold(`◉ ${member.name}`))}`;
  if (role === "addressed") return bright(`○ ${member.name}`);
  if (role === "finished") return theme.fg("dim", `✓ ${member.name}`);
  if (role === "errored") return theme.fg("error", `✗ ${member.name}`);
  return theme.fg("dim", `· ${member.name}`);
}

export class TeamRosterWidget implements Component {
  private details: TeamDisplayDetails = { members: [], activities: [] };

  constructor(private theme: Theme) {}

  update(details: TeamDisplayDetails, theme: Theme): void {
    this.details = details;
    this.theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { details, theme } = this;
    if (!details.members.length) return [];
    const roles = classify(details);
    const line = details.members.map((member) => chip(member, roles.get(member.id) ?? "idle", theme)).join("   ");
    const turns = details.progress?.turns ?? 0;
    const finished = details.progress?.finished.length ?? 0;
    const header = theme.fg(
      "muted",
      `agent team · ${finished}/${details.members.length} finished · ${turns} turns`,
    );
    const spoken = lastMemberMessage(details);
    const bubble = renderBubble(spoken?.activity, spoken?.member, theme, Math.max(1, width));
    return [
      header,
      ...bubble,
      ...wrapTextWithAnsi(line, Math.max(1, width)),
    ];
  }
}
