const ESC = "\x1b";

// Curated xterm-256 codes: mid-saturation, legible on both light and dark
// terminal backgrounds. Picked by hand rather than probing truecolor support
// since 256-color codes render fine in truecolor terminals too.
const MEMBER_PALETTE = [39, 78, 141, 173, 175, 179, 203, 208, 213, 75, 222, 114] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  return hash;
}

/** A stable, deterministic xterm-256 accent per member id — same member, same color, everywhere. */
export function accentCode(memberId: string): number {
  return MEMBER_PALETTE[hashString(memberId) % MEMBER_PALETTE.length];
}

/** Wraps text in that member's accent color, resetting foreground after. */
export function accentWrap(memberId: string, text: string): string {
  return `${ESC}[38;5;${accentCode(memberId)}m${text}${ESC}[39m`;
}
