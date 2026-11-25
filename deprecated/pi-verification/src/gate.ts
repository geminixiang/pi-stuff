import type { VerificationStatus } from "./types.js";
import type { VerificationStore } from "./store.js";

export class AdvisoryVerificationGate {
  readonly store: VerificationStore;
  constructor(store: VerificationStore) {
    this.store = store;
  }

  async next(status: VerificationStatus): Promise<{ attempt: number; budget: number } | null> {
    if (!status.plan || status.state === "passed" || status.state === "inconclusive") return null;
    const fingerprint = status.currentFingerprint?.sha256;
    if (!fingerprint) return null;
    const attempts = await this.store.loadRepairAttempts();
    const attempt = attempts[fingerprint] ?? 0;
    if (attempt >= status.plan.repairBudget) return null;
    attempts[fingerprint] = attempt + 1;
    await this.store.saveRepairAttempts(attempts);
    return { attempt: attempt + 1, budget: status.plan.repairBudget };
  }
}

/** @deprecated Use AdvisoryVerificationGate; extensions cannot block core completion. */
export const VerificationGate = AdvisoryVerificationGate;
