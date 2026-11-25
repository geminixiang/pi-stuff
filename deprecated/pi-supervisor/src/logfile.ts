import { open, readdir, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Bytes written to one segment before it is archived and a fresh segment is opened. */
export const SEGMENT_BYTES = 8 * 1024 * 1024;
/** Archived segments kept per stream. The retained window is this many segments, plus the active one. */
export const RETAINED_SEGMENTS = 1;

/**
 * A stream's log is addressed by *logical* offset: the count of bytes ever written to it,
 * which only ever grows. On disk it is a chain of segments — archives named
 * `<base>.<startOffset>` plus the active `<base>` — so a segment's logical range is
 * recoverable from its name alone, with no bookkeeping to persist or rebuild after a
 * daemon restart. Old segments are evicted from the front; a read of evicted bytes is
 * reported as skipped rather than silently returning the wrong bytes.
 */
export interface Segment {
  path: string;
  start: number;
  size: number;
}

export interface LogWindow {
  offset: number;
  nextOffset: number;
  /** Total logical bytes ever written, whether or not still retained. */
  size: number;
  /** Earliest logical byte still on disk; anything below it has been evicted. */
  retainedFrom: number;
  eof: boolean;
  text: string;
}

/** Lists the retained segments of one stream in logical order, oldest first. */
export async function segments(base: string): Promise<Segment[]> {
  const dir = dirname(base);
  const prefix = `${basename(base)}.`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const archives: Segment[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^(0|[1-9]\d*)$/.test(suffix)) continue;
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (info?.isFile()) archives.push({ path, start: Number(suffix), size: info.size });
  }
  archives.sort((a, b) => a.start - b.start);
  const last = archives.at(-1);
  const active = await stat(base).catch(() => undefined);
  if (!active?.isFile()) return archives;
  return [...archives, { path: base, start: last ? last.start + last.size : 0, size: active.size }];
}

/**
 * Reads a bounded window spanning as many segments as needed. `tail` reads the last `limit`
 * bytes, so a caller can reach the end of a live log without knowing its size first.
 */
export async function readWindow(
  base: string,
  { offset = 0, limit = 64 * 1024, tail = false } = {},
): Promise<LogWindow> {
  const chain = await segments(base);
  const size = chain.length ? chain.at(-1)!.start + chain.at(-1)!.size : 0;
  const retainedFrom = chain.length ? chain[0]!.start : 0;
  const requested = tail ? Math.max(offset, size - limit) : Math.min(offset, size);
  const start = Math.min(Math.max(requested, retainedFrom), size);
  const end = Math.min(start + limit, size);
  const chunks: Buffer[] = [];
  for (const segment of chain) {
    const from = Math.max(start, segment.start);
    const to = Math.min(end, segment.start + segment.size);
    if (to <= from) continue;
    const handle = await open(segment.path, "r").catch(() => undefined);
    if (!handle) continue;
    try {
      const buffer = Buffer.alloc(to - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from - segment.start);
      chunks.push(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
  const text = Buffer.concat(chunks);
  const nextOffset = start + text.length;
  return {
    offset: start,
    nextOffset,
    size,
    retainedFrom,
    eof: nextOffset >= size,
    text: text.toString("utf8"),
  };
}

/**
 * Appends one child stream to its segment chain, rotating on size so a long-lived service
 * keeps logging instead of hitting a cap and going silent. Writes are serialized and never
 * split across a rotation, so every segment boundary is byte-exact.
 */
export class LogWriter {
  readonly base: string;
  private handle?: FileHandle;
  private activeStart = 0;
  private activeBytes = 0;
  private archived: number[] = [];
  private writes = Promise.resolve();
  private failure?: Error;
  constructor(base: string) {
    this.base = base;
  }

  async open(): Promise<void> {
    this.handle = await open(this.base, "wx", 0o600);
  }

  write(chunk: Buffer): void {
    this.writes = this.writes
      .then(() => this.append(chunk))
      .catch((error: Error) => {
        this.failure ??= error;
      });
  }

  /** Resolves once every write issued so far has reached disk. */
  drain(): Promise<void> {
    return this.writes;
  }

  async close(): Promise<void> {
    await this.writes;
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
    if (this.failure) throw this.failure;
  }

  private async append(chunk: Buffer): Promise<void> {
    if (!this.handle) return;
    if (this.activeBytes > 0 && this.activeBytes + chunk.length > SEGMENT_BYTES)
      await this.rotate();
    await this.handle.write(chunk);
    this.activeBytes += chunk.length;
  }

  private async rotate(): Promise<void> {
    await this.handle!.close();
    this.handle = undefined;
    await rename(this.base, `${this.base}.${this.activeStart}`);
    this.archived.push(this.activeStart);
    while (this.archived.length > RETAINED_SEGMENTS)
      await rm(`${this.base}.${this.archived.shift()}`, { force: true });
    this.activeStart += this.activeBytes;
    this.activeBytes = 0;
    this.handle = await open(this.base, "wx", 0o600);
  }
}
