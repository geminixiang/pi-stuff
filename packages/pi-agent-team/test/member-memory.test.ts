import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  TeamAgent,
  TeamCommand,
  TeamMember,
  TeamReflectionContext,
} from "../src/domain.js";
import {
  parseReflection,
  reflectionPrompt,
  saveProposedLesson,
} from "../src/member-memory.js";
import { TeamRuntime } from "../src/runtime.js";

const wire = [
  "Filename: when-claim-is-unverified-then-check-evidence.md",
  "Trigger: A key claim has not been checked.",
  "Lesson: Check public evidence before relying on the claim.",
  "Why: I accepted it immediately, the decision failed, and verification would prevent recurrence.",
].join("\n");

test("reflection wire owns confidence in code and tolerates legacy confidence: high metadata", async () => {
  const draft = parseReflection(`---\nconfidence: high\nstatus: proposed\n---\n${wire}`);
  if (draft === "no-lesson") assert.fail("expected a lesson draft");
  const cwd = await mkdtemp(join(tmpdir(), "pi-agent-team-reflection-"));
  const path = await saveProposedLesson(cwd, "member", "session-1", undefined, draft);
  const lesson = await readFile(join(cwd, path), "utf8");
  assert.match(lesson, /confidence: 0\.6/);
  assert.doesNotMatch(lesson, /confidence: high/);
  assert.match(lesson, /status: proposed/);
});

test("reflection prompt enforces personal action-outcome learning and includes final public outcome", () => {
  const prompt = reflectionPrompt({
    settlement: { kind: "completed", meaning: "all-members-finished" },
    report: { reporterId: "judge", body: "The report succeeded after claim release." },
  });
  assert.match(prompt, /YOUR OWN controllable action or inaction/);
  assert.match(prompt, /observable outcome/);
  assert.match(prompt, /better response next time/);
  assert.match(prompt, /Do not infer lessons from runtime\/control-plane noise/);
  assert.match(prompt, /The report succeeded after claim release/);
  assert.match(prompt, /Never include private messages/);
  assert.match(prompt, /NO_LESSON/);
  assert.doesNotMatch(prompt, /confidence:/i);
});

class ReflectingAgent implements TeamAgent {
  readonly sessionId: string;
  context?: TeamReflectionContext;
  constructor(
    readonly member: TeamMember,
  private readonly reflection: "no-lesson" | { path?: string } | Error,
    private readonly reportBody?: string,
    private readonly expectedPublicReport?: string,
  ) {
    this.sessionId = `s-${member.id}`;
  }
  async act(): Promise<readonly TeamCommand[]> {
    return [{ type: "finish", summary: "done" }];
  }
  async report(): Promise<string> {
    if (this.reportBody === undefined) throw new Error("not reporter");
    return this.reportBody;
  }
  async reflect(context: TeamReflectionContext): Promise<"no-lesson" | { path?: string }> {
    this.context = context;
    if (this.expectedPublicReport !== undefined && context.report?.body !== this.expectedPublicReport)
      throw new Error("reflection ran before the final report was available");
    if (this.reflection instanceof Error) throw this.reflection;
    return this.reflection;
  }
}

test("all ten reflection outcomes are visible, malformed reflection does not replace a successful report", async () => {
  const agents = Array.from({ length: 10 }, (_, index) =>
    new ReflectingAgent(
      { id: `m${index}`, name: `Member ${index}` },
      index === 8
        ? Object.assign(new Error("bad body: SECRET MUST NOT LEAK\nmore"), {
            code: "invalid-reflection-format",
          })
        : index === 9
          ? { path: `.pi/agents/m9/memory/lessons/${wire.split("\n")[0].slice(10)}` }
          : "no-lesson",
      index === 0 ? "FINAL REPORT SUCCEEDED" : undefined,
      "FINAL REPORT SUCCEEDED",
    ),
  );
  const result = await new TeamRuntime(
    "work",
    new Map(agents.map((agent) => [agent.member.id, agent])),
    { reporterId: "m0" },
  ).run({ channel: { kind: "public" }, body: "go" });
  assert.equal(result.report?.body, "FINAL REPORT SUCCEEDED");
  assert.equal(result.members.length, 10);
  assert.equal(result.members.filter((member) => member.reflection.status === "no-lesson").length, 8);
  assert.equal(result.members.find((member) => member.id === "m9")?.reflection.status, "submitted");
  const failed = result.members.find((member) => member.id === "m8")?.reflection;
  assert.equal(failed?.status, "failed");
  if (failed?.status === "failed") {
    assert.equal(failed.code, "invalid-reflection-format");
    assert.equal(failed.error, "Reflection output did not match the required format");
    assert.doesNotMatch(failed.error, /SECRET/);
  }
  for (const agent of agents) {
    assert.equal(agent.context?.report?.body, "FINAL REPORT SUCCEEDED");
  }
});
