---
name: cicd-status
description: Check CI/CD status from GitHub check runs for a branch, PR, commit, release tag, deployment, or recent pipeline. Use when asked to inspect CI, CD, deployment, workflow, build, or pipeline status in a GitHub repo.
---

# cicd-status

Check CI/CD status through GitHub Checks first. Many CI/CD providers, including GitHub Actions and external systems like Google Cloud Build, report their status back to GitHub as check runs.

## Core workflow

1. Identify repo and target ref:
   ```sh
   git remote -v
   git rev-parse HEAD
   git rev-parse --short HEAD
   git tag --points-at HEAD
   ```

   - If the user provides a tag, branch, PR, SHA, or GitHub run/check URL, use that.
   - Otherwise use current `HEAD`.

2. Query GitHub check runs for the target ref:
   ```sh
   gh api repos/<owner>/<repo>/commits/<ref-or-sha>/check-runs \
     --jq '.check_runs[] | {id,name,status,conclusion,details_url,started_at,completed_at,app:.app.name}'
   ```

3. Pick the check run matching the user intent:
   - For CD / deployment / release / tag requests, prefer check names containing `release`, `deploy`, `deployment`, or matching the tag context.
   - For CI / branch / PR requests, prefer branch, test, lint, build, or PR check names.
   - If multiple checks match, report the primary one and briefly mention related checks.

4. If the user gives a GitHub `/runs/<id>` URL:
   - First try GitHub Actions:
     ```sh
     gh run view <id>
     ```
   - If it returns 404, treat it as a GitHub Check Run id:
     ```sh
     gh api repos/<owner>/<repo>/check-runs/<id>
     ```

5. Only use provider-specific APIs when GitHub Checks are missing, incomplete, or the user asks for deeper logs.
   - Use `details_url` from the check run as the provider log URL.
   - Do not dump full check output or logs unless needed; external providers may include secrets in logs.

## Final response

Report concisely:

- Provider / GitHub App (`app.name`)
- Check name
- Status and conclusion
- Ref / tag / branch / commit
- Check run ID
- Log URL (`details_url`)
