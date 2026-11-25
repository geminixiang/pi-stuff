# Docs pass with Gemini (agy)

The user dislikes padded docs. Any change that adds or rewrites prose for readers (README, `docs/`, tool descriptions, PR descriptions) gets one tightening pass by Gemini 4 Neon through `agy`, run by the agent that owns the change, in a Rex tab of its own so the manager and the user can watch.

## Run it

From the repo root, after the code change is committed:

```sh
rex window new -s worker "<n> docs pass (agy)" --cwd "$PWD" --focus=false --keep-open -- \
  agy --model gemini-4-neon-high --mode accept-edits -i "$(cat <<'EOF'
Tighten the docs changed on this branch: <files>.
Keep: what the reader must do or must know to use it correctly, commands, names, limits, links to official docs.
Cut: background the reader doesn't act on, restating the code, hedging, repeated points, implementation notes.
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
