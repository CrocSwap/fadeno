---
name: setup
description: Set up Fadeno's user-scoped executor catalog and host integration. Use when the user asks to set up Fadeno, install its local integration, or diagnose first-run configuration. [fadeno 0.6.0-rc.35]
---

# Fadeno setup

Resolve the CLI first: when `scripts/fadeno.cjs` exists beside this `SKILL.md`, use
that plugin-bundled launcher for every command (invoke it with `node` on
Windows). Otherwise use `fadeno` from `PATH`. Never silently substitute a
different global CLI when the launcher is
present.

Run the resolved executable with the current host identity:

```text
<cli> setup --codex   # from Codex
<cli> setup --claude  # from Claude Code
```

Explain that setup writes user-scoped configuration and may require a fresh host
session for managed host agents. It probes provider CLIs with read-only version
checks, keeps the host-native base selected unless the user explicitly dials
a model, and never silently falls back after an executor is selected. Use only
the line matching the current host; never install another harness's integration.
After setup, use the path status prints on the `use:` line for subsequent commands. The managed runtime self-refreshes from the plugin on every plugin-launched command; setup is needed only for first-time integration. Skills and subagents are loaded at host session start; a fresh session is required to refresh them — no setup or refresh will update the current session.
