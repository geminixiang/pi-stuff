#!/usr/bin/env node
/**
 * Denies `git push` unless project verification last passed against exactly this state.
 *
 * Runs as a pi-hooks `tool_call` hook with `blockOnFailure: true`: a non-zero exit denies
 * the call and this script's stderr becomes the reason the agent receives. The command the
 * agent proposed arrives in the environment as JSON, never as an argument, so nothing here
 * is re-parsed by a shell.
 *
 * Deliberately imports nothing. `@geminixiang/pi-verification` publishes TypeScript entry
 * points, so a plain `node` script cannot load it, and requiring a TypeScript loader would
 * make this guard depend on the host project's tooling. It reads the evidence pi-verification
 * already wrote and compares it with git.
 *
 * The comparison is deliberately coarser than pi-verification's own fingerprint, and errs
 * toward denying: a moved HEAD, any modification, any untracked file, or a plan edited since
 * the run all count as stale. It never reports fresh where pi-verification would report stale.
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cwd = process.env.PI_HOOK_CWD ?? process.cwd();

// Every other bash call passes straight through; only a push is gated.
if (!/\bgit\s+push\b/.test(process.env.PI_HOOK_INPUT ?? "")) process.exit(0);

const deny = (reason) => {
  console.error(reason);
  process.exit(1);
};

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const git = async (...args) => (await execFileAsync("git", args, { cwd })).stdout.trim();

const storage = join(cwd, ".pi", "verification-local", "v1");
const planPath = join(storage, "plan.json");

const plan = await readJson(planPath);
if (!plan) deny("no verification plan exists yet — create one with /verify plan");

const evidence = await readJson(join(storage, "evidence.json"));
if (!evidence) deny("verification has never run here — run /verify run");
if (evidence.status !== "passed")
  deny("verification did not pass — fix the failing checks, then run /verify run");

// A plan edited after the run means the recorded evidence answers a different question.
const planChangedAt = (await stat(planPath)).mtime.getTime();
if (planChangedAt > Date.parse(evidence.completedAt))
  deny("the verification plan changed after the last run — run /verify run");

let head;
try {
  head = await git("rev-parse", "HEAD");
} catch {
  deny("could not read git HEAD, so verification freshness cannot be established");
}
if (head !== evidence.fingerprint.head)
  deny(`HEAD moved since verification passed (${evidence.fingerprint.head.slice(0, 8)}) — run /verify run`);

const dirty = await git("status", "--porcelain", "--untracked-files=all");
if (dirty) {
  const entries = dirty.split("\n");
  // Verification's own state changes on every run, so leaving it untracked makes the tree
  // permanently dirty — for this guard and for pi-verification's fingerprint alike. That is
  // a setup mistake with a confusing symptom, so it is named rather than counted.
  if (entries.every((entry) => entry.slice(3).startsWith(".pi/")))
    deny(
      "verification state is not ignored by git, so the tree never looks clean — " +
        "add .pi/verification-local/ and .pi/memory/ to .gitignore",
    );
  deny(`${entries.length} uncommitted change(s) since verification passed — run /verify run`);
}

process.exit(0);
