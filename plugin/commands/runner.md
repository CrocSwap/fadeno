---
description: Run a Fadeno playbook from .fadeno/playbooks on a task, recording a run ledger.
argument-hint: [playbook] on "[task]"
---

The user wants to **run a Fadeno playbook**.

Use the Fadeno **runner** skill and follow its procedure: pick the playbook (use
the one named below if given, otherwise the best match by `when_to_use`), create a
run ledger under `.fadeno/runs/<timestamp>-<slug>/`, execute each step with role
subagents when available (degrade to separate role-passes otherwise), apply gates
from structured judgment artifacts (never inline "ask the model"), respect loop
limits, and return what changed, the checks performed, and the run directory path.

Request: $ARGUMENTS
