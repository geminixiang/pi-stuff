import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Parses `lsof -F n` output, whose fields arrive one per line, prefixed by field type:
 * `p<pid>`, `f<fd>`, then `n<address>` such as `n*:3000` or `n127.0.0.1:8080`.
 */
export function parseListeningPorts(stdout: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("n")) continue;
    const port = Number(line.slice(1).split(":").pop());
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * TCP ports a process group is listening on.
 *
 * The port is usually held by a descendant rather than the process taskd spawned — a shell
 * wrapper that sources an env file and then starts a server, for example — so the whole
 * process group is inspected rather than the recorded pid alone. Returns no ports when
 * `lsof` is unavailable or matches nothing, since it exits non-zero for both.
 */
export async function listeningPorts(pgid: number): Promise<number[]> {
  if (!Number.isSafeInteger(pgid) || pgid <= 0 || process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-g", String(pgid), "-F", "n"],
      { timeout: 2_000 },
    );
    return parseListeningPorts(stdout);
  } catch {
    return [];
  }
}
