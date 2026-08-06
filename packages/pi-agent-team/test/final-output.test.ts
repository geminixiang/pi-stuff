import assert from "node:assert/strict";
import test from "node:test";
import type { TeamActivity, TeamResult } from "../src/domain.js";
import { finalDetails, renderFinalContent } from "../src/extension.js";
import type { TeamDisplayDetails } from "../src/team-chat-view.js";

const members = [
  { id: "judge", name: "阿笠博士" },
  { id: "p1", name: "江戶川柯南" },
];

function chattyResult(overrides: Partial<TeamResult> = {}): TeamResult {
  return {
    teamId: "team-1",
    settlement: { kind: "completed", meaning: "all-members-finished" },
    objectiveVerification: "unverified",
    report: { reporterId: "judge", body: "狼人陣營獲勝。完整對局見 report.md。" },
    members: [
      {
        id: "judge",
        sessionId: "s-judge",
        sessionRef: "/sessions/judge.jsonl",
        turns: 39,
        state: "finished",
        summary: "主持完畢",
        reflection: { status: "submitted", path: ".pi/agents/judge/memory/lessons/x.md" },
      },
      {
        id: "p1",
        sessionId: "s-p1",
        sessionRef: "/sessions/p1.jsonl",
        turns: 19,
        state: "finished",
        summary: "查驗了三人",
        reflection: { status: "no-lesson" },
      },
    ],
    publicTranscript: Array.from({ length: 100 }, (_, index) => ({
      id: `m${index}`,
      sequence: index + 1,
      from: "p1",
      body: `TRANSCRIPT-BODY-${index} `.repeat(50),
    })),
    restrictedMessages: [],
    events: [],
    userInterventions: 0,
    auditHead: "a".repeat(64),
    ...overrides,
  };
}

test("final content carries the report and session pointers but never transcript bodies", () => {
  const text = renderFinalContent(chattyResult(), members);
  assert.match(text, /FINAL REPORT — 阿笠博士 \(judge\)/);
  assert.match(text, /狼人陣營獲勝/);
  assert.match(text, /\/sessions\/judge\.jsonl/);
  assert.match(text, /100 public/);
  assert.match(text, /reflection: submitted/);
  assert.match(text, /reflection: no-lesson/);
  assert.doesNotMatch(text, /TRANSCRIPT-BODY/);
  // The whole point: a 100-message game must not re-inflate the parent
  // context. The manifest is pointers and counts, so it stays small even
  // though the raw transcript above is ~250KB.
  assert.ok(text.length < 2_000, `final content unexpectedly large: ${text.length} chars`);
});

test("without a report the content says so honestly and surfaces finish summaries", () => {
  const text = renderFinalContent(chattyResult({ report: undefined }), members);
  assert.match(text, /NO FINAL REPORT: no member was designated or claimed "reporter"/);
  assert.match(text, /finish summary: 查驗了三人/);
});

test("a failed report surfaces its reportError in the content", () => {
  const text = renderFinalContent(
    chattyResult({ report: undefined, reportError: "Reporter judge timed out" }),
    members,
  );
  assert.match(text, /NO FINAL REPORT: Reporter judge timed out/);
});

function activity(sequence: number): TeamActivity {
  return {
    sequence,
    memberId: "p1",
    kind: "message",
    text: `msg ${sequence}`,
    visibility: "public",
    channel: { kind: "public" },
    targetIds: [],
    body: `msg ${sequence}`,
  };
}

test("final details keep a bounded activity suffix and a settlement slice, not the full result", () => {
  const live: TeamDisplayDetails = {
    members,
    activities: Array.from({ length: 500 }, (_, index) => activity(index)),
  };
  const details = finalDetails(live, chattyResult());
  assert.equal(details.activities.length, 200);
  assert.equal(details.activities[0].sequence, 300);
  assert.equal(details.omittedActivities, 300);
  assert.equal(details.result?.settlement.kind, "completed");
  assert.equal(details.result?.report?.reporterId, "judge");
  // The slim settlement slice must not smuggle the transcript back in.
  assert.ok(!("publicTranscript" in (details.result ?? {})));
  assert.doesNotMatch(JSON.stringify(details), /TRANSCRIPT-BODY/);
});

test("small runs are passed through without an omission marker", () => {
  const live: TeamDisplayDetails = {
    members,
    activities: Array.from({ length: 5 }, (_, index) => activity(index)),
  };
  const details = finalDetails(live, chattyResult());
  assert.equal(details.activities.length, 5);
  assert.equal(details.omittedActivities, undefined);
});
