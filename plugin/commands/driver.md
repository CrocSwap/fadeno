---
description: Drive a Fadeno run via fadeno next + uniform CLI role dispatch (cross-harness).
argument-hint: [run-id]
---

The user wants to **drive or resume a Fadeno run** with the driver skill
(cross-harness CLI dispatch, `fadeno next` cursor).

Use the Fadeno **driver** skill: loop on `fadeno next <run>`, dispatch promptable
steps with `fadeno prompt … | {claude -p, codex exec -}`, evaluate gates with
`fadeno gate`, pause and return to the host on `blocked_human_gate`, and resume
when a `human_decision` is recorded. Return the terminal summary and run path.

Run id / request: $ARGUMENTS
