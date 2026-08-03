import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_FILENAME,
  HOOK_EVENTS,
  type HookEvent,
  type LoadedHook,
  loadHooks,
  selectHooks,
} from "./src/config.ts";
import { type HookContext, denial, hookLabel, runHook } from "./src/runner.ts";

const plain = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

export default function hooksExtension(pi: ExtensionAPI): void {
  let hooks: LoadedHook[] = [];
  let ui: ExtensionUIContext | undefined;
  let cwd = process.cwd();
  let sessionId: string | undefined;

  const reload = async (context: { cwd: string; trusted: boolean }): Promise<string[]> => {
    const loaded = await loadHooks(getAgentDir(), context.cwd, CONFIG_DIR_NAME, context.trusted);
    hooks = loaded.hooks;
    return loaded.warnings;
  };

  const context = (toolName?: string, toolInput?: unknown): HookContext => ({
    cwd,
    ...(toolName ? { toolName } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(sessionId ? { sessionId } : {}),
  });

  /** Runs every hook for an observational event, reporting failures without changing control flow. */
  const observe = async (event: HookEvent, toolName?: string, toolInput?: unknown) => {
    const selected = selectHooks(hooks, event, toolName);
    if (!selected.length) return;
    const outcomes = await Promise.all(
      selected.map((hook) => runHook(hook, context(toolName, toolInput))),
    );
    for (const outcome of outcomes) {
      if (outcome.code === 0) continue;
      const detail = outcome.error ?? outcome.stderr.trim();
      ui?.notify(
        `Hook ${hookLabel(outcome.hook)} failed on ${event}${detail ? `: ${detail}` : ""}`,
        "warning",
      );
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.ui;
    cwd = ctx.cwd;
    sessionId = ctx.sessionManager.getSessionId();
    for (const warning of await reload({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() }))
      ctx.ui.notify(`pi-hooks: ${warning}`, "warning");
    void observe("session_start");
  });

  pi.on("session_shutdown", async () => {
    await observe("session_shutdown");
  });

  pi.on("turn_end", async () => {
    await observe("turn_end");
  });

  pi.on("tool_result", async (event) => {
    await observe("tool_result", event.toolName);
  });

  /**
   * The only event consulted before the action happens. A blocking hook that does not exit
   * cleanly denies the call, and the reason reaches the agent so it can respond rather than
   * retry blindly.
   */
  pi.on("tool_call", async (event) => {
    const selected = selectHooks(hooks, "tool_call", event.toolName);
    if (!selected.length) return undefined;
    const outcomes = await Promise.all(
      selected.map((hook) => runHook(hook, context(event.toolName, event.input))),
    );
    for (const outcome of outcomes) {
      const reason = denial(outcome);
      if (reason) return { block: true, reason };
      if (outcome.code !== 0)
        ui?.notify(
          `Hook ${hookLabel(outcome.hook)} failed on tool_call: ${outcome.error ?? outcome.stderr.trim()}`,
          "warning",
        );
    }
    return undefined;
  });

  pi.registerCommand("hooks", {
    description: "List configured hooks, or reload them after editing hooks.json",
    handler: async (args, ctx) => {
      if (args.trim() === "reload") {
        const warnings = await reload({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
        for (const warning of warnings) ctx.ui.notify(`pi-hooks: ${warning}`, "warning");
        ctx.ui.notify(`pi-hooks: loaded ${hooks.length} hook(s)`, "info");
        return;
      }
      const lines = hooks.length
        ? hooks.map(
            (hook) =>
              `${hook.event.padEnd(18)} ${hookLabel(hook)}${hook.match ? `  match=/${hook.match}/` : ""}${hook.blockOnFailure ? "  [blocking]" : ""}`,
          )
        : [
            `No hooks configured. Create ${CONFIG_DIR_NAME}/${CONFIG_FILENAME} or ${CONFIG_FILENAME} in the agent directory.`,
            `Supported events: ${HOOK_EVENTS.join(", ")}`,
          ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerTool({
    name: "hooks_list",
    label: "List Hooks",
    description:
      "List the shell commands configured to run automatically on agent events, including which ones can deny a tool call.",
    parameters: Type.Object({}),
    async execute() {
      if (!hooks.length) return plain("No hooks are configured for this session.");
      return plain(
        hooks
          .map(
            (hook) =>
              `${hookLabel(hook)} — on ${hook.event}${hook.match ? `, tools matching /${hook.match}/` : ""}${hook.blockOnFailure ? ", denies the call on failure" : ""} (${hook.source})`,
          )
          .join("\n"),
      );
    },
  });
}

export * from "./src/config.ts";
export * from "./src/runner.ts";
