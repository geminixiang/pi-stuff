import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TeamActivity, TeamResult, TeamSettlement } from "../src/domain.js";
import { selectChatIndices, TeamChatView } from "../src/team-chat-view.js";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const colorTaggingTheme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
  bold: (text: string) => text,
} as unknown as Theme;

function fakeResult(settlement: TeamSettlement): TeamResult {
  return {
    teamId: "t",
    settlement,
    objectiveVerification: "unverified",
    members: [],
    publicTranscript: [],
    restrictedMessages: [],
    events: [],
    userInterventions: 0,
    auditHead: "0".repeat(64),
  };
}

function activity(overrides: Partial<TeamActivity> & { sequence: number }): TeamActivity {
  return {
    memberId: "a",
    kind: "message",
    text: "hi",
    visibility: "public",
    channel: { kind: "public" },
    targetIds: [],
    body: "hi",
    ...overrides,
  };
}

test("selectChatIndices drops wake/wait noise and keeps the last 14 meaningful indices", () => {
  const activities = [
    ...Array.from({ length: 20 }, (_, index) => activity({ sequence: index, kind: "message" })),
    activity({ sequence: 20, kind: "wake" }),
    activity({ sequence: 21, kind: "wait" }),
  ];
  const indices = selectChatIndices(activities);
  assert.equal(indices.length, 14);
  assert.deepEqual(indices, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
});

test("every rendered line fits the terminal when a public message mentions a large CJK team", () => {
  const view = new TeamChatView(fakeTheme);
  const members = [
    { id: "conan", name: "江戶川柯南" },
    { id: "ran", name: "毛利蘭" },
    { id: "ai", name: "灰原哀" },
    { id: "heiji", name: "服部平次" },
    { id: "kazuha", name: "遠山和葉" },
    { id: "kogoro", name: "毛利小五郎" },
    { id: "ayumi", name: "吉田步美" },
    { id: "mitsuhiko", name: "圓谷光彥" },
    { id: "genta", name: "小島元太" },
    { id: "megure", name: "目暮警官" },
  ];
  const mentions = members.slice(1).map((member) => member.id);
  const activities = [
    activity({
      sequence: 0,
      memberId: "conan",
      mentions,
      text: "現在開始狼人殺",
      body: "現在開始狼人殺",
      targetIds: mentions,
    }),
  ];
  view.update({ members, activities }, { expanded: true, isPartial: true }, fakeTheme);

  const width = 154;
  const lines = view.render(width);
  assert.ok(
    lines.every((line) => visibleWidth(line) <= width),
    `rendered widths: ${lines.map(visibleWidth).join(", ")}`,
  );
});

test("every rendered line fits for long agent-authored content and unbroken text", () => {
  const view = new TeamChatView(fakeTheme);
  const members = [{ id: "conan", name: "江戶川柯南" }];
  const longContent = `這是一段很長的發言。${"UNBROKEN_AGENT_CONTENT".repeat(20)}`;
  const activities = [
    activity({
      sequence: 0,
      memberId: "conan",
      text: longContent,
      body: longContent,
    }),
  ];
  view.update({ members, activities }, { expanded: true, isPartial: true }, fakeTheme);

  for (const width of [20, 40, 80, 154]) {
    const lines = view.render(width);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      `width ${width}; rendered widths: ${lines.map(visibleWidth).join(", ")}`,
    );
  }
});

test("TeamChatView renders new activity incrementally without re-processing history", () => {
  const view = new TeamChatView(fakeTheme);
  const members = [{ id: "a", name: "Alice" }];
  const first = [activity({ sequence: 0, text: "hello", body: "hello" })];
  view.update({ members, activities: first }, { expanded: true, isPartial: true }, fakeTheme);
  const firstRender = view.render(80).join("\n");
  assert.ok(firstRender.includes("hello"));

  const second = [...first, activity({ sequence: 1, text: "world", body: "world" })];
  view.update({ members, activities: second }, { expanded: true, isPartial: true }, fakeTheme);
  const secondRender = view.render(80).join("\n");
  assert.ok(secondRender.includes("hello"));
  assert.ok(secondRender.includes("world"));

  // Re-syncing the same activity list must not duplicate rows.
  view.update({ members, activities: second }, { expanded: true, isPartial: false }, fakeTheme);
  const thirdRender = view.render(80).join("\n");
  assert.equal(thirdRender.split("world").length - 1, 1);
});

test("only a completed settlement renders the runtime status line in success color", () => {
  const members = [{ id: "a", name: "Alice" }];
  const activities = [activity({ sequence: 0 })];

  const completed = new TeamChatView(colorTaggingTheme);
  completed.update(
    { members, activities, result: fakeResult({ kind: "completed", meaning: "all-members-finished" }) },
    { expanded: false, isPartial: false },
    colorTaggingTheme,
  );
  assert.match(completed.render(80).join("\n"), /\[success\]Runtime status: completed/);

  // Before this fix, "errored-members-remain" — a settlement that only
  // exists because real members errored out — rendered in the same green
  // as a genuine completion, just because it's a *stable* terminal state
  // rather than a possibly-stuck one. Stable isn't the same as successful.
  const erroredQuiescent = new TeamChatView(colorTaggingTheme);
  erroredQuiescent.update(
    { members, activities, result: fakeResult({ kind: "quiescent", meaning: "errored-members-remain" }) },
    { expanded: false, isPartial: false },
    colorTaggingTheme,
  );
  assert.match(
    erroredQuiescent.render(80).join("\n"),
    /\[warning\]Runtime status: quiescent \(errored-members-remain/,
  );

  const exhausted = new TeamChatView(colorTaggingTheme);
  exhausted.update(
    { members, activities, result: fakeResult({ kind: "exhausted", meaning: "max-turns-reached" }) },
    { expanded: false, isPartial: false },
    colorTaggingTheme,
  );
  assert.match(exhausted.render(80).join("\n"), /\[warning\]Runtime status: exhausted/);
});

test("TeamChatView invalidates and rebuilds rows when the theme instance changes", () => {
  const view = new TeamChatView(fakeTheme);
  const members = [{ id: "a", name: "Alice" }];
  const activities = [activity({ sequence: 0, text: "hello", body: "hello" })];
  view.update({ members, activities }, { expanded: true, isPartial: false }, fakeTheme);
  view.render(80);

  const otherTheme = {
    fg: (_color: string, text: string) => `[${text}]`,
    bold: (text: string) => text,
  } as unknown as Theme;
  view.update({ members, activities }, { expanded: true, isPartial: false }, otherTheme);
  const rendered = view.render(80).join("\n");
  assert.ok(rendered.includes("hello"));
});

test("a direct-channel tag names the recipient, not just their opaque id", () => {
  const view = new TeamChatView(fakeTheme);
  const members = [
    { id: "mango", name: "小芒" },
    { id: "cedar", name: "小杉" },
  ];
  const activities = [
    activity({
      sequence: 0,
      memberId: "mango",
      visibility: "restricted",
      channel: { kind: "direct", memberId: "cedar" },
      text: "psst",
      body: "psst",
    }),
  ];
  view.update({ members, activities }, { expanded: true, isPartial: true }, fakeTheme);
  assert.ok(
    view.render(80).join("\n").includes("@ 小杉 (cedar)"),
    "the DM tag reads as a person, matching the speaker's own name (id) header",
  );
});

test("a public say with mentions shows who it hands the floor to", () => {
  const view = new TeamChatView(fakeTheme);
  const members = [
    { id: "mango", name: "小芒" },
    { id: "cedar", name: "小杉" },
  ];
  const activities = [
    activity({
      sequence: 0,
      memberId: "cedar",
      channel: { kind: "public" },
      mentions: ["mango"],
      text: "your turn",
      body: "your turn",
    }),
  ];
  view.update({ members, activities }, { expanded: true, isPartial: true }, fakeTheme);
  assert.ok(view.render(80).join("\n").includes("# everyone → 小芒 (mango)"));
});
