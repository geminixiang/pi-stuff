import { fingerprint } from "./fingerprint.js";
import type { VerificationStatus } from "./types.js";
import { VerificationStore } from "./store.js";

export async function getVerificationStatus(
  projectRoot: string,
  store = new VerificationStore(projectRoot),
): Promise<VerificationStatus> {
  try {
    const plan = await store.loadPlan();
    const evidence = await store.loadEvidence();
    if (!plan) return { plan: null, evidence, state: "unconfigured" };
    const currentFingerprint = await fingerprint(projectRoot, plan);
    if (!evidence) return { plan, evidence: null, state: "never-run", currentFingerprint };
    if (evidence.fingerprint.sha256 !== currentFingerprint.sha256)
      return { plan, evidence, state: "stale", currentFingerprint };
    return { plan, evidence, state: evidence.status, currentFingerprint };
  } catch (error) {
    return {
      plan: null,
      evidence: null,
      state: "inconclusive",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
