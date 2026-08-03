import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { ProgrammaticCheck, SmellCategory, SmellSeverity } from "./types.js";

const DEFAULT_IGNORES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".swift",
]);

type ScanOptions = {
  cwd: string;
  paths: string[];
  maxFiles?: number;
};

type SourceFile = {
  absolutePath: string;
  relativePath: string;
  text: string;
  lines: string[];
};

async function collectFiles(root: string, target: string, out: string[], maxFiles: number) {
  if (out.length >= maxFiles) return;
  const absolute = path.resolve(root, target);
  const info = await stat(absolute).catch(() => null);
  if (!info) return;

  if (info.isFile()) {
    if (TEXT_EXTENSIONS.has(path.extname(absolute))) out.push(absolute);
    return;
  }

  if (!info.isDirectory()) return;
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (DEFAULT_IGNORES.has(entry.name)) continue;
    await collectFiles(root, path.join(target, entry.name), out, maxFiles);
  }
}

function lineRange(start: number, end?: number) {
  return end && end !== start ? `${start}-${end}` : String(start);
}

function push(
  findings: ProgrammaticCheck[],
  args: Omit<ProgrammaticCheck, "severity" | "category"> & {
    category: SmellCategory;
    severity: SmellSeverity;
  },
) {
  findings.push(args);
}

function scanFile(file: SourceFile): ProgrammaticCheck[] {
  const findings: ProgrammaticCheck[] = [];
  const counts = new Map<string, number[]>();
  let functionStart: number | null = null;
  let functionBraceDepth = 0;
  let currentFunctionComplexity = 0;

  file.lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    const normalized = line.replace(/\s+/g, " ");

    if (normalized.length > 20 && !normalized.startsWith("//") && !normalized.startsWith("*")) {
      const existing = counts.get(normalized) ?? [];
      existing.push(lineNo);
      counts.set(normalized, existing);
    }

    if (/\b(console\.(log|debug|warn|error)|debugger)\b/.test(line)) {
      push(findings, {
        id: "debug-remnant",
        title: "Debug remnant",
        category: "maintainability",
        severity: line.includes("debugger") ? "high" : "medium",
        file: file.relativePath,
        lines: String(lineNo),
        evidence: raw.trim(),
        recommendation:
          "Remove temporary logging/debug statements or replace with the project's structured logger if this is intentional.",
      });
    }

    if (/^\/\/\s*(if|for|while|return|const|let|var|function|class|import|export)\b/.test(line)) {
      push(findings, {
        id: "commented-out-code",
        title: "Commented-out code",
        category: "maintainability",
        severity: "low",
        file: file.relativePath,
        lines: String(lineNo),
        evidence: raw.trim(),
        recommendation:
          "Delete stale commented code; git history is the source of old implementations.",
      });
    }

    if (/\b(any|TODO|FIXME|HACK|XXX)\b/.test(line)) {
      push(findings, {
        id: "loose-or-temporary-marker",
        title: "Loose type or temporary marker",
        category: "maintainability",
        severity: line.includes("any") ? "medium" : "low",
        file: file.relativePath,
        lines: String(lineNo),
        evidence: raw.trim(),
        recommendation:
          "Replace temporary markers with a tracked issue or tighten the type/implementation now.",
      });
    }

    if (/\b(if|for|while|catch|case|&&|\|\|)\b/.test(line)) currentFunctionComplexity += 1;
    if (/\b(function|async function)\b|=>\s*\{/.test(line) && functionStart === null) {
      functionStart = lineNo;
      currentFunctionComplexity = 1;
      functionBraceDepth = 0;
    }
    if (functionStart !== null) {
      functionBraceDepth += (raw.match(/\{/g) ?? []).length;
      functionBraceDepth -= (raw.match(/\}/g) ?? []).length;
      if (functionBraceDepth <= 0 && lineNo > functionStart) {
        if (lineNo - functionStart > 80 || currentFunctionComplexity > 12) {
          push(findings, {
            id: "large-complex-function",
            title: "Large or complex function",
            category: "complexity",
            severity:
              currentFunctionComplexity > 18 || lineNo - functionStart > 140 ? "high" : "medium",
            file: file.relativePath,
            lines: lineRange(functionStart, lineNo),
            evidence: `${lineNo - functionStart + 1} lines, approximate branch count ${currentFunctionComplexity}`,
            recommendation:
              "Split orchestration from decisions; extract named helpers only around stable concepts, not arbitrary line chunks.",
          });
        }
        functionStart = null;
      }
    }
  });

  for (const [line, occurrences] of counts) {
    if (occurrences.length < 3) continue;
    push(findings, {
      id: "repeated-line",
      title: "Repeated implementation line",
      category: "duplication",
      severity: occurrences.length >= 6 ? "medium" : "low",
      file: file.relativePath,
      lines: occurrences.slice(0, 6).join(","),
      evidence: line,
      recommendation:
        "Check whether these repeated lines represent copy-paste logic that should share a helper or table-driven representation.",
    });
  }

  return findings;
}

export async function runProgrammaticChecks(options: ScanOptions): Promise<ProgrammaticCheck[]> {
  const maxFiles = options.maxFiles ?? 300;
  const targets = options.paths.length > 0 ? options.paths : ["."];
  const files: string[] = [];
  for (const target of targets) await collectFiles(options.cwd, target, files, maxFiles);

  const findings: ProgrammaticCheck[] = [];
  for (const absolutePath of files) {
    const text = await readFile(absolutePath, "utf8").catch(() => "");
    if (!text) continue;
    findings.push(
      ...scanFile({
        absolutePath,
        relativePath: path.relative(options.cwd, absolutePath),
        text,
        lines: text.split(/\r?\n/),
      }),
    );
  }

  return findings;
}
