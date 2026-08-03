# @geminixiang/pi-cicd-status

A focused [Pi coding agent](https://github.com/badlogic/pi-mono) skill for inspecting CI/CD status through GitHub check runs and workflow runs.

## Install

```sh
pi install npm:@geminixiang/pi-cicd-status
```

## Included skill

- **cicd-status** — check pipelines for a branch, pull request, commit, release tag, or deployment and report the provider, result, check-run ID, and logs URL.

The skill expects the GitHub CLI (`gh`) to be installed and authenticated for the target repository.
