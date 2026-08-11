---
name: fadeno-setup
description: Set up Fadeno's user-scoped executor catalog and native host integration. Use when the user asks to set up Fadeno, install its local integration, or diagnose first-run configuration.
---

# Fadeno setup

Run the bundled Fadeno executable with the current host identity:

```text
fadeno setup --codex   # from Codex
fadeno setup --claude  # from Claude Code
```

Explain that setup writes user-scoped configuration and may require a fresh host
session for managed native agents. It probes provider CLIs with read-only version
checks, keeps `native` selected unless the user explicitly chooses another
loadout, and never silently falls back after an executor is selected. Use only
the line matching the current host; never install another harness's integration.
