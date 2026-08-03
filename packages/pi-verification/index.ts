import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TaskClient } from "@geminixiang/pi-supervisor";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { canonicalProjectRoot } from "./src/fingerprint.js";
import { AdvisoryVerificationGate } from "./src/gate.js";
import { LocalTaskClient } from "./src/local-client.js";
import { normalizePlan } from "./src/plan.js";
import { runVerification } from "./src/runner.js";
import { getVerificationStatus } from "./src/status.js";
import { GITIGNORE_SUGGESTION, VerificationStore } from "./src/store.js";
import type { SupervisorTaskClient, VerificationPlan } from "./src/types.js";

export type VerificationExtensionOptions = {
  client?: SupervisorTaskClient;
  allowNonDurableLocalFallback?: boolean;
};

const CheckSchema = Type.Object({
  id: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
  command: Type.String({ minLength: 1 }),
  args: Type.Array(Type.String()),
  cwd: Type.Optional(Type.String({ minLength: 1 })),
  requirement: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("optional")])),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600_000 })),
});
const PlanSchema = Type.Object({
  version: Type.Optional(Type.Literal(1)),
  checks: Type.Array(CheckSchema, { minItems: 1 }),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
  freshness: Type.Optional(Type.Literal("git")),
  repairBudget: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
});
const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
  details: {},
});

function defaultClient(): SupervisorTaskClient {
  const base = process.env.PI_TASKD_HOME ?? join(homedir(), ".pi", "taskd");
  return new TaskClient(process.env.PI_TASKD_SOCKET ?? join(base, "taskd.sock"));
}

async function trustedRoot(ctx: ExtensionContext): Promise<string> {
  const root = await canonicalProjectRoot(ctx.cwd);
  if (ctx.isProjectTrusted()) return root;
  if (!ctx.hasUI)
    throw new Error(
      "verification_run refused: project is not trusted and confirmation UI is unavailable",
    );
  if (
    !(await ctx.ui.confirm(
      "Run project verification?",
      `This runs project-defined commands inside ${root}. Continue?`,
    ))
  )
    throw new Error("verification_run refused by user");
  return root;
}

async function savePlan(cwd: string, value: unknown): Promise<VerificationPlan> {
  const root = await canonicalProjectRoot(cwd);
  const plan = normalizePlan(value);
  await new VerificationStore(root).savePlan(plan);
  return plan;
}

async function executeRun(
  ctx: ExtensionContext,
  client: SupervisorTaskClient,
  signal?: AbortSignal,
) {
  const root = await trustedRoot(ctx);
  const store = new VerificationStore(root);
  const plan = await store.loadPlan();
  if (!plan)
    throw new Error(
      "No verification plan. Configure one with verification_plan or /verify plan <json>.",
    );
  const evidence = await runVerification(root, plan, client, signal);
  await store.saveEvidence(evidence);
  return evidence;
}

export function createVerificationExtension(options: VerificationExtensionOptions = {}) {
  if (options.client && options.allowNonDurableLocalFallback)
    throw new Error("Provide either client or allowNonDurableLocalFallback, not both");
  const client =
    options.client ??
    (options.allowNonDurableLocalFallback ? new LocalTaskClient() : defaultClient());
  return function verificationExtension(pi: ExtensionAPI): void {
    pi.registerTool({
      name: "verification_plan",
      label: "Verification Plan",
      description: `Persist a project-local verification plan. Add ${GITIGNORE_SUGGESTION} to .gitignore.`,
      parameters: PlanSchema,
      async execute(_id, params, _signal, _update, ctx) {
        return text(await savePlan(ctx.cwd, params));
      },
    });
    pi.registerTool({
      name: "verification_run",
      label: "Run Verification",
      description:
        "Run checks through durable taskd supervision and persist redacted, bounded evidence summaries.",
      parameters: Type.Object({}),
      async execute(_id, _params, signal, _update, ctx) {
        return text(await executeRun(ctx, client, signal));
      },
    });
    pi.registerTool({
      name: "verification_status",
      label: "Verification Status",
      description: "Report advisory verification evidence and freshness.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, ctx) {
        return text(await getVerificationStatus(await canonicalProjectRoot(ctx.cwd)));
      },
    });
    pi.registerCommand("verify", {
      description: "Advisory verification: /verify status | run | plan <json>",
      handler: async (args, ctx) => {
        try {
          const trimmed = args.trim();
          if (!trimmed || trimmed === "status") {
            const status = await getVerificationStatus(await canonicalProjectRoot(ctx.cwd));
            ctx.ui.notify(
              `Verification: ${status.state}${status.error ? ` (${status.error})` : ""}`,
              status.state === "passed" ? "info" : "warning",
            );
            return;
          }
          if (trimmed === "run") {
            const evidence = await executeRun(ctx, client, ctx.signal);
            ctx.ui.notify(
              `Verification: ${evidence.status}`,
              evidence.status === "passed" ? "info" : "warning",
            );
            return;
          }
          if (trimmed.startsWith("plan ")) {
            const plan = await savePlan(ctx.cwd, JSON.parse(trimmed.slice(5)));
            ctx.ui.notify(
              `Saved ${plan.checks.length} checks. Add ${GITIGNORE_SUGGESTION} to .gitignore.`,
              "info",
            );
            return;
          }
          ctx.ui.notify("Usage: /verify status | run | plan <json>", "warning");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      },
    });
    pi.on("agent_settled", async (_event, ctx) => {
      if (ctx.hasPendingMessages()) return;
      const root = await canonicalProjectRoot(ctx.cwd).catch(() => undefined);
      if (!root) return;
      const store = new VerificationStore(root);
      const status = await getVerificationStatus(root, store);
      if (status.state === "inconclusive") {
        ctx.ui.notify(
          `Verification advisory gate inconclusive: ${status.error ?? "unknown error"}`,
          "warning",
        );
        return;
      }
      const followUp = await new AdvisoryVerificationGate(store).next(status).catch((error) => {
        ctx.ui.notify(
          `Verification advisory gate inconclusive: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
        return null;
      });
      if (followUp)
        pi.sendUserMessage(
          `Advisory verification is ${status.state}; this extension cannot block core completion. Inspect status, repair required failures, and rerun verification. Repair attempt ${followUp.attempt}/${followUp.budget}.`,
          { deliverAs: "followUp" },
        );
    });
  };
}

export default createVerificationExtension();
export * from "./src/types.js";
export { fingerprint } from "./src/fingerprint.js";
export { AdvisoryVerificationGate, VerificationGate } from "./src/gate.js";
export { LocalTaskClient } from "./src/local-client.js";
export { normalizePlan } from "./src/plan.js";
export { redactAndBound, runVerification } from "./src/runner.js";
export { getVerificationStatus } from "./src/status.js";
export { VerificationStore } from "./src/store.js";
