import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type { MemberId, TeamReflectionContext } from "./domain.js";

const LESSON_FILENAME = /^when-[a-z0-9]+(?:-[a-z0-9]+)*-then-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const MEMORY_MEMBER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DEFAULT_CONFIDENCE = 0.6;

export class ReflectionFormatError extends Error {
  readonly code = "invalid-reflection-format";
}

export interface LessonDraft {
  filename: string;
  trigger: string;
  lesson: string;
  why: string;
  evidence?: string;
}

export function reflectionPrompt(context: TeamReflectionContext): string {
  const publicOutcome = context.report
    ? `FINAL PUBLIC REPORT:\n${context.report.body}`
    : `FINAL REPORT OUTCOME: no report was produced${context.reportError ? ` (${context.reportError})` : ""}.`;
  return [
    `TEAM SETTLEMENT: ${context.settlement.kind} (${context.settlement.meaning}).`,
    publicOutcome,
    "Reflect only on a reliable, reusable lesson from YOUR OWN controllable action or inaction in this run: identify that action, its observable outcome, and a better response next time.",
    "Do not infer lessons from runtime/control-plane noise (claims, releases, scheduling, tool notices) unless your own controllable use of it actually caused the task to fail. Do not restate existing system doctrine.",
    "Never include private messages, hidden roles, credentials, or facts that were not made public. The final public report above may be used as outcome evidence; your private session may inform reflection but must not be copied into memory.",
    "If there is no reliable, generalizable, non-duplicate lesson, reply exactly NO_LESSON.",
    "Otherwise output only this compact wire format; do not add YAML or mechanical metadata:",
    "Filename: when-<critical-situation>-then-<improved-response>.md",
    "Trigger: <when this lesson should be recalled>",
    "Lesson: <the improved action you control>",
    "Why: <your action/inaction -> observable outcome -> why the response improves it>",
    "Evidence: <optional concise public outcome>",
  ].join("\n\n");
}

export function parseReflection(text: string): LessonDraft | "no-lesson" {
  const trimmed = text.trim();
  if (trimmed === "NO_LESSON") return "no-lesson";

  // Accept the new heading-only wire format. Ignoring a legacy YAML prelude
  // also makes old `confidence: high` responses recoverable: confidence is
  // runtime-owned and is deliberately never parsed from model output.
  const body = trimmed.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  const fields = new Map<string, string>();
  let current: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const match = /^(?:#{1,3}\s*)?(Filename|Trigger|Lesson|Why|Evidence|Outcome)\s*:\s*(.*)$/i.exec(line);
    if (match) {
      current = match[1].toLowerCase();
      fields.set(current, match[2].trim());
    } else if (current && line.trim()) {
      fields.set(current, `${fields.get(current)}\n${line.trim()}`);
    }
  }
  const filename = fields.get("filename");
  const trigger = fields.get("trigger");
  const lesson = fields.get("lesson");
  const why = fields.get("why");
  if (!filename || !trigger || !lesson || !why)
    throw new ReflectionFormatError("Reflection must include Filename, Trigger, Lesson, and Why");
  const cleanFilename = basename(filename.replaceAll("`", ""));
  if (cleanFilename !== filename.replaceAll("`", "") || !LESSON_FILENAME.test(cleanFilename))
    throw new ReflectionFormatError("Reflection filename does not match the when-then schema");
  return {
    filename: cleanFilename,
    trigger,
    lesson,
    why,
    evidence: fields.get("evidence") ?? fields.get("outcome"),
  };
}

export async function saveProposedLesson(
  cwd: string,
  memberId: MemberId,
  sessionId: string,
  sessionRef: string | undefined,
  draft: LessonDraft,
): Promise<string> {
  if (!MEMORY_MEMBER_ID.test(memberId))
    throw new ReflectionFormatError("Member id is unsafe for a memory path");
  const lessonsDir = resolve(cwd, ".pi", "agents", memberId, "memory", "lessons");
  const path = resolve(lessonsDir, draft.filename);
  if (!path.startsWith(`${lessonsDir}${sep}`))
    throw new ReflectionFormatError("Lesson path escapes the member memory directory");
  await mkdir(lessonsDir, { recursive: true });
  const now = new Date().toISOString();
  const sourceRef = sessionRef ?? `session:${sessionId}`;
  const content = [
    "---",
    `id: ${randomUUID()}`,
    "kind: lesson",
    "status: proposed",
    `confidence: ${DEFAULT_CONFIDENCE}`,
    `source_session: ${JSON.stringify(sessionId)}`,
    `source_session_ref: ${JSON.stringify(sourceRef)}`,
    `created: ${JSON.stringify(now)}`,
    `last_tested: ${JSON.stringify(now)}`,
    "---",
    "",
    `# ${draft.filename.slice(0, -3).replaceAll("-", " ")}`,
    "",
    "## Trigger",
    "",
    draft.trigger,
    "",
    "## Lesson",
    "",
    draft.lesson,
    "",
    "## Why",
    "",
    draft.why,
    ...(draft.evidence ? ["", "## Evidence", "", draft.evidence] : []),
    "",
    "## Source",
    "",
    `- Pi session: \`${sessionId}\``,
    `- Session reference: \`${sourceRef}\``,
    "",
  ].join("\n");
  let writtenPath = path;
  await writeFile(path, content, { encoding: "utf8", flag: "wx" }).catch(async (cause: unknown) => {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    writtenPath = join(
      lessonsDir,
      draft.filename.replace(/\.md$/, `-${randomUUID().slice(0, 8)}.md`),
    );
    await writeFile(writtenPath, content, "utf8");
  });
  return relative(cwd, writtenPath);
}

export async function loadMemberMemoryPrompt(cwd: string, memberId: MemberId): Promise<string | undefined> {
  if (!MEMORY_MEMBER_ID.test(memberId)) return undefined;
  const roots = [
    join(cwd, ".pi", "agents", memberId),
    join(homedir(), ".pi", "agent", "agents", memberId),
  ];
  for (const root of roots) {
    const sections: string[] = [];
    try {
      sections.push(await readFile(join(root, "AGENTS.md"), "utf8"));
    } catch {}
    try {
      const lessonDir = join(root, "memory", "lessons");
      const names = (await readdir(lessonDir)).filter((name) => LESSON_FILENAME.test(name)).sort();
      for (const name of names.slice(0, 12)) {
        const text = await readFile(join(lessonDir, name), "utf8");
        if (/^status:\s*active\s*$/m.test(text)) sections.push(`Available active lesson \`${name}\`:\n${text}`);
      }
    } catch {}
    if (sections.length) return sections.join("\n\n");
  }
  return undefined;
}
