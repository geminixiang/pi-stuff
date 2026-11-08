import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  MemoryStore,
  retrievalContext,
  type ManageAction,
  type MemoryRecord,
  type MemoryStatus,
} from "./src/store.js";

const ScopeSchema = Type.Union([Type.Literal("project"), Type.Literal("user")]);
const StatusSchema = Type.Union([
  Type.Literal("candidate"),
  Type.Literal("active"),
  Type.Literal("rejected"),
  Type.Literal("superseded"),
  Type.Literal("deleted"),
]);
const ManageSchema = Type.Union([
  Type.Literal("approve"),
  Type.Literal("reject"),
  Type.Literal("delete"),
  Type.Literal("supersede"),
]);

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

const CANCELLED = "Memory change cancelled or unavailable without interactive confirmation.";

/** Distinguishes a declined confirmation from a malfunction inside the same catch. */
class Cancelled extends Error {}

/**
 * Reports a failure the way the agent runtime recognises.
 *
 * A returned result is always recorded as a success — the runtime hardcodes `isError: false`
 * for anything a tool returns, and marks an error only when `execute` throws. The message is
 * deliberately generic: the underlying error is discarded rather than surfaced, so rejected
 * content never travels back through the error path.
 */
function fail(text: string): never {
  throw new Error(text);
}

function confirmationRecord(record: MemoryRecord): string {
  const text = record.text.length > 1_000 ? `${record.text.slice(0, 1_000)}…` : record.text;
  return [
    `[${record.id}] version=${record.version} status=${record.status}`,
    `scope=${record.scope}`,
    `text=${text}`,
    `provenance=${record.provenance.source}${record.provenance.author ? `; author=${record.provenance.author}` : ""}${record.provenance.session ? `; session=${record.provenance.session}` : ""}`,
    `confidence=${record.confidence}`,
    `expiry=${record.expiresAt ?? "none"}`,
  ].join("\n");
}

async function confirmManage(
  ctx: ExtensionContext,
  action: ManageAction,
  record: MemoryRecord,
  replacement?: MemoryRecord,
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  const details = replacement
    ? `${action}:\n${confirmationRecord(record)}\n\nreplacement:\n${confirmationRecord(replacement)}`
    : `${action}:\n${confirmationRecord(record)}`;
  return ctx.ui.confirm("Review memory change", details);
}

function describe(records: Awaited<ReturnType<MemoryStore["search"]>>): string {
  if (records.length === 0) return "No memories found.";
  return records
    .map(
      (record) =>
        `[${record.id}] ${record.status} ${record.scope} confidence=${record.confidence}\n${record.text}\nprovenance=${record.provenance.source}${record.tags.length ? ` tags=${record.tags.join(",")}` : ""}`,
    )
    .join("\n\n");
}

export default function memoryExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "memory_propose",
    label: "Propose Memory",
    description: "Propose a memory candidate for later human review. This never activates memory.",
    promptSnippet: "Propose durable facts with provenance for human review",
    promptGuidelines: [
      "Use memory_propose only for durable, useful facts; include specific provenance and never submit secrets.",
    ],
    parameters: Type.Object({
      scope: ScopeSchema,
      text: Type.String({ minLength: 1, maxLength: 4000 }),
      source: Type.String({ minLength: 1, maxLength: 500 }),
      confidence: Type.Number({ minimum: 0, maximum: 1 }),
      expiresAt: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String({ maxLength: 100 }), { maxItems: 20 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const record = await new MemoryStore(ctx.cwd, undefined, ctx.isProjectTrusted()).propose({
          scope: params.scope,
          text: params.text,
          provenance: { source: params.source, author: "agent" },
          confidence: params.confidence,
          expiresAt: params.expiresAt,
          tags: params.tags,
        });
        return textResult(
          `Proposed candidate ${record.id}. It is inactive until a human approves it.`,
        );
      } catch {
        fail("Memory proposal was not stored. Check content and storage safety.");
      }
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Search Memory",
    description: "Lexically search reviewed memory and candidates.",
    parameters: Type.Object({
      query: Type.String(),
      statuses: Type.Optional(Type.Array(StatusSchema, { maxItems: 5 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        return textResult(
          describe(
            await new MemoryStore(ctx.cwd, undefined, ctx.isProjectTrusted()).search(params.query, {
              statuses: params.statuses as MemoryStatus[] | undefined,
              limit: params.limit,
            }),
          ),
        );
      } catch {
        fail("Memory search failed because storage could not be read safely.");
      }
    },
  });

  pi.registerTool({
    name: "memory_manage",
    label: "Manage Memory",
    description:
      "Request an approve, reject, delete, or supersede transition. Always requires interactive human confirmation.",
    parameters: Type.Object({
      action: ManageSchema,
      id: Type.String({ minLength: 1 }),
      replacementId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_toolId, params, _signal, _update, ctx) {
      const action = params.action as ManageAction;
      if (!ctx.hasUI) fail(CANCELLED);
      try {
        const store = new MemoryStore(ctx.cwd, undefined, ctx.isProjectTrusted());
        const record = await store.get(params.id);
        if (!record) throw new Error("Memory not found");
        const replacement =
          action === "supersede" && params.replacementId
            ? await store.get(params.replacementId)
            : undefined;
        if (action === "supersede" && !replacement) throw new Error("Replacement memory not found");
        if (!(await confirmManage(ctx, action, record, replacement))) throw new Cancelled();
        const changed = await store.manage(action, record.id, replacement?.id, {
          expectedVersion: record.version,
          expectedStatus: record.status,
        });
        return textResult(`Memory ${changed.id} is now ${changed.status}.`);
      } catch (error) {
        // Declining is a decision, not a malfunction, and is reported as such. Every other
        // failure collapses to one message so the underlying error never travels back.
        if (error instanceof Cancelled) fail(CANCELLED);
        fail("Memory change failed. Verify the identifier and lifecycle transition.");
      }
    },
  });

  pi.registerCommand("memory", {
    description:
      "Search memories or review candidates: /memory search <query> | /memory candidates",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [subcommand = "search", ...rest] = trimmed.split(/\s+/);
      const store = new MemoryStore(ctx.cwd, undefined, ctx.isProjectTrusted());
      try {
        const records =
          subcommand === "candidates"
            ? await store.search(rest.join(" "), { statuses: ["candidate"], limit: 50 })
            : await store.search(subcommand === "search" ? rest.join(" ") : trimmed, {
                statuses: ["active"],
                limit: 20,
              });
        ctx.ui.notify(describe(records), "info");
      } catch {
        ctx.ui.notify("Memory could not be read safely.", "error");
      }
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const content = await retrievalContext(
        new MemoryStore(ctx.cwd, undefined, ctx.isProjectTrusted()),
        event.prompt,
      );
      return content
        ? { message: { customType: "pi-memory", content, display: false } }
        : undefined;
    } catch {
      return undefined;
    }
  });
}

export { MemoryStore, retrievalContext } from "./src/store.js";
export type {
  ManageAction,
  ManageExpectation,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  Provenance,
} from "./src/store.js";
