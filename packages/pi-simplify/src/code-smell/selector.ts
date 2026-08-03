import {
  getSelectListTheme,
  keyHint,
  rawKeyHint,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";

import type { CodeSmellFinding, SmellAction } from "./types.js";

const SEVERITY_CONFIG = {
  high: { label: "High severity" },
  medium: { label: "Medium severity" },
  low: { label: "Low severity" },
} as const;

const ACTION_LABEL: Record<SmellAction, string> = {
  inspect: "Inspect manually",
  delete: "Delete code",
  inline: "Inline code",
  extract: "Extract helper",
  refactor: "Refactor",
  guard: "Add guard/check",
};

export async function showFindingSelector(
  ctx: ExtensionCommandContext,
  findings: CodeSmellFinding[],
): Promise<CodeSmellFinding[]> {
  if (findings.length === 0) return [];

  const sorted = [...findings].sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return rank[a.severity] - rank[b.severity];
  });

  const listItems: SelectItem[] = sorted.map((finding, index) => ({
    value: String(index),
    label: "",
    description: `${SEVERITY_CONFIG[finding.severity].label} · ${finding.confidence} confidence · ${ACTION_LABEL[finding.action]}`,
  }));

  const selectedSet = new Set<number>();
  sorted.forEach((finding, index) => {
    if (finding.severity === "high" && finding.confidence !== "low") selectedSet.add(index);
  });

  const maxVisible = 8;
  let cursorPos = 0;
  const getStartIndex = (selectedIndex: number) =>
    Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), sorted.length - maxVisible));

  const result = await ctx.ui.custom<CodeSmellFinding[]>((tui, theme, keybindings, done) => {
    const updateListLabel = (index: number) => {
      const item = listItems[index];
      const finding = sorted[index];
      const checkbox = selectedSet.has(index) ? "[x]" : "[ ]";
      const location = finding.lines ? `${finding.file}:${finding.lines}` : finding.file;
      item.label = `${checkbox} ${location}`;
    };
    const updateAll = () => listItems.forEach((_item, index) => updateListLabel(index));
    updateAll();

    const selectList = new SelectList(listItems, maxVisible, getSelectListTheme());
    selectList.onSelectionChange = (item) => {
      cursorPos = Number(item.value);
    };
    selectList.onCancel = () => done([]);

    const toggleCurrent = () => {
      if (selectedSet.has(cursorPos)) selectedSet.delete(cursorPos);
      else selectedSet.add(cursorPos);
      updateListLabel(cursorPos);
      tui.requestRender();
    };

    const toggleAll = () => {
      if (selectedSet.size === sorted.length) selectedSet.clear();
      else for (let i = 0; i < sorted.length; i++) selectedSet.add(i);
      updateAll();
      tui.requestRender();
    };

    return {
      render(width: number) {
        selectList.setSelectedIndex(cursorPos);
        const lines: string[] = [];
        lines.push(theme.bold("Code Smell: Select findings to clean"));
        lines.push(theme.fg("muted", `Found ${findings.length} findings`));
        lines.push("");

        const listLines = selectList.render(width);
        const selectedLineIndex = cursorPos - getStartIndex(cursorPos);
        const current = sorted[cursorPos];
        for (const [lineIndex, line] of listLines.entries()) {
          lines.push(line);
          if (lineIndex !== selectedLineIndex || !current) continue;

          const detailIndent = "    ";
          const detailPrefix = `${detailIndent}│ `;
          const wrapWidth = Math.max(1, width - detailPrefix.length);
          const pushSection = (heading: string, body: string) => {
            if (!body) return;
            lines.push(theme.fg("borderMuted", `${detailIndent}┌─ ${heading}`));
            lines.push(
              ...wrapTextWithAnsi(body, wrapWidth).map((wrappedLine) =>
                theme.fg("muted", `${detailPrefix}${wrappedLine}`),
              ),
            );
          };

          pushSection("Smell", current.smell);
          pushSection("Evidence", current.evidence);
          pushSection("Impact", current.impact);
          pushSection("Recommendation", current.recommendation);
          lines.push(theme.fg("muted", `${detailPrefix}Category: ${current.category}`));
          lines.push(theme.fg("muted", `${detailPrefix}Action: ${ACTION_LABEL[current.action]}`));
          lines.push(
            theme.fg("borderMuted", `${detailIndent}└─ ${rawKeyHint("space", "selects this fix")}`),
          );
        }

        lines.push("");
        lines.push(
          theme.fg(
            "muted",
            [
              `Selected: ${selectedSet.size}`,
              rawKeyHint("↑↓", "navigate"),
              rawKeyHint("space", "toggle"),
              rawKeyHint("a", "select all"),
              keyHint("tui.select.confirm", "confirm"),
              keyHint("tui.select.cancel", "cancel"),
            ].join(" • "),
          ),
        );
        return lines;
      },
      invalidate() {
        selectList.invalidate();
      },
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.confirm")) {
          return done(Array.from(selectedSet).map((i) => sorted[i]));
        }
        if (keybindings.matches(data, "tui.select.cancel")) return done([]);
        if (matchesKey(data, "space")) return toggleCurrent();
        if (matchesKey(data, "a")) return toggleAll();
        const previous = cursorPos;
        selectList.handleInput(data);
        if (cursorPos !== previous) tui.requestRender();
      },
    };
  });

  return result ?? [];
}
