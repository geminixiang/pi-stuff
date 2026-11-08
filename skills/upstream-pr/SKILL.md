---
name: upstream-pr
description: Upstream PR workflow. Use when the user asks to pick and fix issues in a project's tracker, or to open or improve a pull request to someone else's repository.
---

# Upstream PR

Each step ends on its completion criterion. Research, tests and experiments follow the `evidence-chain` skill. The PR body follows the `pr` skill, and screenshots follow the `ui-evidence` skill.

## 1. Pick

List open issues. For each candidate, check current `main`: many easy-looking issues are already fixed. Prefer issues you can reproduce locally.

Done when one issue is confirmed still broken on `main` and you can point at the code responsible.

## 2. Research

Follow `evidence-chain` → Research.

Done when you have named the commit that caused the issue and the source of truth.

## 3. Fix

- **Size follows understanding**: once the root cause is found, the diff usually shrinks. A long diff signals the cause is still unknown. Small is a result, never a target.
- For a regression, restore the lost behavior rather than add new behavior.
- **Scope**: fix what the issue reports. Anything broader becomes a "Not changed" note in the PR with the reason.
- **Names carry intent**: use intention-revealing variables and small methods (`is_selectable`, `listed_in_catalog`) so the diff reads without code comments.
- Every new field or branch must survive the question "is this necessary?". Show the simpler alternative failing.

Done when the diff covers only the issue and every consumer of the changed data has been checked.

## 4. Verify

Follow `evidence-chain` → Tests and Experiments.

Done when red/green is recorded, before/after is measured on real artifacts, and the whole-output diff is clean or explained.

## 5. Branch and commit

- **Fork**: `gh repo fork <owner>/<repo> --clone=false`, then `git remote add fork <url>`. Keep `origin` pointing at upstream.
- **Branch**: create it from the upstream default branch and leave local `main` equal to upstream.
- **One commit**: rework means `git commit --amend` plus `git push --force-with-lease fork <branch>`, so no wrong commit survives in the PR.
- **Message**: a Conventional subject; a body with `Before:` and `After:` paragraphs; then `Fixes #N`. Write it in the upstream's language.

Done when the PR branch holds exactly one commit and local `main` matches upstream.

## 6. Write and open

Write the body with the `pr` skill, then run `gh pr create --body-file <file>`.

- After opening, read bot comments; some repos retarget the PR to `dev` automatically.
- Ask the user before marking the PR ready for review.

Done when the body passes the `pr` skill's rules and every claim in it is measured or source.
