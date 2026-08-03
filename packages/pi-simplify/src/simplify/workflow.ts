import {
  defineTool,
  DynamicBorder,
  keyHint,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { SIMPLIFY_PROMPT } from "./prompt.js";
import { showCandidateSelector } from "./selector.js";
import type { SimplifyResult } from "./types.js";

const categorySchema = Type.Union([
  Type.Literal("reuse"),
  Type.Literal("quality"),
  Type.Literal("efficiency"),
]);
const riskSchema = Type.Union([
  Type.Literal("safe"),
  Type.Literal("confirm"),
  Type.Literal("review"),
]);
const actionSchema = Type.Union([
  Type.Literal("delete"),
  Type.Literal("inline"),
  Type.Literal("refactor"),
  Type.Literal("parallelize"),
]);

type SimplifyTarget =
  | { type: "uncommitted" }
  | { type: "previous-commit" }
  | { type: "folder"; paths: string[] };
type ParsedArgs = {
  target: SimplifyTarget | null;
  additionalFocus?: string;
  error?: string;
};

const SIMPLIFY_PRESETS = [
  { value: "uncommitted", label: "Simplify uncommitted changes", description: "" },
  {
    value: "previous-commit",
    label: "Simplify previous commit",
    description: "(diff: HEAD~1..HEAD)",
  },
  { value: "folder", label: "Simplify a folder (or more)", description: "(snapshot, not diff)" },
] as const;

type SimplifyPresetValue = (typeof SIMPLIFY_PRESETS)[number]["value"];

function parseSimplifyPaths(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseArgs(args: string): ParsedArgs {
  const trimmed = args.trim();
  if (!trimmed) return { target: null };

  const [subcommand, ...rest] = trimmed.split(/\s+/);
  const normalizedSubcommand = subcommand?.toLowerCase();

  if (normalizedSubcommand === "folder") {
    const paths = parseSimplifyPaths(rest.join(" "));
    if (paths.length === 0)
      return { target: null, error: "Usage: /simplify folder <path> [path...]" };
    return { target: { type: "folder", paths } };
  }

  if (
    normalizedSubcommand === "previous" ||
    normalizedSubcommand === "previous-commit" ||
    normalizedSubcommand === "prev" ||
    normalizedSubcommand === "last-commit"
  ) {
    return { target: { type: "previous-commit" }, additionalFocus: rest.join(" ") || undefined };
  }

  return { target: { type: "uncommitted" }, additionalFocus: trimmed };
}

async function hasUncommittedChanges(pi: ExtensionAPI): Promise<boolean> {
  const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
  return code === 0 && stdout.trim().length > 0;
}

async function hasPreviousCommit(pi: ExtensionAPI): Promise<boolean> {
  const { code } = await pi.exec("git", ["rev-parse", "--verify", "HEAD~1"]);
  return code === 0;
}

function buildSimplifyPrompt(target: SimplifyTarget, additionalFocus?: string): string {
  let fullPrompt = SIMPLIFY_PROMPT;

  if (target.type === "folder") {
    fullPrompt += `\n\n## Scope Override: Folder Snapshot\n\nReview only the code in these repository-relative paths: ${target.paths.join(", ")}\n\nThis is a snapshot review, not a git diff review. Read files directly under these paths instead of relying on \`git diff\`. Only return candidates whose \`file\` is inside one of these paths.`;
  }

  if (target.type === "previous-commit") {
    fullPrompt +=
      "\n\n## Scope Override: Previous Commit\n\nReview the previous commit only. Run `git diff HEAD~1..HEAD` to see what changed in the last commit, and treat that diff as the review scope. Do not use uncommitted changes as the analysis target. Only return candidates caused by the previous commit's diff.";
  }

  if (additionalFocus?.trim()) fullPrompt += `\n\n## Additional Focus\n\n${additionalFocus.trim()}`;
  return fullPrompt;
}

function registerSimplifyCandidatesTool(
  pi: ExtensionAPI,
  state: {
    getResolver: () => ((candidates: SimplifyResult[]) => void) | null;
    clearResolver: () => void;
    setLatestCandidates: (candidates: SimplifyResult[]) => void;
  },
) {
  const parameters = Type.Object({
    candidates: Type.Array(
      Type.Object({
        category: categorySchema,
        risk: riskSchema,
        file: Type.String({
          description: "Repository-relative path",
          minLength: 1,
          pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
        }),
        lines: Type.String({ description: "Line number or range, or empty string if unknown" }),
        rootIssue: Type.String({
          description:
            "The root problem with the current code. For reuse, name the existing symbol + file it duplicates. State the underlying flaw, not the fix.",
          minLength: 1,
        }),
        consequence: Type.String({
          description:
            "What this problem leads to if left unchanged (e.g. divergent implementations, N+1 queries on every request, untested duplicate logic). If there is no real consequence, do not flag it.",
          minLength: 1,
        }),
        benefit: Type.String({
          description:
            "The concrete advantage after applying the fix (e.g. single source of truth, -14 lines, one query instead of N, covered by existing tests).",
          minLength: 1,
        }),
        action: actionSchema,
      }),
    ),
  });

  pi.registerTool(
    defineTool({
      name: "simplify_candidates",
      label: "Simplify Candidates",
      description:
        "Return the complete candidate list for /simplify. Use as the final action after analyzing changed code.",
      promptSnippet: "Return structured cleanup candidates for /simplify as a terminating result",
      promptGuidelines: [
        "Use simplify_candidates exactly once as the final action when the /simplify command asks for cleanup candidates.",
      ],
      parameters,
      async execute(_toolCallId, params) {
        const candidates: SimplifyResult[] = params.candidates;
        const resolve = state.getResolver();
        if (!resolve) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Ignored simplify candidates because no /simplify analysis is pending.",
              },
            ],
            details: {
              ignored: true,
              candidates: [],
              byRisk: { safe: 0, confirm: 0, review: 0 },
            },
            terminate: true,
          };
        }

        state.setLatestCandidates(candidates);
        state.clearResolver();
        resolve(candidates);

        const byRisk = {
          safe: candidates.filter((c) => c.risk === "safe").length,
          confirm: candidates.filter((c) => c.risk === "confirm").length,
          review: candidates.filter((c) => c.risk === "review").length,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `Captured ${candidates.length} simplify candidates (${byRisk.safe} safe, ${byRisk.confirm} confirm, ${byRisk.review} review).`,
            },
          ],
          details: { ignored: false, candidates, byRisk },
          terminate: true,
        };
      },
    }),
  );
}

async function showFolderInput(ctx: ExtensionCommandContext): Promise<SimplifyTarget | null> {
  const result = await ctx.ui.editor(
    "Enter folders/files to simplify (space-separated or one per line):",
    ".",
  );

  if (!result?.trim()) return null;
  const paths = parseSimplifyPaths(result);
  if (paths.length === 0) return null;

  return { type: "folder", paths };
}

async function showSimplifyTargetSelector(
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<SimplifyTarget | null> {
  const presetItems: SelectItem[] = SIMPLIFY_PRESETS.map((preset) => ({
    value: preset.value,
    label: preset.label,
    description: preset.description,
  }));
  const smartDefault = (await hasUncommittedChanges(pi)) ? "uncommitted" : "folder";
  const smartDefaultIndex = presetItems.findIndex((item) => item.value === smartDefault);

  while (true) {
    const result = await ctx.ui.custom<SimplifyPresetValue | null>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
      container.addChild(new Text(theme.fg("accent", theme.bold("Select a simplify preset"))));

      const selectList = new SelectList(presetItems, Math.min(presetItems.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });

      if (smartDefaultIndex >= 0) selectList.setSelectedIndex(smartDefaultIndex);
      selectList.onSelect = (item) => done(item.value as SimplifyPresetValue);
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
    if (result === "uncommitted") return { type: "uncommitted" };
    if (result === "previous-commit") return { type: "previous-commit" };

    const target = await showFolderInput(ctx);
    if (target) return target;
  }
}

async function applyFindings(
  ctx: ExtensionCommandContext,
  selected: SimplifyResult[],
  pi: ExtensionAPI,
) {
  if (selected.length === 0) {
    ctx.ui.notify("No findings selected to apply", "info");
    return;
  }

  const safeItems = selected.filter((c) => c.risk === "safe");
  const confirmItems = selected.filter((c) => c.risk === "confirm");

  const cleanupPrompt = `# Apply Review Findings

Apply the following findings. Each item includes a bracketed action (e.g. \`[delete]\`, \`[refactor]\`, \`[parallelize]\`, \`[inline]\`) — follow that action, not a blanket delete.

${selected
  .map(
    (c) =>
      `- ${c.file} (${c.lines || "?"}) [${c.action}]\n  - Root issue: ${c.rootIssue}\n  - Goal: ${c.benefit}`,
  )
  .join("\n")}

For each item:
1. Read the file to find the exact location
2. Apply only the specified change (not surrounding code unless instructed)
3. For refactor/inline/parallelize: preserve behavior; if the change has visible side effects, stop and report
4. If the change affects other code, stop and report the issue

After applying all changes:
- Run \`npm test\` or equivalent; if there are no tests, verify the files parse/type-check
- Report what changed, test results, and any items skipped with reasons`;

  ctx.ui.notify(
    `Applying ${selected.length} findings (${safeItems.length} safe, ${confirmItems.length} confirmed)`,
    "info",
  );

  pi.sendUserMessage(cleanupPrompt);
}

export function registerSimplifyWorkflow(pi: ExtensionAPI) {
  let resolvePendingTurnStart: (() => void) | null = null;
  let resolvePendingCandidatesTool: ((candidates: SimplifyResult[]) => void) | null = null;
  let latestToolCandidates: SimplifyResult[] | null = null;

  pi.on("turn_start", () => {
    if (!resolvePendingTurnStart) return;
    const resolve = resolvePendingTurnStart;
    resolvePendingTurnStart = null;
    resolve();
  });

  registerSimplifyCandidatesTool(pi, {
    getResolver: () => resolvePendingCandidatesTool,
    clearResolver: () => {
      resolvePendingCandidatesTool = null;
    },
    setLatestCandidates: (candidates) => {
      latestToolCandidates = candidates;
    },
  });

  pi.registerCommand("simplify", {
    description:
      "Review changed code or folders for reuse, quality, and efficiency, then apply fixes",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Simplify requires interactive mode", "error");
        return;
      }

      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Cannot run simplify while agent is busy. Wait for current task to complete.",
          "warning",
        );
        return;
      }

      const { code } = await pi.exec("git", ["rev-parse", "--git-dir"]);
      if (code !== 0) {
        ctx.ui.notify("Not a git repository", "error");
        return;
      }

      const parsed = parseArgs(args);
      if (parsed.error) {
        ctx.ui.notify(parsed.error, "error");
        return;
      }

      let target = parsed.target;
      if (!target) target = await showSimplifyTargetSelector(ctx, pi);
      if (!target) {
        ctx.ui.notify("Simplify cancelled", "info");
        return;
      }

      if (target.type === "uncommitted" && !(await hasUncommittedChanges(pi))) {
        ctx.ui.notify("No git changes found. Choose folder mode to simplify a snapshot.", "info");
        return;
      }

      if (target.type === "previous-commit" && !(await hasPreviousCommit(pi))) {
        ctx.ui.notify(
          "No previous commit found. Need at least two commits to use this mode.",
          "info",
        );
        return;
      }

      const targetHint =
        target.type === "folder"
          ? `folders: ${target.paths.join(", ")}`
          : target.type === "previous-commit"
            ? "previous commit"
            : "uncommitted changes";
      ctx.ui.notify(`Analyzing ${targetHint} for review findings...`, "info");

      const fullPrompt = buildSimplifyPrompt(target, parsed.additionalFocus);

      latestToolCandidates = null;
      const turnStarted = new Promise<void>((r) => {
        resolvePendingTurnStart = r;
      });
      const toolResult = new Promise<SimplifyResult[]>((r) => {
        resolvePendingCandidatesTool = r;
      });

      pi.sendUserMessage(fullPrompt);

      const started = await Promise.race<boolean>([
        turnStarted.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 10000)),
      ]);
      if (!started) {
        resolvePendingTurnStart = null;
        resolvePendingCandidatesTool = null;
        ctx.ui.notify("Analysis did not start within 10 seconds. Please try again.", "warning");
        return;
      }

      await ctx.waitForIdle();

      const candidates =
        latestToolCandidates ??
        (await Promise.race<SimplifyResult[] | null>([
          toolResult,
          new Promise<null>((r) => setTimeout(() => r(null), 100)),
        ]));
      resolvePendingCandidatesTool = null;

      if (candidates === null) {
        ctx.ui.notify(
          "Could not read review findings — the model did not call simplify_candidates.",
          "warning",
        );
        return;
      }

      if (candidates.length === 0) {
        ctx.ui.notify("No review findings found!", "info");
        return;
      }

      ctx.ui.notify(`Found ${candidates.length} findings. Select findings to apply...`, "info");

      const selected = await showCandidateSelector(ctx, candidates);
      if (!selected || selected.length === 0) {
        ctx.ui.notify("Apply findings cancelled", "info");
        return;
      }

      await applyFindings(ctx, selected, pi);
    },
  });
}
