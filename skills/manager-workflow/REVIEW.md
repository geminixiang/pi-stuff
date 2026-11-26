# Review gate

Apply every row that matches what the agent delivered. Anything not verified goes to the user marked 推論.

| Delivered | Check yourself |
|---|---|
| PR | Read the full diff before relaying it; passing CI and tests is not a design review. Against the user's principles: no service-specific logic in shared infra, no code comments, no over-engineering, no fallback that hides errors, same behaviour on every code path (sync and batch). For every new class, wrapper, options type, mapping table or private/internal attribute, ask what breaks if it is removed and whether the framework already does it; if nothing breaks, send it back before telling the user. CI on the head SHA. Plan comment matches the description. |
| Terraform PR | Every stack's plan; only the intended actions; new resource types planned as the deployer SA; manual stacks called out. |
| Release plan (before dispatch) | Read the repo's release pipeline (cloudbuild, deploy/promote scripts) for what happens automatically on tag, e.g. stable tags that auto-promote to 100%. Write the plan around that, not around a generic canary. |
| Release / apply | Build log `actions=` lines equal the reviewed plan; `Idempotency check passed`; live resource read back; final plan `No changes`. |
| Status claim (state, time, count) | Re-query the source (DB, API, log). Do not copy the agent's numbers. |
| Anything going onto GitHub (comment, issue, PR description) that contains facts | Re-check every number, state and claim yourself against the live source in the same turn (gcloud, Monitoring, code at the cited line). Agent reports are leads, not sources. Say how and when each figure was measured. If a fact cannot be checked, leave it out or mark it 推論. |
| Issue / comment draft | Repo's issue template and `CONTRIBUTING.md`; write-as-me voice; every ID linked (GitHub, job queue items, Cloud Build, Console, dashboards); no local paths, secrets or public URLs that leak data; mentions only people the user asked for. |
| Any claim about history ("no one replied", "already decided", "never tried") | Run `uv run scripts/issue-context.py <ref>` and quote the comment or PR that proves it. |
| Agent says it cleaned up (containers, worktrees, servers, temp files) | Check yourself: `docker ps -a`, the paths, listening ports. Stopped containers count as leftovers. |
| Agent asks the user something | Search task notes first — if already decided, answer from the note instead of asking. |
