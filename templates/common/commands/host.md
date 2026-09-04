---
description: Enable or disable session-scoped Fadeno host-coordinator mode.
argument-hint: [off|task]
---

The user is controlling session-scoped Fadeno host mode. The plugin hook owns
the session state; do not write this policy into `CLAUDE.md`, `AGENTS.md`, or
another repository instruction file.

If the request below is exactly `off`, acknowledge that host mode is disabled
and do not apply the host policy. Otherwise use the Fadeno **host** skill. If a
task follows the activation, begin it immediately under that policy; if no task
was supplied, acknowledge activation briefly and wait for the next request.

Request: $ARGUMENTS
