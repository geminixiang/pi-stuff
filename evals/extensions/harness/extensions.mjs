import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths.mjs";

export const LIVE_KEY_ENV = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GROQ_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
	"MISTRAL_API_KEY",
	"DEEPSEEK_API_KEY",
	"GROK_API_KEY",
];

export function hasLiveKey(env = process.env) {
	return LIVE_KEY_ENV.some((name) => typeof env[name] === "string" && env[name].trim() !== "");
}

export function findPi(explicit) {
	if (explicit) return explicit;
	const local = join(repoRoot, "node_modules", ".bin", "pi");
	if (existsSync(local)) return local;
	return "pi";
}

/**
 * Unpublished monorepo packages. `--extension` / `--skill` load source for
 * this process only. `pi install <path>` with PI_CODING_AGENT_DIR set records
 * the same path in that directory's settings.json and does not copy files.
 */
export function productResourceArgs({ reloadCommand = false } = {}) {
	const args = [
		"--extension",
		join(repoRoot, "packages/pi-bg-bash/extensions/index.ts"),
		"--extension",
		join(repoRoot, "packages/pi-loop/extensions/index.ts"),
		"--extension",
		join(repoRoot, "packages/pi-supervisor/extensions/pi-supervisor.ts"),
		"--skill",
		join(repoRoot, "packages/pi-native-web-search/skills"),
	];
	if (reloadCommand) {
		args.push("--extension", join(repoRoot, "evals/extensions/harness/reload-command.mjs"));
	}
	return args;
}

export function rpcLaunchArgs({ model, provider, offline, reloadCommand }) {
	const args = [
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-mcp",
		"--no-context-files",
		...productResourceArgs({ reloadCommand }),
	];
	if (offline) args.push("--offline");
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	return args;
}
