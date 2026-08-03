import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  activationRequiresConfirmation,
  catalogPaths,
  type ToolDescriptor,
} from "./src/catalog.js";
import { CatalogController, type ActivationResult } from "./src/controller.js";

function names(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function descriptorLine(descriptor: ToolDescriptor): string {
  const flags = [
    descriptor.active ? "active" : descriptor.deferred ? "deferred" : "inactive",
    descriptor.activationPolicy,
    descriptor.trust,
    descriptor.sideEffects,
    descriptor.health,
    descriptor.source,
  ];
  return `${descriptor.name} [${flags.join(", ")}] — ${descriptor.description}`;
}

function resultText(result: ActivationResult): string {
  const sections = [
    result.activated.length > 0 ? `Activated: ${result.activated.join(", ")}` : undefined,
    result.blocked.length > 0 ? `Blocked: ${result.blocked.join(", ")}` : undefined,
    result.missing.length > 0 ? `Unknown: ${result.missing.join(", ")}` : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  return sections.join("\n") || "No changes.";
}

function confirmationMessage(descriptors: ToolDescriptor[]): string {
  return descriptors
    .map(
      (descriptor) =>
        `${descriptor.name}\n  source: ${descriptor.source}\n  trust: ${descriptor.trust}\n  side effects: ${descriptor.sideEffects}\n  policy: ${descriptor.activationPolicy}`,
    )
    .join("\n\n");
}

async function confirmActivation(
  requested: string[],
  controller: CatalogController,
  ctx: {
    hasUI: boolean;
    ui: { confirm(title: string, message: string): Promise<boolean> };
  },
): Promise<{ approved: string[]; rejected: string[] }> {
  const descriptors = new Map(
    controller.descriptors().map((descriptor) => [descriptor.name, descriptor]),
  );
  const confirmable = requested
    .map((name) => descriptors.get(name))
    .filter(
      (descriptor): descriptor is ToolDescriptor =>
        descriptor !== undefined && activationRequiresConfirmation(descriptor),
    );
  if (confirmable.length === 0) return { approved: requested, rejected: [] };
  const names = new Set(confirmable.map((descriptor) => descriptor.name));
  const rejected = requested.filter((name) => names.has(name));
  if (!ctx.hasUI) return { approved: requested.filter((name) => !names.has(name)), rejected };
  const confirmed = await ctx.ui.confirm(
    "Activate catalog tools?",
    confirmationMessage(confirmable),
  );
  return confirmed
    ? { approved: requested, rejected: [] }
    : { approved: requested.filter((name) => !names.has(name)), rejected };
}

export default function toolCatalogExtension(pi: ExtensionAPI) {
  let cwd = process.cwd();
  const controller = new CatalogController(pi, catalogPaths(cwd));

  pi.registerTool({
    name: "search_tools",
    label: "Search Tools",
    description:
      "Search the deferred tool catalog by exact name, name fragments, keywords, and description",
    promptSnippet: "Search for and activate tools needed for a task",
    promptGuidelines: [
      "Use search_tools when a required capability is not among the currently active tools.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Capability or tool to search for" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
      activate: Type.Optional(
        Type.Boolean({ description: "Activate safe matches; defaults to true", default: true }),
      ),
    }),
    async execute(_toolCallId, params) {
      const matches = controller.search(params.query, params.limit ?? 5);
      const activation =
        params.activate === false
          ? undefined
          : controller.activate(
              matches.map((descriptor) => descriptor.name),
              true,
            );
      const output =
        matches.length === 0 ? "No matching tools." : matches.map(descriptorLine).join("\n");
      return {
        content: [
          { type: "text", text: activation ? `${output}\n\n${resultText(activation)}` : output },
        ],
        details: { matches, activation },
      };
    },
  });

  pi.registerTool({
    name: "tool_catalog",
    label: "Tool Catalog",
    description:
      "List, activate, or deactivate catalog tools. Explicit activation can enable untrusted side-effecting tools.",
    promptSnippet: "List and explicitly manage deferred tool activation",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("list") }),
      Type.Object({
        action: Type.Literal("activate"),
        names: Type.Array(Type.String(), { minItems: 1 }),
      }),
      Type.Object({
        action: Type.Literal("deactivate"),
        names: Type.Array(Type.String(), { minItems: 1 }),
      }),
    ]),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "list") {
        const descriptors = controller.descriptors();
        return {
          content: [
            { type: "text", text: descriptors.map(descriptorLine).join("\n") || "No tools." },
          ],
          details: { descriptors },
        };
      }
      const result =
        params.action === "activate"
          ? await (async () => {
              const confirmation = await confirmActivation(params.names, controller, ctx);
              const activation = controller.activate(confirmation.approved, false);
              activation.blocked.push(...confirmation.rejected);
              return activation;
            })()
          : controller.deactivate(params.names);
      return { content: [{ type: "text", text: resultText(result) }], details: result };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.cwd !== cwd) {
      cwd = ctx.cwd;
      controller.paths.global = catalogPaths(cwd).global;
      controller.paths.project = catalogPaths(cwd).project;
    }
    const warnings = await controller.reload(ctx.isProjectTrusted());
    for (const warning of warnings) ctx.ui.notify(`Tool catalog: ${warning}`, "warning");
  });

  pi.registerCommand("tool-catalog", {
    description: "List, search, activate, deactivate, or reload deferred tools",
    handler: async (args, ctx) => {
      const [action = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "reload") {
        const warnings = await controller.reload(ctx.isProjectTrusted());
        ctx.ui.notify(
          warnings.length === 0 ? "Tool catalog reloaded" : warnings.join("\n"),
          warnings.length === 0 ? "info" : "warning",
        );
        return;
      }
      if (action === "list") {
        ctx.ui.notify(
          controller.descriptors().map(descriptorLine).join("\n") || "No tools.",
          "info",
        );
        return;
      }
      if (action === "search") {
        const matches = controller.search(rest.join(" "), 20);
        ctx.ui.notify(matches.map(descriptorLine).join("\n") || "No matching tools.", "info");
        return;
      }
      if (action === "activate" || action === "deactivate") {
        const toolNames = names(rest.join(" "));
        if (toolNames.length === 0) {
          ctx.ui.notify(`Usage: /tool-catalog ${action} <tool names>`, "warning");
          return;
        }
        const result =
          action === "activate"
            ? await (async () => {
                const confirmation = await confirmActivation(toolNames, controller, ctx);
                const activation = controller.activate(confirmation.approved, false);
                activation.blocked.push(...confirmation.rejected);
                return activation;
              })()
            : controller.deactivate(toolNames);
        ctx.ui.notify(
          resultText(result),
          result.blocked.length > 0 || result.missing.length > 0 ? "warning" : "info",
        );
        return;
      }
      ctx.ui.notify(
        "Usage: /tool-catalog [list|search <query>|activate <names>|deactivate <names>|reload]",
        "warning",
      );
    },
  });
}
