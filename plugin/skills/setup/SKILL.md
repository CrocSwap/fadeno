---
name: setup
description: Link the Fadeno CLI onto PATH for this user. Use when the user asks to set up Fadeno, install its local integration, or when `fadeno` is not found on PATH. [fadeno 0.6.1]
---

# Fadeno setup

Resolve the CLI first: when `scripts/fadeno.cjs` exists beside this `SKILL.md`,
use that plugin-bundled launcher for every command (invoke it with `node` on
Windows). Otherwise use `fadeno` from `PATH`. Never silently substitute a
different global CLI when the launcher is present.

Run the resolved executable with the current host identity — use only the line
matching the host you are in, and never install another harness's integration:

```text
<cli> setup --codex   # from Codex
<cli> setup --claude  # from Claude Code
```

Setup does one thing: it links the CLI at `~/.local/bin/fadeno` (or
`FADENO_BIN_DIR`) pointing at the plugin's own bundled binary. A symlink, not a
copy — so the command always runs whatever the installed plugin holds, and
there is no second CLI to keep in step.

Report what it prints, and act on these three cases:

- **The link directory is not on PATH.** Setup says so. Tell the user the exact
  line to add to their shell profile; do not edit their profile for them.
- **A `fadeno` is already there that Fadeno did not write.** Setup refuses
  rather than replacing it. Show the user the path and let them decide between
  removing it, choosing another directory with `FADENO_BIN_DIR`, and rerunning
  with `--force`.
- **`--claude` adds a permission.** It grants `Bash(fadeno:*)` in the user's own
  Claude settings so agents can run the CLI without a prompt each time. Say so
  plainly; it is their settings file.

Then run `<cli> status`: it reports the routing, whether the link is in place,
and anything that needs a person. Skills and subagents are loaded at host
session start, so a fresh session is required to pick up a new plugin version —
no setup or refresh will update the session you are in.
