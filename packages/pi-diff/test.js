const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const vm = require("node:vm");

const lib = { require, module: { exports: {} }, process, setTimeout, clearTimeout, setInterval, clearInterval };
vm.runInNewContext(readFileSync("extensions/pi-diff.js", "utf8"), lib);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
	assert.deepEqual(Array.from(lib.shlex(" --stat  README.md ")), ["--stat", "README.md"]);
	assert.throws(() => lib.shlex('--output="foo bar.patch"'), /not supported/);
	assert.throws(() => lib.shlex("foo\\ bar.txt"), /not supported/);

	assert.equal(lib.githubUrl("git@github.com:owner/repo.git"), "https://github.com/owner/repo");
	assert.equal(lib.githubUrl("https://github.com/owner/repo.git\n"), "https://github.com/owner/repo");
	assert.equal(lib.githubUrl("https://gitlab.com/owner/repo.git"), null);

	const reviewSource = "diff --git a/old.js b/old.js\n--- a/old.js\n+++ b/old.js\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/new.js b/new.js\n--- a/new.js\n+++ b/new.js\n@@ -0,0 +1 @@\n+new\n";
	const reviewSignatures = lib.fileSignatures(reviewSource, ["old.js", "new.js"]);
	const pending = lib.reviewDiff(reviewSource, new Map([["old.js", reviewSignatures["old.js"]]]));
	assert.doesNotMatch(pending, /a\/old\.js/);
	assert.match(pending, /a\/new\.js/);
	assert.equal(lib.formatReviewFeedback([{ path: "new.js", side: "new", line: 1, endLine: 1, body: "Add a test." }]), "Please address the following review comments:\n\nnew.js\n- New line 1: Add a test.");
	assert.match(lib.formatReviewFeedback([{ path: "new.js", side: "new", line: 2, endLine: 5, body: "Extract this." }]), /New lines 2-5: Extract this\./);
	assert.equal(
		lib.formatReviewFeedback([{ path: "new.js", side: "new", line: 2, endLine: 2, body: "Tighten.", excerpt: "const x = 1", stale: true }]),
		"Please address the following review comments:\n\nnew.js\n- New line 2 (`const x = 1`): Tighten. [written against an earlier version of the file; line numbers may be off]",
	);
	assert.match(lib.formatReviewFeedback([{ path: "new.js", side: "new", line: 1, endLine: 1, body: "First\nSecond" }]), /- New line 1: First\n  Second/);
	assert.equal(
		lib.formatReviewFeedback([{ path: "new.js", side: "new", line: 10, endLine: 15, oldLine: 3, oldEndLine: 5, body: "Rework this block.", excerpt: "const y = 2" }]),
		"Please address the following review comments:\n\nnew.js\n- Old lines 3-5 → New lines 10-15 (`const y = 2`): Rework this block.",
	);
	assert.match(lib.formatReviewFeedback([{ path: "new.js", side: "new", line: 7, endLine: 7, oldLine: 4, oldEndLine: 4, body: "Check." }]), /- Old line 4 → New line 7: Check\./);

	const html = lib.page({ cwd: ".", currentPath: "/", title: "t", command: "git diff", diff: "</script>", files: ["a.js", "b.js"], signatures: { "a.js": "123" }, viewed: { "a.js": "123" }, commits: [], repo: { url: "https://github.com/owner/repo", branch: "feature/x" } });
	assert.match(html, /diff2html-ui\.js/);
	assert.match(html, /review-workspace\.js/);
	assert.match(lib.reviewWorkspaceSource(), /new Diff2HtmlUI/);
	assert.match(html, /compare\/feature%2Fx\?expand=1/);
	const reviewHtml = lib.page({ cwd: ".", currentPath: "/", title: "Review queue", command: "git diff", diff: reviewSource, files: ["old.js", "new.js"], signatures: reviewSignatures, commits: [], repo: {}, reviewMode: true });
	assert.match(reviewHtml, /Submit review/);
	assert.match(reviewHtml, /id="pi-diff-state" type="application\/json"/);
	const initialState = JSON.parse(reviewHtml.match(/<script id="pi-diff-state" type="application\/json">([\s\S]*?)<\/script>/)[1]);
	assert.equal(initialState.diff, reviewSource);
	assert.deepEqual(Array.from(initialState.files), ["old.js", "new.js"]);
	const workspaceSource = lib.reviewWorkspaceSource();
	assert.match(workspaceSource, /\/review\/submit/);
	assert.doesNotMatch(reviewHtml, />vs HEAD</);
	assert.match(workspaceSource, /d2h-code-linenumber, \.d2h-code-side-linenumber/);
	assert.match(workspaceSource, /d2h-file-side-diff/);
	assert.match(workspaceSource, /clearSelection\(\);\s*openEditorFromRows\(wrapper, startRow, endRow\)/);
	assert.match(reviewHtml, /Select code or drag line numbers to comment/);
	assert.match(reviewHtml, /review-selection-btn/);
	assert.match(workspaceSource, /addEventListener\("selectionchange"/);
	assert.match(workspaceSource, /"Comment old " \+ bare\(oldRange\.line, oldRange\.endLine\) \+ " \+ new "/);
	assert.match(workspaceSource, /markOldRange\(wrapper, comment, "review-commented"\)/);
	assert.match(workspaceSource, /markOldRange\(wrapper, state, "review-selected"\)/);
	assert.doesNotThrow(() => new Function(workspaceSource), "workspace source must parse");
	assert.match(workspaceSource, /event\.metaKey \|\| event\.ctrlKey/);
	assert.match(workspaceSource, /accept: "application\/json"/);
	assert.match(workspaceSource, /sessionStorage\.setItem\(reviewStorageKey/);
	assert.match(workspaceSource, /review-spacer-row/);

	const { Window } = await import("happy-dom");
	const browser = new Window({ url: "http://127.0.0.1/" });
	browser.document.body.innerHTML = `<link id="server-icon"><span class="server-dot"></span><button class="menu-toggle"></button><div class="scrim"></div><aside class="sidebar"></aside><div class="files"></div><div id="diff"></div><button class="view-mode" data-mode="line-by-line"></button><button class="view-mode" data-mode="side-by-side"></button><div class="review-bar"><span class="review-hint"></span><span class="review-summary"></span><span class="review-error"></span><button class="review-submit"></button></div><script id="pi-diff-state" type="application/json">${lib.scriptJson({ diff: reviewSource, files: ["old.js", "new.js"], signatures: reviewSignatures, reviewMode: true, viewed: {}, emptyMessage: "No diff." })}</script>`;
	browser.EventSource = class { close() {} };
	browser.IntersectionObserver = class { observe() {} disconnect() {} };
	browser.ResizeObserver = class { observe() {} disconnect() {} };
	browser.matchMedia = () => ({ matches: true });
	browser.Diff2HtmlUI = class {
		constructor(target) { this.target = target; }
		draw() { this.target.innerHTML = '<div class="d2h-file-wrapper"><label class="d2h-file-collapse"><input class="d2h-file-collapse-input"></label><div class="d2h-file-diff"></div></div><div class="d2h-file-wrapper"><label class="d2h-file-collapse"><input class="d2h-file-collapse-input"></label><div class="d2h-file-diff"></div></div>'; }
	};
	browser.eval(workspaceSource);
	assert.equal(typeof browser.piDiffReviewWorkspace.draw, "function");
	assert.equal(typeof browser.piDiffReviewWorkspace.refresh, "function");
	assert.equal(browser.document.querySelectorAll(".d2h-file-wrapper").length, 2);
	assert.equal(browser.document.querySelector(".d2h-file-wrapper").dataset.path, "old.js");
	browser.close();
	assert.match(html, /tree\/feature%2Fx/);
	assert.match(html, /<title>pi-diff · feature\/x<\/title>/);
	assert.match(html, /<span class="meta">\. · feature\/x · git diff<\/span>/);
	assert.match(html, /class="logo" href="https:\/\/github\.com\/owner\/repo"/);

	const htmlNoRepo = lib.page({ cwd: ".", currentPath: "/", title: "t", command: "git diff", diff: "", files: [], commits: [], repo: { url: null, branch: null } });
	assert.match(htmlNoRepo, /<span class="logo">pi-diff<\/span>/);
	assert.match(htmlNoRepo, /<link id="server-icon" rel="icon"/);
	assert.match(htmlNoRepo, /<span class="server-dot" title="Diff server connected" aria-label="Diff server connected"><\/span>/);
	assert.match(lib.reviewWorkspaceSource(), /const events = new EventSource\("\/events"\)/);
	assert.match(lib.reviewWorkspaceSource(), /events\.onopen = \(\) => setServerOnline\(true\)/);
	assert.match(lib.reviewWorkspaceSource(), /events\.onerror = \(\) => setServerOnline\(false\)/);
	assert.doesNotMatch(htmlNoRepo, /Restart \/diff/);
	assert.doesNotMatch(htmlNoRepo, /<a class="icon-link"/);
	const extracted = lib.extractFiles("diff --git a/old.txt b/new.txt\ndiff --git a/foo b/foo");
	assert.equal(extracted.length, 2);
	assert.equal(extracted[0], "new.txt");
	assert.equal(extracted[1], "foo");
	assert.equal(lib.extractFiles("not a diff").length, 0);
	assert.deepEqual(Array.from(lib.statusFiles(" M a.js\0?? new.txt\0R  next.txt\0old.txt\0")), ["a.js", "new.txt", "next.txt"]);

	{
		let calls = 0;
		const state = lib.createMonitorState({ debounceMs: 5, changeKey: async () => { calls++; return "same"; }, notify: () => {} });
		state.cwd = ".";
		state.lastKey = "same";
		lib.scheduleReloadCheck("first", state);
		lib.scheduleReloadCheck("second", state);
		await wait(30);
		assert.equal(calls, 1);
		await lib.stopChangeMonitor(state);
	}

	{
		let calls = 0;
		let notifications = 0;
		let release;
		const state = lib.createMonitorState({
			debounceMs: 0,
			changeKey: async () => {
				calls++;
				if (calls === 1) await new Promise((resolve) => { release = resolve; });
				return "changed";
			},
			notify: () => { notifications++; },
			ignoredRoots: async () => [],
		});
		state.cwd = ".";
		state.lastKey = "initial";
		lib.scheduleReloadCheck("first", state, 0);
		await wait(10);
		lib.scheduleReloadCheck("during-flight", state, 0);
		release();
		await wait(30);
		assert.equal(calls, 2);
		assert.equal(notifications, 1);
		await lib.stopChangeMonitor(state);
	}

	{
		const closed = [];
		const state = lib.createMonitorState();
		state.cwd = ".";
		state.debounceTimer = setTimeout(() => {}, 1000);
		state.safetyTimer = setInterval(() => {}, 1000);
		state.workingWatcher = { close: async () => { closed.push("working"); } };
		state.gitWatcher = { close: async () => { closed.push("git"); } };
		await lib.stopChangeMonitor(state);
		assert.deepEqual(closed.sort(), ["git", "working"]);
		assert.equal(state.cwd, null);
		assert.equal(state.workingWatcher, null);
		assert.equal(state.gitWatcher, null);
	}

	assert.match(lib.reviewWorkspaceSource(), /line-by-line.*side-by-side/);
	assert.match(html, /view-mode/);
	assert.doesNotMatch(html, /file-viewed|sidebar-checkbox|file-click/);
	assert.match(lib.reviewWorkspaceSource(), /d2h-file-collapse-input/);
	assert.match(lib.reviewWorkspaceSource(), /dataset\.signature/);
	assert.match(lib.reviewWorkspaceSource(), /fetch\("\/viewed"/);
	assert.match(lib.reviewWorkspaceSource(), /keepalive: true/);
	assert.match(lib.reviewWorkspaceSource(), /d2h-d-none/);
	assert.match(lib.reviewWorkspaceSource(), /setTimeout\(syncDiffViewed, 0\)/);
	assert.doesNotMatch(html, /diff-mobile|diff-desktop/);

	const cwd = mkdtempSync(join(tmpdir(), "pi-diff-test-"));
	try {
		execFileSync("git", ["init", "-q"], { cwd });
		assert.equal(await lib.gitDir(cwd), join(cwd, ".git"));
		assert.deepEqual(Array.from(await lib.commits(cwd)), []);
		await assert.rejects(() => lib.view(cwd, "/nope", []), /Not found/);
		execFileSync("node", ["-e", "require('node:fs').writeFileSync('new.txt', 'hello\\n')"], { cwd });
		const firstKey = await lib.changeKey(cwd);
		const untracked = await lib.view(cwd, "/", []);
		assert.equal(untracked.reviewMode, true);
		assert.match(untracked.diff, /new file mode/);
		assert.deepEqual(Array.from(untracked.files), ["new.txt"]);
		const firstSignature = untracked.signatures["new.txt"];
		execFileSync("node", ["-e", "require('node:fs').appendFileSync('new.txt', 'changed\\n')"], { cwd });
		assert.notEqual(await lib.changeKey(cwd), firstKey);
		assert.notEqual((await lib.view(cwd, "/", [])).signatures["new.txt"], firstSignature);
		execFileSync("node", ["-e", "require('node:fs').writeFileSync('.gitignore', 'ignored/\\n'); require('node:fs').mkdirSync('ignored'); require('node:fs').writeFileSync('ignored/cache.txt', 'skip\\n')"], { cwd });
		const ignored = await lib.ignoredRoots(cwd);
		assert.deepEqual(Array.from(ignored), [join(cwd, "ignored")]);
		const ignoredKey = await lib.changeKey(cwd);
		execFileSync("node", ["-e", "require('node:fs').appendFileSync('ignored/cache.txt', 'still skipped\\n')"], { cwd });
		assert.equal(await lib.changeKey(cwd), ignoredKey);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}

	{
		const cwd = mkdtempSync(join(tmpdir(), "pi-diff-symlink-test-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd });
			execFileSync("node", ["-e", "const fs = require('node:fs'); fs.mkdirSync('target'); fs.symlinkSync('target', 'link', 'dir')"], { cwd });
			const data = await lib.view(cwd, "/", []);
			assert.deepEqual(Array.from(data.files), ["link"]);
			assert.match(data.diff, /new file mode 120000/);
			assert.match(data.diff, /\+target/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}

	{
		const root = mkdtempSync(join(tmpdir(), "pi-diff-worktree-test-"));
		const repo = join(root, "repo");
		const worktree = join(root, "wt");
		try {
			execFileSync("git", ["init", "-q", repo]);
			execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
			execFileSync("node", ["-e", "require('node:fs').writeFileSync('tracked.txt', 'hello\\n')"], { cwd: repo });
			execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
			execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
			execFileSync("git", ["worktree", "add", "-q", "-b", "worktree-test", worktree], { cwd: repo });

			const rawGitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: worktree }).toString().trim();
			const expectedGitDir = rawGitDir.startsWith("/") ? rawGitDir : resolve(worktree, rawGitDir);
			assert.equal(await lib.gitDir(worktree), expectedGitDir);
			assert.equal((await lib.repoInfo(worktree)).branch, "worktree-test");

			execFileSync("node", ["-e", "const fs = require('node:fs'); fs.appendFileSync('tracked.txt', 'changed\\n'); fs.writeFileSync('new.txt', 'new\\n')"], { cwd: worktree });
			const data = await lib.view(worktree, "/", []);
			assert.deepEqual(new Set(data.files), new Set(["tracked.txt", "new.txt"]));
			assert.match(data.diff, /diff --git a\/tracked\.txt b\/tracked\.txt/);
			assert.match(data.diff, /new file mode/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
})();
