# Agent configuration cleanup

## Applied

- `AGENTS.override.md` replaces the Prime-generated root guidance in Pi. It scopes Prime rules to environment work and leaves context gathering and verification proportional to the task. The managed files remain untouched.
- `~/.pi/agent/settings.json`: default model changed from `macmini/gpt-5.6-sol` to `macmini/gpt-6-astra`, already present in the enabled model list.
- Five definitions in `~/.pi/agent/agents/` no longer pin an old model, thinking level, or turn count. They use the configured subagent default (`macmini/gpt-6-astra`). Removed mikan-specific global conventions, mandatory full-file reading, fixed check sequences, and verbose report templates. Kept role boundaries, evidence requirements, and protection of unrelated changes.
- Shortened 24 skill descriptions to usage conditions. References, scripts, licensing, and metadata remain intact and load on demand.
- Simplified four skill bodies: debugging no longer requires reproduction gates or hypothesis quotas; research no longer requires delegation and a repository report; prototypes no longer imply production integration or commits; grilling focuses on consequential questions rather than exhaustive serialized interviews.

## Scope and persistence

Repository changes: `AGENTS.override.md`, `.pi/skills/release/SKILL.md`, `packages/pi-agent-team/skills/pi-agent-team/SKILL.md`, `packages/pi-native-web-search/skills/native-web-search/SKILL.md`, and `skills/taiwan-patent/SKILL.md`.

The other 20 skill edits are machine-local, under `~/.agents/skills/` or `~/.pi/agent/skills/`. Skill installation/regeneration may overwrite those edits. Symlinks were followed to their existing source files; no duplicate skill copies were introduced.

## Retained / not changed

- Prime-managed root and environment AGENTS files and five Prime skills.
- External Git package caches and installed Pi/tool implementation prompts.
- `ego-browser/SKILL.md`: the attempted description edit failed with `EPERM`; no permission bypass attempted.
- Model credentials, providers, thinking defaults, enabled tools, and existing user files.

## Verification

- Checked the 24 edited skill frontmatters for names and concise, nonempty descriptions.
- Checked all five agent definitions for frontmatter and removal of model/thinking/turn pins.
- Parsed both model settings and confirmed the main default is enabled.
- Confirmed the installed Pi context loader prioritizes `AGENTS.override.md`.
- Reviewed the repository diff and ran `git diff --check`.
- No application test suite was run: changes are configuration and Markdown only.

Start a new Pi session to use the updated default model and freshly loaded instructions. The current conversation retains previously injected instructions.
