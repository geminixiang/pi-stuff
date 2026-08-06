---
name: release
description: "Prepare and publish an npm workspace release from the pi-stuff monorepo. Use when releasing pi-simplify, pi-cicd-status, pi-diff, or pi-mermaid: choose and bump a version, update its changelog, validate the repository, commit and push the bump, and create the package-scoped GitHub release that triggers npm trusted publishing."
---

# pi-stuff Release

Release one workspace at a time from `geminixiang/pi-stuff`.

## Repository conventions

- Branch: `main`
- Remote: `origin`
- GitHub repository: `geminixiang/pi-stuff`
- Workspaces live in `packages/<package>`.
- Supported packages:
  - `pi-simplify` → `@geminixiang/pi-simplify`
  - `pi-cicd-status` → `@geminixiang/pi-cicd-status`
  - `pi-diff` → `@geminixiang/pi-diff`
  - `pi-mermaid` → `@geminixiang/pi-mermaid`
  - `pi-agent-team` → `@geminixiang/pi-agent-team`
- Git tag and GitHub release title: `<package>@<version>`, for example `pi-mermaid@0.1.2`.
- Publishing is performed by `.github/workflows/publish.yml` after the GitHub release is published. Do not run `npm publish` locally.
- Versions containing a prerelease suffix such as `-alpha.`, `-beta.`, or `-rc.` are GitHub prereleases and are published with npm tag `beta`.

If the user did not identify a package and more than one package could plausibly be released, ask which package to release.

## Version rules

- `patch`: bug fixes or maintenance
- `minor`: backward-compatible features
- `major`: breaking changes
- Increment within the same prerelease line, such as `0.2.0-beta.8` → `0.2.0-beta.9`.
- Promote a prerelease by removing its suffix, such as `0.2.0-beta.8` → `0.2.0`.
- Never reuse a version already present on npm:

```bash
npm view @geminixiang/<package> versions --json
```

## Flow

### 1. Identify the workspace and check state

From the repository root:

```bash
git status --short --branch
git branch --show-current
git remote -v
git fetch origin main --tags
git rev-list --left-right --count origin/main...HEAD
```

Read:

- `packages/<package>/package.json`
- `packages/<package>/CHANGELOG.md`, if present
- root `package-lock.json`

Stop and ask before proceeding when:

- the branch is not `main`;
- local `main` is behind or has diverged from `origin/main`;
- unrelated changes are present;
- the target package is ambiguous.

Do not discard, overwrite, or include unrelated work.

### 2. Determine the previous release

Package tags share one repository, so filter by the package prefix:

```bash
git tag --list '<package>@*' --sort=-version:refname | head -20
gh release list --repo geminixiang/pi-stuff --limit 100
```

Use the newest `<package>@<version>` tag as the comparison base. For a package's first monorepo release, there may be no package-scoped tag. In that case, inspect the package changelog and its former repository as historical context, but do not create or import an old tag during the release.

Verify the intended version is unpublished:

```bash
npm view @geminixiang/<package> versions --json
```

### 3. Review changes

If a previous package-scoped tag exists:

```bash
git log --pretty=format:'%h %s' <previous-tag>..HEAD -- packages/<package>
git diff --stat <previous-tag>..HEAD -- packages/<package>
```

If none exists, review the package changelog and the commits affecting its directory:

```bash
git log --pretty=format:'%h %s' -- packages/<package>
git diff --stat HEAD^..HEAD -- packages/<package>
```

Release notes and changelog entries must describe only changes relevant to the selected package.

### 4. Bump the workspace version

Use npm workspaces without creating an automatic commit or tag:

```bash
npm version <version> \
  --workspace ./packages/<package> \
  --no-git-tag-version
```

This must update both the workspace manifest and root lockfile. Verify they agree:

```bash
node -p "require('./packages/<package>/package.json').version"
node -p "require('./package-lock.json').packages['packages/<package>'].version"
```

### 5. Update the package changelog

When `packages/<package>/CHANGELOG.md` exists:

- Keep its existing format and heading style.
- Add the new version above older releases.
- Use today's date in `YYYY-MM-DD` for a stable release.
- Follow the changelog's existing prerelease date convention.
- Include concise, user-visible changes only.
- Keep release-note wording consistent with the changelog.

When the package has no changelog, do not create one solely for a no-code migration release unless the user asks. Mention this in the report.

### 6. Validate

Run the full repository verification because the publish workflow does the same:

```bash
npm ci
npm run verify
npm pack --workspace ./packages/<package> --dry-run
```

Also verify that the expected release tag exactly matches the workflow contract:

```bash
version=$(node -p "require('./packages/<package>/package.json').version")
test "<package>@$version" = "<package>@<version>"
```

Do not continue if validation fails.

### 7. Commit and push

Read and follow the commit skill before committing.

Stage only the selected package's release files and the root lockfile:

```bash
git add packages/<package>/package.json package-lock.json
# Add this only when it exists and was updated:
git add packages/<package>/CHANGELOG.md
git diff --cached --check
git commit -m "chore(<package>): release <version>"
git push origin main
```

Do not use `--no-verify`. Confirm the pushed commit is on `origin/main` before creating the release.

### 8. Draft release notes

Use the selected package's prior release as a style reference when available:

```bash
gh release view <previous-tag> \
  --repo geminixiang/pi-stuff \
  --json tagName,name,body,url,publishedAt
```

For the first monorepo release, consult the former repository's latest release only for writing style if useful.

Write notes to `/tmp/<package>-release-<version>.md`. Prefer concise sections such as:

- `## What's changed`
- `### Highlights`
- `### Notable changes`
- `### Verification`

Do not include raw commit hashes unless requested. Compare links, when used, must reference package-scoped tags in `geminixiang/pi-stuff`.

### 9. Publish the GitHub release

Stable release:

```bash
gh release create '<package>@<version>' \
  --repo geminixiang/pi-stuff \
  --target main \
  --title '<package>@<version>' \
  --notes-file /tmp/<package>-release-<version>.md
```

Prerelease:

```bash
gh release create '<package>@<version>' \
  --repo geminixiang/pi-stuff \
  --target main \
  --title '<package>@<version>' \
  --notes-file /tmp/<package>-release-<version>.md \
  --prerelease
```

If the release already exists, inspect it and use `gh release edit` rather than creating a duplicate.

Publishing the release triggers the trusted-publishing workflow. Do not manually publish to npm.

### 10. Verify publication

Find and watch the workflow run:

```bash
gh run list \
  --repo geminixiang/pi-stuff \
  --workflow publish.yml \
  --limit 5

gh run watch <run-id> --repo geminixiang/pi-stuff --exit-status
```

Then verify npm:

```bash
npm view @geminixiang/<package>@<version> version
npm view @geminixiang/<package> dist-tags --json
```

A successful GitHub release is not enough: report the release as complete only after the workflow succeeds and npm returns the new version.

## Report back

Return:

- package and released version;
- stable or prerelease;
- version-bump commit hash and push status;
- validation commands and results;
- GitHub release URL;
- publish workflow URL and conclusion;
- npm registry version and dist-tag.

## Guardrails

- Release exactly one workspace unless the user explicitly requests several.
- Never publish a package whose version already exists on npm.
- Never run `npm publish` locally; GitHub trusted publishing is the source of truth.
- Never create a release before its version bump is present on `origin/main`.
- Never create an unscoped `v<version>` tag in this monorepo.
- Never include changes from another workspace in the release commit or notes.
- Never report success until npm registry verification passes.
