import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TeamActivity, TeamProgress } from "../src/domain.js";
import { TeamRosterWidget } from "../src/team-roster-widget.js";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const members = [
  { id: "a", name: "Alice" },
  { id: "b", name: "Bob" },
  { id: "c", name: "Cara" },
  { id: "d", name: "Dee" },
];

function progress(states: Record<string, TeamProgress["states"][string]>): TeamProgress {
  return {
    teamId: "t",
    active: [],
    finished: Object.entries(states)
      .filter(([, state]) => state === "finished")
      .map(([id]) => id),
    states,
    queuedMessages: 0,
    turns: 3,
    recent: "",
  };
}

function directedMessage(from: string, to: string): TeamActivity {
  return {
    sequence: 1,
    memberId: from,
    kind: "message",
    text: "hi",
    visibility: "restricted",
    channel: { kind: "direct", memberId: to },
    targetIds: [to],
  };
}

test("the running member glows brightest, its last DM target stays lit, the rest fade", () => {
  const widget = new TeamRosterWidget(fakeTheme);
  widget.update(
    {
      members,
      activities: [directedMessage("a", "b")],
      progress: progress({ a: "running", b: "waiting", c: "waiting", d: "waiting" }),
    },
    fakeTheme,
  );
  const rendered = widget.render(80).join("\n");
  assert.ok(rendered.includes("◉ Alice"), "running member gets the speaking glyph");
  assert.ok(rendered.includes("○ Bob"), "the DM target is marked addressed");
  assert.ok(rendered.includes("· Cara"), "uninvolved member stays idle");
  assert.ok(rendered.includes("· Dee"), "uninvolved member stays idle");
});

function runtimeDirect(to: string, body: string): TeamActivity {
  return {
    sequence: 1,
    memberId: "runtime",
    kind: "message",
    text: body,
    body,
    visibility: "restricted",
    channel: { kind: "direct", memberId: to },
    targetIds: [to],
  };
}

test("claim contention: rejected bidders stay dim, only the winner lights up", () => {
  const widget = new TeamRosterWidget(fakeTheme);
  widget.update(
    {
      members,
      activities: [
        runtimeDirect("a", 'CLAIM_ACQUIRED resource="number-2" owner=a'),
        runtimeDirect("b", 'CLAIM_REJECTED resource="number-2" owner=a'),
        runtimeDirect("c", 'CLAIM_REJECTED resource="number-2" owner=a'),
        runtimeDirect("d", 'CLAIM_REJECTED resource="number-2" owner=a'),
      ],
      progress: progress({ a: "waiting", b: "waiting", c: "waiting", d: "waiting" }),
    },
    fakeTheme,
  );
  const rendered = widget.render(80).join("\n");
  assert.ok(rendered.includes("○ Alice"), "the claim winner is addressed");
  assert.ok(rendered.includes("· Bob"), "a rejected bidder stays idle, not addressed");
  assert.ok(rendered.includes("· Cara"), "a rejected bidder stays idle, not addressed");
  assert.ok(rendered.includes("· Dee"), "a rejected bidder stays idle, not addressed");
});

test("public speech does not mark every member as addressed", () => {
  const widget = new TeamRosterWidget(fakeTheme);
  widget.update(
    {
      members,
      activities: [
        {
          sequence: 1,
          memberId: "a",
          kind: "message",
          text: "hi all",
          visibility: "public",
          channel: { kind: "public" },
          targetIds: ["b", "c", "d"],
        },
      ],
      progress: progress({ a: "waiting", b: "waiting", c: "waiting", d: "waiting" }),
    },
    fakeTheme,
  );
  const rendered = widget.render(80).join("\n");
  assert.equal(rendered.includes("○ Bob"), false);
  assert.equal(rendered.includes("○ Cara"), false);
  assert.ok(rendered.includes("· Bob"));
});

test("a speech bubble shows the most recent utterance above the roster", () => {
  const widget = new TeamRosterWidget(fakeTheme);
  widget.update(
    {
      members,
      activities: [
        {
          sequence: 1,
          memberId: "b",
          kind: "message",
          text: "hello there",
          body: "hello there",
          visibility: "public",
          channel: { kind: "public" },
          targetIds: ["a", "c", "d"],
        },
      ],
      progress: progress({ a: "waiting", b: "waiting", c: "waiting", d: "waiting" }),
    },
    fakeTheme,
  );
  const lines = widget.render(80);
  const bubbleIndex = lines.findIndex((line) => line.includes("Bob"));
  assert.notEqual(bubbleIndex, -1, "bubble header names the last speaker");
  assert.ok(lines.some((line) => line.includes("hello there")));
  const rosterIndex = lines.findIndex((line) => line.includes("· Bob"));
  assert.ok(rosterIndex > bubbleIndex, "bubble renders above the roster row");
});

test("a trailing runtime broadcast does not suppress the bubble for the last real utterance", () => {
  const widget = new TeamRosterWidget(fakeTheme);
  widget.update(
    {
      members,
      activities: [
        {
          sequence: 1,
          memberId: "b",
          kind: "message",
          text: "3",
          body: "3",
          visibility: "public",
          channel: { kind: "public" },
          targetIds: ["a", "c", "d"],
        },
        { sequence: 2, memberId: "b", kind: "finish", text: "done", visibility: "public", channel: { kind: "public" }, targetIds: [] },
        {
          sequence: 3,
          memberId: "runtime",
          kind: "message",
          text: 'CLAIM_RELEASED resource="number-3" former=b reason=member-finished',
          visibility: "public",
          channel: { kind: "public" },
          targetIds: ["a", "c", "d"],
        },
      ],
      progress: progress({ a: "waiting", b: "finished", c: "waiting", d: "waiting" }),
    },
    fakeTheme,
  );
  const lines = widget.render(80).join("\n");
  assert.ok(lines.includes("Bob"), "bubble still names the last real speaker, not the runtime broadcast");
  assert.ok(lines.includes("3"));
  assert.equal(lines.includes("CLAIM_RELEASED"), false);
});

test("no bubble is rendered before anyone has spoken", () => {
  const widget = new TeamRosterWidget(fakeTheme);
  widget.update({ members, activities: [], progress: progress({}) }, fakeTheme);
  const lines = widget.render(80);
  assert.equal(lines.some((line) => line.includes("╭─")), false);
});

test("finished and errored members render with their own glyphs regardless of past addressing", () => {
  const widget = new TeamRosterWidget(fakeTheme);
  widget.update(
    {
      members,
      activities: [directedMessage("a", "b")],
      progress: progress({ a: "waiting", b: "finished", c: "errored", d: "waiting" }),
    },
    fakeTheme,
  );
  const rendered = widget.render(80).join("\n");
  assert.ok(rendered.includes("✓ Bob"));
  assert.ok(rendered.includes("✗ Cara"));
});
