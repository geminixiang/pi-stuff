import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TeamActivity } from "../src/domain.js";
import { selectChatIndices, TeamChatView } from "../src/team-chat-view.js";

const fakeTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

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
