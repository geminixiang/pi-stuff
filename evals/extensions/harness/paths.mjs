import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Repository root (evals/extensions/harness -> repo). */
export const repoRoot = resolve(here, "../../..");
