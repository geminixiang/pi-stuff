import { execFile } from "node:child_process";
import type { LoadedHook } from "./config.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

export interface HookContext {
  cwd: string;
  toolName?: string;
  /** Serialized as JSON into the environment; never interpolated into the argument vector. */
  toolInput?: unknown;
  sessionId?: string;
}

export interface HookOutcome {
  hook: LoadedHook;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/**
 * Agent-controlled values reach a hook through the environment rather than its arguments.
 * A tool name or input interpolated into an argument vector would be attacker-influenced
 * data in a command line; as an environment value it is inert unless the hook opts into
 * reading it.
 */
export function hookEnvironment(context: HookContext): Record<string, string> {
  const environment: Record<string, string> = { PI_HOOK_CWD: context.cwd };
  if (context.toolName) environment.PI_HOOK_TOOL = context.toolName;
  if (context.sessionId) environment.PI_HOOK_SESSION = context.sessionId;
  if (context.toolInput !== undefined) {
    try {
      const encoded = JSON.stringify(context.toolInput);
      if (encoded && encoded.length <= MAX_CAPTURE_BYTES) environment.PI_HOOK_INPUT = encoded;
    } catch {
      // A value that will not serialize is simply not exposed.
    }
  }
  return environment;
}

type ExecFailure = Error & {
  code?: number | string;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
};

/** Runs one hook to completion. Never throws: a failure to spawn is reported like any other. */
export function runHook(hook: LoadedHook, context: HookContext): Promise<HookOutcome> {
  const [command, ...args] = hook.command;
  return new Promise<HookOutcome>((resolve) => {
    execFile(
      command!,
      args,
      {
        cwd: context.cwd,
        env: { ...process.env, ...hookEnvironment(context) },
        timeout: hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_CAPTURE_BYTES,
        shell: false,
      },
      (error, stdout, stderr) => {
        const failure = error as ExecFailure | null;
        const exited = typeof failure?.code === "number";
        resolve({
          hook,
          code: failure ? (exited ? (failure.code as number) : null) : 0,
          signal: failure?.signal ?? null,
          stdout: String(stdout).slice(0, MAX_CAPTURE_BYTES),
          stderr: String(stderr).slice(0, MAX_CAPTURE_BYTES),
          timedOut: failure?.killed === true,
          // A spawn failure (ENOENT, EACCES) reports a string code and no exit status.
          ...(failure && !exited && !failure.signal ? { error: failure.message } : {}),
        });
      },
    );
  });
}

export const hookLabel = (hook: LoadedHook): string =>
  hook.name ?? `${hook.source}:${hook.command[0]}`;

/** A hook denies a tool call when it opted into blocking and did not exit cleanly. */
export function denial(outcome: HookOutcome): string | undefined {
  if (!outcome.hook.blockOnFailure) return undefined;
  if (outcome.code === 0) return undefined;
  const detail =
    outcome.stderr.trim() ||
    outcome.stdout.trim() ||
    outcome.error ||
    (outcome.signal ? `killed by ${outcome.signal}` : `exit ${outcome.code}`);
  return `${hookLabel(outcome.hook)} denied this call: ${detail}`;
}
