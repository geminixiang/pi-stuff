import {
  defineTool,
  DynamicBorder,
  getSelectListTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { runProgrammaticChecks } from "./checks.js";
import { CODE_SMELL_PROMPT } from "./prompt.js";
import { showFindingSelector } from "./selector.js";
import type { CodeSmellFinding } from "./types.js";

const categorySchema = Type.Union([
  Type.Literal("complexity"),
  Type.Literal("duplication"),
  Type.Literal("coupling"),
  Type.Literal("state"),
  Type.Literal("errors"),
  Type.Literal("performance"),
  Type.Literal("maintainability"),
]);
const severitySchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
const confidenceSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);
const actionSchema = Type.Union([
  Type.Literal("inspect"),
  Type.Literal("delete"),
  Type.Literal("inline"),
  Type.Literal("extract"),
  Type.Literal("refactor"),
  Type.Literal("guard"),
]);

type Target = { paths: string[] };

function parsePaths(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function showPathInput(ctx: ExtensionCommandContext): Promise<Target | null> {
  const result = await ctx.ui.editor(
    "Enter folders/files to scan (space-separated or one per line):",
    ".",
  );
  const paths = parsePaths(result ?? "");
  return paths.length > 0 ? { paths } : null;
}

async function showTargetSelector(ctx: ExtensionCommandContext): Promise<Target | null> {
  const items: SelectItem[] = [
    { value: "repo", label: "Scan repository", description: "Programmatic checks + agent review" },
    { value: "paths", label: "Scan selected paths", description: "Folders/files only" },
  ];

  const result = await ctx.ui.custom<"repo" | "paths" | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    container.addChild(new Text(theme.fg("accent", theme.bold("Select code smell scope"))));
    const selectList = new SelectList(items, 6, getSelectListTheme());
    selectList.onSelect = (item) => done(item.value as "repo" | "paths");
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(
      new Text(
        `${keyHint("tui.select.confirm", "confirm")}  ${keyHint("tui.select.cancel", "cancel")}`,
      ),
    );
    container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (!result) return null;
  if (result === "repo") return { paths: ["."] };
  return showPathInput(ctx);
}

function registerScanTool(pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "code_smell_scan",
      label: "Code Smell Scan",
      description: "Run programmatic code smell checks over repository paths.",
      promptSnippet:
        "Run deterministic checks for debug remnants, commented-out code, duplication, and complex functions",
      promptGuidelines: [
        "Use code_smell_scan before manual code smell review, then verify important findings by reading files.",
      ],
      parameters: Type.Object({
        paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        maxFiles: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const findings = await runProgrammaticChecks({
          cwd: ctx.cwd,
          paths: params.paths ?? ["."],
          maxFiles: params.maxFiles,
        });
        const bySeverity = {
          high: findings.filter((f) => f.severity === "high").length,
          medium: findings.filter((f) => f.severity === "medium").length,
          low: findings.filter((f) => f.severity === "low").length,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${findings.length} programmatic code-smell leads.`,
            },
          ],
          details: { findings, bySeverity },
        };
      },
    }),
  );
}

function registerFindingsTool(
  pi: ExtensionAPI,
  state: {
    getResolver: () => ((findings: CodeSmellFinding[]) => void) | null;
    clearResolver: () => void;
    setLatestFindings: (findings: CodeSmellFinding[]) => void;
  },
) {
  pi.registerTool(
    defineTool({
      name: "code_smell_findings",
      label: "Code Smell Findings",
      description:
        "Return the complete finding list for /code-smell. Use as the final action after analysis.",
      promptSnippet:
        "Return structured code smell findings for /code-smell as a terminating result",
      promptGuidelines: [
        "Use code_smell_findings exactly once as the final action when the /code-smell command asks for findings.",
      ],
      parameters: Type.Object({
        findings: Type.Array(
          Type.Object({
            category: categorySchema,
            severity: severitySchema,
            confidence: confidenceSchema,
            file: Type.String({ minLength: 1, pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$" }),
            lines: Type.String(),
            smell: Type.String({ minLength: 1 }),
            evidence: Type.String({ minLength: 1 }),
            impact: Type.String({ minLength: 1 }),
            recommendation: Type.String({ minLength: 1 }),
            action: actionSchema,
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const findings: CodeSmellFinding[] = params.findings;
        const resolve = state.getResolver();
        if (!resolve) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Ignored code smell findings because no /code-smell analysis is pending.",
              },
            ],
            details: { ignored: true, findings: [] },
            terminate: true,
          };
        }
        state.setLatestFindings(findings);
        state.clearResolver();
        resolve(findings);
        return {
          content: [
            { type: "text" as const, text: `Captured ${findings.length} code smell findings.` },
          ],
          details: { ignored: false, findings },
          terminate: true,
        };
      },
    }),
  );
}

function buildPrompt(target: Target, focus?: string): string {
  let prompt = CODE_SMELL_PROMPT;
  const isRepoRoot = target.paths.length === 1 && target.paths[0] === ".";
  if (!isRepoRoot)
    prompt += `\n\n## Scope\n\nReview only these repository-relative paths: ${target.paths.join(", ")}.`;
  if (focus?.trim()) prompt += `\n\n## Additional Focus\n\n${focus.trim()}`;
  return prompt;
}

async function applyFindings(
  ctx: ExtensionCommandContext,
  selected: CodeSmellFinding[],
  pi: ExtensionAPI,
) {
  if (selected.length === 0) {
    ctx.ui.notify("No code smell findings selected", "info");
    return;
  }

  const prompt = `# Clean Selected Code Smells\n\nApply small, behavior-preserving fixes for these selected findings:\n\n${selected
    .map(
      (f) =>
        `- ${f.file} (${f.lines || "?"}) [${f.action}] ${f.category}/${f.severity}\n  - Smell: ${f.smell}\n  - Evidence: ${f.evidence}\n  - Recommendation: ${f.recommendation}`,
    )
    .join(
      "\n",
    )}\n\nRules:\n1. Read each file before editing.\n2. Keep changes minimal and behavior-preserving.\n3. Skip any item whose fix is ambiguous and report why.\n4. Run relevant tests/type-check/lint after changes.\n5. Report changed files and verification output.`;

  ctx.ui.notify(`Applying ${selected.length} selected code smell fixes`, "info");
  pi.sendUserMessage(prompt);
}

export function registerCodeSmellWorkflow(pi: ExtensionAPI) {
  let resolvePendingTurnStart: (() => void) | null = null;
  let resolvePendingFindingsTool: ((findings: CodeSmellFinding[]) => void) | null = null;
  let latestToolFindings: CodeSmellFinding[] | null = null;

  pi.on("turn_start", () => {
    if (!resolvePendingTurnStart) return;
    const resolve = resolvePendingTurnStart;
    resolvePendingTurnStart = null;
    resolve();
  });

  registerScanTool(pi);
  registerFindingsTool(pi, {
    getResolver: () => resolvePendingFindingsTool,
    clearResolver: () => {
      resolvePendingFindingsTool = null;
    },
    setLatestFindings: (findings) => {
      latestToolFindings = findings;
    },
  });

  pi.registerCommand("code-smell", {
    description:
      "Find code smells with programmatic checks and agent review, then optionally clean them",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Code smell workflow requires interactive mode", "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Cannot run code-smell while agent is busy", "warning");
        return;
      }

      const paths = parsePaths(args);
      let target: Target | null = paths.length > 0 ? { paths } : null;
      if (!target) target = await showTargetSelector(ctx);
      if (!target) {
        ctx.ui.notify("Code smell scan cancelled", "info");
        return;
      }

      latestToolFindings = null;
      const turnStarted = new Promise<void>((r) => {
        resolvePendingTurnStart = r;
      });
      const toolResult = new Promise<CodeSmellFinding[]>((r) => {
        resolvePendingFindingsTool = r;
      });

      ctx.ui.notify(`Analyzing code smells in ${target.paths.join(", ")}`, "info");
      pi.sendUserMessage(buildPrompt(target));

      const started = await Promise.race<boolean>([
        turnStarted.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 10000)),
      ]);
      if (!started) {
        resolvePendingTurnStart = null;
        resolvePendingFindingsTool = null;
        ctx.ui.notify("Analysis did not start within 10 seconds", "warning");
        return;
      }

      await ctx.waitForIdle();
      const findings =
        latestToolFindings ??
        (await Promise.race<CodeSmellFinding[] | null>([
          toolResult,
          new Promise<null>((r) => setTimeout(() => r(null), 100)),
        ]));
      resolvePendingFindingsTool = null;

      if (findings === null) {
        ctx.ui.notify(
          "Could not read findings — model did not call code_smell_findings",
          "warning",
        );
        return;
      }
      if (findings.length === 0) {
        ctx.ui.notify("No code smells found", "info");
        return;
      }

      const selected = await showFindingSelector(ctx, findings);
      if (!selected || selected.length === 0) {
        ctx.ui.notify("Code smell cleanup cancelled", "info");
        return;
      }
      await applyFindings(ctx, selected, pi);
    },
  });
}
