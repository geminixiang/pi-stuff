import type { TaskRecord } from "@geminixiang/pi-task-protocol";
import type { OutputResult } from "./runner.ts";

export const LOG_STREAMS = ["stdout", "stderr"] as const;
export type LogStream = (typeof LOG_STREAMS)[number];
export type LogMode = "new" | "tail" | "all";
export type StreamCursors = Record<LogStream, number>;

const MAX_FILTER_LENGTH = 1024;

/** A short label for a task, used wherever an opaque task id would be unreadable. */
export function describeTask(record: TaskRecord): string {
  return (
    record.spec.name ?? [record.spec.command, ...(record.spec.args ?? [])].join(" ").slice(0, 64)
  );
}

/**
 * Compiles a caller-supplied line filter. Built without flags so the returned RegExp carries
 * no `lastIndex` state between the lines it is tested against.
 */
export function compileFilter(pattern?: string): RegExp | undefined {
  if (!pattern) return undefined;
  if (pattern.length > MAX_FILTER_LENGTH) throw new Error("filter pattern is too long");
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(`Invalid filter pattern: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Chooses the byte window to request for one stream.
 *
 * `new` resumes from what the caller has already been shown, but stays capped at `limit` by
 * tailing, so a service that outran the reader yields its most recent output rather than a
 * stale window. A stream with nothing consumed yet has no meaningful resume point, so it
 * tails too — a first look at a long-running service should show the end of its log, not its
 * startup banner.
 */
export function selectWindow(
  mode: LogMode,
  consumed: number,
  explicitOffset?: number,
): { offset?: number; tail?: boolean } {
  if (mode === "all") return { offset: explicitOffset ?? 0 };
  if (mode === "tail" || consumed === 0) return { tail: true };
  return { offset: consumed, tail: true };
}

/**
 * Renders one stream window. `resumedFrom` is the offset the caller expected to continue at;
 * anything the window skipped past it is reported rather than dropped silently.
 */
export function renderStream(
  result: OutputResult,
  filter: RegExp | undefined,
  resumedFrom: number,
): string {
  const notes = [`bytes ${result.offset}-${result.nextOffset} of ${result.size}`];
  const skipped = result.offset - resumedFrom;
  if (skipped > 0) notes.push(`${skipped} earlier bytes skipped to stay within limit`);
  if (!result.text) {
    const empty = result.size === 0 ? "no output yet" : "no new output";
    return `[${result.stream}] ${notes.join("; ")} — ${empty}`;
  }
  if (!filter) return `[${result.stream}] ${notes.join("; ")}\n${result.text}`;
  const lines = result.text.split("\n");
  const kept = lines.filter((line) => filter.test(line));
  notes.push(`${kept.length}/${lines.length} lines matched filter`);
  return `[${result.stream}] ${notes.join("; ")}\n${kept.join("\n")}`;
}
