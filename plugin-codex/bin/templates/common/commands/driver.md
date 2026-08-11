---
description: Drive a Fadeno run — engine-first (fadeno drive), manual fadeno next loop as fallback (cross-harness).
argument-hint: [run-id]
---

The user wants to **drive or resume a Fadeno run** with the driver skill.

Use the Fadeno **driver** skill: prefer the engine — `fadeno drive <run>` —
which dispatches bound executors, validates outputs, and pauses at human gates
(resolve with `fadeno decide <run> <option>`, then re-drive). Fall back to the
manual loop (`fadeno next` + `fadeno prompt … | {claude -p, codex exec -}` +
`fadeno gate`) for steps the engine hands back. Return the terminal summary and
run path.

Run id / request: $ARGUMENTS
