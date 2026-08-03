import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256 } from "./plan.js";
import type { VerificationFingerprint, VerificationPlan } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILE_BYTES = 16 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(`git ${args.join(" ")} failed: ${failure.stderr ?? failure.message}`);
  }
}

export async function canonicalProjectRoot(projectRoot: string): Promise<string> {
  const root = await realpath(projectRoot);
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("project root is not a directory");
  return root;
}

export async function resolveProjectCwd(projectRoot: string, cwd?: string): Promise<string> {
  const root = await canonicalProjectRoot(projectRoot);
  const candidate = await realpath(resolve(root, cwd ?? "."));
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`check cwd escapes project root: ${cwd}`);
  if (!(await lstat(candidate)).isDirectory())
    throw new Error(`check cwd is not a directory: ${cwd}`);
  return candidate;
}

async function untrackedFingerprint(projectRoot: string): Promise<string> {
  const output = await git(projectRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ".",
    ":(exclude).pi/verification-local/**",
  ]);
  const files = output.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  for (const name of files) {
    const path = resolve(projectRoot, name);
    const info = await lstat(path);
    hash.update(`${name}\0${info.mode}\0${info.size}\0`);
    if (info.isSymbolicLink()) {
      hash.update(`symlink:${await readlink(path)}`);
    } else if (info.isFile()) {
      if (info.size <= MAX_UNTRACKED_FILE_BYTES) hash.update(await readFile(path));
      else hash.update(`oversize:${info.size}:${info.mtimeMs}`);
    } else {
      hash.update(`type:${info.mode & 0o170000}`);
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function fingerprint(
  projectRoot: string,
  plan: VerificationPlan,
): Promise<VerificationFingerprint> {
  const root = await canonicalProjectRoot(projectRoot);
  const [head, worktreeDiff, cachedDiff, untrackedSha256] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["diff", "--no-ext-diff", "--binary"]),
    git(root, ["diff", "--cached", "--no-ext-diff", "--binary"]),
    untrackedFingerprint(root),
  ]);
  const parts = {
    head: head.trim(),
    worktreeDiffSha256: sha256(worktreeDiff),
    cachedDiffSha256: sha256(cachedDiff),
    untrackedSha256,
    planSha256: sha256(canonicalJson(plan)),
  };
  return { ...parts, sha256: sha256(canonicalJson(parts)) };
}
