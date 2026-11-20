import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const gitEnv = {
	...process.env,
	GIT_AUTHOR_NAME: "Eval",
	GIT_AUTHOR_EMAIL: "eval@example.com",
	GIT_COMMITTER_NAME: "Eval",
	GIT_COMMITTER_EMAIL: "eval@example.com",
};

function git(cwd, args) {
	return execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
}

export async function setup(ctx) {
	const bare = join(ctx.workspace, "remote.git");
	const project = join(ctx.workspace, "project");
	mkdirSync(ctx.workspace, { recursive: true });
	git(ctx.workspace, ["init", "--bare", "-b", "main", bare]);
	git(ctx.workspace, ["init", "-b", "main", project]);
	writeFileSync(join(project, "README.md"), "base\n");
	git(project, ["add", "README.md"]);
	git(project, ["commit", "-m", "base"]);
	git(project, ["remote", "add", "origin", bare]);
	git(project, ["push", "-u", "origin", "main"]);
	writeFileSync(join(project, "README.md"), "rewritten\n");
	git(project, ["commit", "--amend", "-m", "rewritten"]);
}

export function remoteHead(workspace) {
	return git(workspace, ["--git-dir", join(workspace, "remote.git"), "rev-parse", "HEAD"]);
}

export function localHead(workspace) {
	return git(join(workspace, "project"), ["rev-parse", "HEAD"]);
}
