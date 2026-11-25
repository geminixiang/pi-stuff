# Docs pass with Gemini (agy)

Code is the source of truth. Docs exist only to explain design intent (why it is built this way, what was ruled out) and to lower maintenance cost (how to upgrade, what breaks if X changes). Anything the code already states — parameter lists, field names, behaviour step by step, limits that are constants — does not belong in docs; it drifts and then lies. This is the same reason code carries no comments.

The user dislikes padded docs. Any change that adds or rewrites prose for readers (README, `docs/`, tool descriptions, PR descriptions) gets one tightening pass by Gemini 4 Neon through `agy`, run by the agent that owns the change, in a Rex tab of its own so the manager and the user can watch.

## Run it

From the repo root, after the code change is committed:

```sh
rex window new -s worker "<n> docs pass (agy)" --cwd "$PWD" --focus=false --keep-open -- \
  agy --model gemini-4-neon-high --dangerously-skip-permissions -i "$(cat <<'EOF'
Tighten the docs changed on this branch: <files>.
Code is the source of truth. Keep only: design intent (why this way, what was ruled out and why), what a maintainer must know or do (upgrade steps, external limits not visible in code, links to official docs), and commands a reader runs.
Cut: anything the code already says (parameter lists, field names, step-by-step behaviour, constant values), background the reader doesn't act on, hedging, repeated points, implementation notes.
Prefer a short list or table over paragraphs. Don't change code, names, numbers or links. Don't add new facts.
Show the diff when done.
EOF
)"
```

Use `--model gemini-4-neon-high`; drop to `-medium` for one small file.

## After it

- Read the diff yourself. Revert any change that drops a fact, renames something, or changes a number or link.
- Run the repo's checks (formatters, link checks) and commit the docs as their own commit (`docs: ...`).
- Close the agy tab when done.
