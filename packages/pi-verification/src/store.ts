import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { normalizePlan } from "./plan.js";
import type { VerificationEvidence, VerificationPlan } from "./types.js";

// Taken from the host rather than assumed, since CONFIG_DIR_NAME is configurable.
export const STORAGE_RELATIVE_PATH = join(CONFIG_DIR_NAME, "verification-local", "v1");
export const GITIGNORE_SUGGESTION = `${CONFIG_DIR_NAME}/verification-local/`;

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export class VerificationStore {
  readonly directory: string;
  constructor(projectRoot: string) {
    this.directory = join(projectRoot, STORAGE_RELATIVE_PATH);
  }
  async loadPlan(): Promise<VerificationPlan | null> {
    const value = await readJson(join(this.directory, "plan.json"));
    return value === null ? null : normalizePlan(value);
  }
  async savePlan(plan: VerificationPlan): Promise<void> {
    await atomicWrite(join(this.directory, "plan.json"), plan);
  }
  async loadEvidence(): Promise<VerificationEvidence | null> {
    return (await readJson(join(this.directory, "evidence.json"))) as VerificationEvidence | null;
  }
  async saveEvidence(evidence: VerificationEvidence): Promise<void> {
    await atomicWrite(join(this.directory, "evidence.json"), evidence);
  }
  async loadRepairAttempts(): Promise<Record<string, number>> {
    return ((await readJson(join(this.directory, "repair-attempts.json"))) ?? {}) as Record<
      string,
      number
    >;
  }
  async saveRepairAttempts(attempts: Record<string, number>): Promise<void> {
    await atomicWrite(join(this.directory, "repair-attempts.json"), attempts);
  }
}
