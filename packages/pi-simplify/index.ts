/**
 * pi-simplify: Code Review & Cleanup Extension for pi
 *
 * /simplify — reviews changed code for reuse, quality, and efficiency
 * /code-smell — finds structural problems with programmatic checks and agent review
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeSmellWorkflow } from "./src/code-smell/workflow.js";
import { registerSimplifyWorkflow } from "./src/simplify/workflow.js";

export default function simplifyExtension(pi: ExtensionAPI) {
  registerSimplifyWorkflow(pi);
  registerCodeSmellWorkflow(pi);
}
