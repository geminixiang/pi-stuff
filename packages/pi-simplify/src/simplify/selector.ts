import {
  getSelectListTheme,
  keyHint,
  rawKeyHint,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";

import type { Action, SimplifyResult } from "./types.js";

const RISK_CONFIG = {
  safe: { label: "Safe to apply" },
  confirm: { label: "Needs confirmation" },
  review: { label: "Needs review" },
} as const;

const ACTION_LABEL: Record<Action, string> = {
  delete: "Delete code",
  inline: "Inline code",
  refactor: "Refactor code",
  parallelize: "Run work in parallel",
};

export async function showCandidateSelector(
  ctx: ExtensionCommandContext,
  candidates: SimplifyResult[],
): Promise<SimplifyResult[]> {
  if (candidates.length === 0) return [];

  const safeCandidates = candidates.filter((c) => c.risk === "safe");
  const confirmCandidates = candidates.filter((c) => c.risk === "confirm");
  const reviewCandidates = candidates.filter((c) => c.risk === "review");

  const sections = [
    { key: "safe" as const, items: safeCandidates },
    { key: "confirm" as const, items: confirmCandidates },
    { key: "review" as const, items: reviewCandidates },
  ]
    .map(({ key, items }) => ({ key, items, config: RISK_CONFIG[key], total: items.length }))
    .filter((s) => s.total > 0);

  const selectableItems = sections.flatMap((section) =>
    section.items.map((candidate) => ({ section, candidate })),
  );

  const listItems: SelectItem[] = selectableItems.map(({ section, candidate }, index) => ({
    value: String(index),
    label: "",
    description: `${section.config.label} · ${ACTION_LABEL[candidate.action]}`,
  }));

  const selectedSet = new Set<number>();
  selectableItems.forEach(({ candidate }, index) => {
    if (candidate.risk === "safe") selectedSet.add(index);
  });

  const maxVisible = 8;
  let cursorPos = 0;

  const getSelectListStartIndex = (selectedIndex: number) =>
    Math.max(
      0,
      Math.min(selectedIndex - Math.floor(maxVisible / 2), selectableItems.length - maxVisible),
    );

  const result = await ctx.ui.custom<SimplifyResult[]>((tui, theme, keybindings, done) => {
    const updateListLabel = (index: number) => {
      const item = listItems[index];
      const { candidate } = selectableItems[index];
      const checkbox = selectedSet.has(index) ? "[x]" : "[ ]";
      const location = candidate.lines ? `${candidate.file}:${candidate.lines}` : candidate.file;
      item.label = `${checkbox} ${location}`;
    };
    const updateAllListLabels = () => listItems.forEach((_item, index) => updateListLabel(index));

    updateAllListLabels();

    const selectList = new SelectList(listItems, maxVisible, getSelectListTheme());
    selectList.onSelectionChange = (item) => {
      cursorPos = Number(item.value);
    };
    selectList.onCancel = () => done([]);

    const submitSelection = () => {
      done(Array.from(selectedSet).map((i) => selectableItems[i].candidate));
    };

    const cancelSelection = () => {
      done([]);
    };

    const toggleCurrent = () => {
      if (selectedSet.has(cursorPos)) {
        selectedSet.delete(cursorPos);
      } else {
        selectedSet.add(cursorPos);
      }
      updateListLabel(cursorPos);
      tui.requestRender();
    };

    const toggleAll = () => {
      if (selectedSet.size === selectableItems.length) {
        selectedSet.clear();
      } else {
        for (let i = 0; i < selectableItems.length; i++) selectedSet.add(i);
      }
      updateAllListLabels();
      tui.requestRender();
    };

    return {
      render(width: number) {
        selectList.setSelectedIndex(cursorPos);

        const lines: string[] = [];
        lines.push(theme.bold("Simplify: Select findings to apply"));
        lines.push(
          theme.fg(
            "muted",
            `Found ${candidates.length} candidates (${safeCandidates.length} safe, ${confirmCandidates.length} confirm, ${reviewCandidates.length} review)`,
          ),
        );
        lines.push("");

        const listLines = selectList.render(width);
        const selectedLineIndex = cursorPos - getSelectListStartIndex(cursorPos);
        const current = selectableItems[cursorPos]?.candidate;
        for (const [lineIndex, line] of listLines.entries()) {
          lines.push(line);
          if (lineIndex !== selectedLineIndex || !current) continue;

          const detailIndent = "    ";
          const detailPrefix = `${detailIndent}│ `;
          const location = current.lines ? `${current.file}:${current.lines}` : current.file;
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

          pushSection("Root issue", current.rootIssue);
          pushSection("Consequence", current.consequence);
          pushSection("Benefit after fix", current.benefit);
          lines.push(theme.fg("muted", `${detailPrefix}`));
          lines.push(theme.fg("muted", `${detailPrefix}File: ${location}`));
          lines.push(
            theme.fg("muted", `${detailPrefix}Review: ${RISK_CONFIG[current.risk].label}`),
          );
          lines.push(theme.fg("muted", `${detailPrefix}Kind: ${current.category}`));
          lines.push(theme.fg("muted", `${detailPrefix}Fix: ${ACTION_LABEL[current.action]}`));
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
        if (keybindings.matches(data, "tui.select.confirm")) return submitSelection();
        if (keybindings.matches(data, "tui.select.cancel")) return cancelSelection();

        // Extra shortcuts: these selector-specific actions are not registered pi keybinding ids.
        if (matchesKey(data, "space")) return toggleCurrent();
        if (matchesKey(data, "a")) return toggleAll();

        const previousCursorPos = cursorPos;
        selectList.handleInput(data);
        if (cursorPos !== previousCursorPos) tui.requestRender();
      },
    };
  });

  return result ?? [];
}
