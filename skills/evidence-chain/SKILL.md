---
name: evidence-chain
description: Evidence chain for engineering claims. Use before saying a fix works, is verified, or has no side effects; when writing claims into a PR; and when the user asks whether something was really tested.
---

# Evidence chain

Every claim the user or a reviewer reads carries one **evidence label**:

- **measured**: you observed it by running the real artifact (command output, test run, app UI).
- **source**: you read it in code or docs, and you name the file.
- **unverified**: neither. Go measure it, ask the user for what you need, or drop the claim.

Write only measured and source claims into PRs and final reports. When a claim turns out wrong, correct it yourself before the user finds it. Name your own mistakes and their repair.

## Research

1. **Read the whole path** at the versions the user runs: the app, the backend or core it talks to, and the client that consumes its output. Clone what is not local.
2. **Archaeology**: run `git log -S '<symbol>'` and `git tag --contains <sha>` to find the commit that introduced the behavior. A regression calls for restoring lost behavior; a new requirement calls for adding behavior. These are different fixes.
3. **Source of truth**: name the component that decides the behavior, for example the core deciding model visibility. Make the consumer follow it instead of duplicating its rules.

Done when you can tell the cause commit by commit and name the single source of truth.

## Tests

- **red/green**: run the new test with the fix reverted. It must fail for the reason the issue describes. Then run it with the fix, where it passes. Record both runs.
- Extend the existing **integration test** that drives the real path, such as a mock server serving every endpoint the code calls. Prefer that over a unit test that calls internals by hand.
- Test data copies the real payload shape and includes a **control case** that must stay unchanged. Without one, a fix that changes everything still passes.
- Assert on the output users actually get: the written file, or the exact list the UI reads. Confirm which list that is before asserting.
- Run the full suite on the base and on the branch, and compare the failure lists. Compare formatter diff counts too. Report pre-existing breakage and keep its fix out of the change.
- When the local toolchain misbehaves, use the version CI pins.

## Experiments

- **Real artifact**: real backend responses, the app's own functions, the real client (CLI, TUI, desktop app). A unit test is not the experiment.
- **Whole-output diff**: compare every item and every field before and after, not just the items the issue names. Side effects show up here.
- **Blast radius**: grep every consumer of the data you changed, such as other integrations sharing a list, and measure each one.
- **Beyond your environment**: the user's setup is one sample. Start an isolated instance on a separate port with a temp config and a mock upstream. Use it to cover what the user lacks: other providers, prefixes, aliases, older versions, a failing dependency.
- **Earn each addition**: for every new field, branch or filter, build the simpler alternative and show the case where it breaks.
- Record versions once: app commit, backend version and commit, client version.

## Safety

- **Live state**: back it up and record its sha256, make the change, restore it, then run `shasum -c`. Prefer a temp home (`CODEX_HOME=...`) to touching real config. On macOS `/tmp` is a symlink; use `/private/tmp` wherever paths are checked for symlinks.
- **Secrets**: the user writes them to a 0600 file in their own shell, never in chat.
  - bash: `read -rs -p "Key: " k`; zsh: `read -rs "k?Key: "`. Wrap it in `( ... )` so `umask` and the variable stay local.
  - Ask for the least-privilege scope and use a free read-only endpoint first.
  - Delete the file afterwards, scan the temp directories for leftovers, and suggest revoking the key.
- **Cost**: state the cost of any paid or account-bound request before sending it, and send the cheapest one that answers the question.
- **Cleanup**: stop the processes you started (check their `cwd` before killing) and delete temp copies of credentials and configs.
