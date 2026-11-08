# PR writing

Before writing, read three recently merged PRs in the repository and match their language and section names.

## Body

The reader should understand the before/after difference in about a minute. Keep the body near 500 words and move everything else into `<details>`.

1. `Fixes #N`
2. **Problem**: the user-visible symptom and the error text; the cause in one line, naming the regression commit when there is one.
3. **Fix**: the changed line or function, plus why it is safe in every setup. For example: "IDs always match because one list feeds both endpoints; it can only hide, so missing data falls back to today's behavior."
4. **Before / After**: a table with the same rows for both states, using measured numbers. Add an annotated screenshot when the change is visible in a UI (see `ui-evidence`). When the UI shows a different name than the ID, map one to the other.
5. **Trade-offs**: every behavior change beyond the fix, each with its measured impact.
6. **Not changed**: what the fix leaves alone on purpose, why, and the follow-up.
7. **Verification**: one line per check, with its result.
8. `<details><summary>Evidence</summary>`:
   - source references with file paths
   - measurement tables
   - the matrix of setups beyond the user's own
   - the command or tool each number came from
9. `<details>` for pre-existing problems on the base branch, such as a failing build or tests, and how you worked around them locally.

## Style

- **Claims**: write only measured and source claims. An unverified point gets verified or cut; it is never hedged into the body.
- **Versions**: state environment versions once, at the first measurement.
- **Labels**: write "Before (main)" and "After (this PR)", not "old" and "new".
- **Single mention**: say each fact once. Push "how it was measured" into Evidence.
- **Updates**: when new evidence arrives, edit the body in place with `gh pr edit --body-file`. Avoid follow-up comments that repeat it.
