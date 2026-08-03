---
name: remember
description: Record a durable decision, preference, convention, or correction into AGENTS.md so it applies in every future session. Use whenever the user states something that should outlive this conversation, even when they did not ask you to write it down.
---

# remember

Append the fact to `AGENTS.md` in the project root. Pi loads that file into context on every session, so a note there takes effect immediately and needs no further action.

## When

Record as soon as any of these appear, without being asked:

- a chosen library, tool, or version, and why
- a convention or constraint the code must follow
- a workflow rule ("always run X before Y")
- a correction to how you worked

Do not record one-off task details, anything already obvious from the code, or secrets.

## How

1. Read `AGENTS.md`. If it does not exist, create it with a `# AGENTS.md` heading.
2. Find the section between `<!-- pi-remember:start -->` and `<!-- pi-remember:end -->`. If absent, append it:

```markdown
<!-- pi-remember:start -->

## Notes

- YYYY-MM-DD the fact, and the reason in one clause

<!-- pi-remember:end -->
```

3. Append one line inside the markers: `- YYYY-MM-DD <fact>; <reason>`.
4. Change nothing outside the markers.
5. If the same fact is already listed, do nothing rather than adding it twice.

If the project has `CLAUDE.md` instead of `AGENTS.md`, write there.
