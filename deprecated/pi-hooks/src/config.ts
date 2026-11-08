import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const HOOK_EVENTS = [
  "session_start",
  "session_shutdown",
  "tool_call",
  "tool_result",
  "turn_end",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Only `tool_call` is consulted before the action happens, so only it can deny one. */
export const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>(["tool_call"]);

const strict = { additionalProperties: false } as const;

const HookSchema = Type.Object(
  {
    /**
     * Argument vector, never a shell string. A hook fires with agent-controlled data in its
     * environment, so there is no shell for that data to be re-parsed by.
     */
    command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }),
    /** Regular expression matched against the tool name, for the tool events. */
    match: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
    /** `tool_call` only: a non-zero exit denies the tool call and reports the hook's stderr. */
    blockOnFailure: Type.Optional(Type.Boolean()),
    /** Human-readable label used when reporting what a hook did. */
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  strict,
);
export type HookDefinition = Static<typeof HookSchema>;

const ConfigSchema = Type.Object(
  {
    hooks: Type.Object(
      Object.fromEntries(
        HOOK_EVENTS.map((event) => [
          event,
          Type.Optional(Type.Array(HookSchema, { maxItems: 64 })),
        ]),
      ),
      strict,
    ),
  },
  strict,
);
export type HooksConfig = Static<typeof ConfigSchema>;

export type HookSource = "user" | "project";
export interface LoadedHook extends HookDefinition {
  event: HookEvent;
  source: HookSource;
  /** Compiled from `match`; absent when the hook applies to every tool. */
  pattern?: RegExp;
}
export interface LoadedHooks {
  hooks: LoadedHook[];
  warnings: string[];
}

export const CONFIG_FILENAME = "hooks.json";

function describe(value: unknown): string {
  const first = Value.Errors(ConfigSchema, value)[0];
  if (!first) return "invalid configuration";
  const known = new Set(HOOK_EVENTS as readonly string[]);
  const hooks = (value as { hooks?: unknown })?.hooks;
  if (hooks && typeof hooks === "object") {
    const unknownEvents = Object.keys(hooks).filter((key) => !known.has(key));
    if (unknownEvents.length)
      return `unknown event ${unknownEvents.map((e) => `"${e}"`).join(", ")}; supported: ${HOOK_EVENTS.join(", ")}`;
  }
  // TypeBox reports the offending location as a JSON pointer; naming it saves the caller
  // from guessing which of several hooks in the file was rejected.
  const pointer = (first as { instancePath?: string }).instancePath;
  return pointer ? `${pointer} ${first.message}` : first.message;
}

export function parseConfig(value: unknown): HooksConfig {
  if (!Value.Check(ConfigSchema, value)) throw new Error(describe(value));
  return value;
}

/**
 * Reads one hooks file. A missing file is not an error; an unreadable or invalid one is
 * reported as a warning so a broken config disables its own hooks rather than the session.
 */
export async function readHooks(
  path: string,
  source: HookSource,
): Promise<{ hooks: LoadedHook[]; warning?: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hooks: [] };
    return { hooks: [], warning: `${path}: ${(error as Error).message}` };
  }
  try {
    const config = parseConfig(JSON.parse(text) as unknown);
    const hooks: LoadedHook[] = [];
    for (const event of HOOK_EVENTS) {
      for (const definition of config.hooks[event] ?? []) {
        if (definition.blockOnFailure && !BLOCKING_EVENTS.has(event))
          return {
            hooks: [],
            warning: `${path}: blockOnFailure is only supported on ${[...BLOCKING_EVENTS].join(", ")}`,
          };
        let pattern: RegExp | undefined;
        if (definition.match) {
          try {
            pattern = new RegExp(definition.match);
          } catch (error) {
            return { hooks: [], warning: `${path}: invalid match — ${(error as Error).message}` };
          }
        }
        hooks.push({ ...definition, event, source, ...(pattern ? { pattern } : {}) });
      }
    }
    return { hooks };
  } catch (error) {
    return { hooks: [], warning: `${path}: ${(error as Error).message}` };
  }
}

/**
 * Loads user hooks always, and project hooks only for a trusted project.
 *
 * A hooks file is executable configuration, so an untrusted checkout must not be able to run
 * commands simply by being opened. User hooks are the operator's own and are always applied.
 */
export async function loadHooks(
  agentDir: string,
  cwd: string,
  configDirName: string,
  projectTrusted: boolean,
): Promise<LoadedHooks> {
  const user = await readHooks(join(agentDir, CONFIG_FILENAME), "user");
  const project = projectTrusted
    ? await readHooks(join(cwd, configDirName, CONFIG_FILENAME), "project")
    : { hooks: [] as LoadedHook[], warning: undefined };
  return {
    hooks: [...user.hooks, ...project.hooks],
    warnings: [user.warning, project.warning].filter((entry): entry is string => !!entry),
  };
}

/** Hooks registered for `event` whose `match` accepts `toolName`. */
export function selectHooks(
  hooks: readonly LoadedHook[],
  event: HookEvent,
  toolName?: string,
): LoadedHook[] {
  return hooks.filter((hook) => {
    if (hook.event !== event) return false;
    if (!hook.pattern) return true;
    return toolName !== undefined && hook.pattern.test(toolName);
  });
}
