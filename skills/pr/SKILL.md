---
name: pr
description: Use when writing or restructuring a PR description that must convince reviewers, especially changes driven by upstream shifts, breaking changes, or design choices. Builds the body as a logical argument (problem → why → changes → compatibility → testing) instead of a changelog, and avoids both padding and over-trimming.
---

# PR

A PR body is an argument. A reviewer who has never seen the issue should be able to read it top to
bottom and agree with the change before opening the diff. Each section answers one question and
leads into the next.

## Sections

Use these in order. Drop a section only when its question has no answer for this change.

1. **Problem** (no heading): what is broken or missing today, with the concrete symptom
   (error message, wrong output, missing capability). Link the issue (`Fixes #N`). One or two
   sentences.
2. **Why this approach**: the context that makes the chosen design the right one. This is the
   section that persuades; never cut it to a bare table.
   - Upstream or external change: a short timeline table (version, date, what changed), then
     two or three sentences of reasoning drawn from it.
   - Design choice: the alternatives considered and why this one wins, in a sentence each.
3. **Changes**: 3–5 bullets of changed behavior, one surface per bullet. Mention a non-obvious
   mechanism only when a reviewer would otherwise ask about it.
4. **Compatibility**: what breaks (name the removed or renamed surfaces), what is unchanged,
   and what still works for older versions or callers. Say why the change is safe in setups
   beyond the one you tested, and list deliberate non-changes with their reason.
5. **Testing**: what was exercised against the real system, as a compact table with similar
   scenarios merged into one row. Add one before/after number when it supports the motivation
   (cost, latency, size). Label the states "Before (main)" and "After (this PR)". When the
   change is visible in a UI, add one annotated before/after screenshot (see `ui-evidence`).
   End with what was not tested.
6. **Evidence** (`<details>`, optional): the full chain for reviewers who want it, such as
   source paths, measurement tables, and the matrix of setups beyond your own. It keeps the body
   short without dropping proof.

## Rules

- One idea per section. If a section needs a second table, merge rows or move detail into the
  Evidence `<details>`.
- Every claim is measured or read in source (see `evidence-chain`). Verify an inferred point
  before writing it; keep "not tested" for what genuinely cannot be tested.
- Size by content, not by habit: a full five-section body is roughly 300–450 words. Under
  ~250 usually means the reasoning was cut; over ~600 usually means repetition or logs.
- Every "before" number must come from the base branch, not an intermediate state of the PR
  branch. If the base branch could not produce it (it failed or lacked the feature), say so.
- Facts must be re-checked at writing time: release dates, versions, counts, error messages.
- Keep private details out of public repositories: no internal hosts, customer names, database
  names, IDs, or keys. Use placeholders or describe evidence generically.
- No command dumps, CI logs, file lists, or review history.

## Workflow

1. Read three recently merged PRs in the repository and match their language and headings.
   When the structure is unclear, propose the section list with one line each before writing.
2. Write a draft and show it; apply it to the PR only after approval, unless told to update
   directly.
3. After a correction or new evidence, rewrite the whole body around the final diff and apply
   it with `gh pr edit --body-file`, rather than appending notes or comments.

## Example skeleton

```markdown
Fixes #846

<Component> was built against <upstream> v1 and fails on v2+: <exact error>.

## Why <approach>

| Version | Released | Change |
|---|---|---|
| ... | ... | ... |

<Two or three sentences: why the timeline makes this approach necessary.>

## Changes

- <surface>: <new behavior>.
- ...

## Compatibility

- **Breaking:** removes <names>; renames <old> to <new>.
- <Unchanged surfaces>.
- <Older versions/callers>: <still works / how>. Verified on <version> only.

## Testing

Live against <system>, <scope>:

| Scenario | Result |
|---|---|
| ... | Pass |

<One before/after number>. <What was not tested>.
```
