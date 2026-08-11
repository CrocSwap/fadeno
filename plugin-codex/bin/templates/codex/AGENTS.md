# Fadeno

This repository uses Fadeno playbooks in `.fadeno/playbooks`.

For complex coding, review, research, or multi-step tasks, prefer the
`$fadeno-runner` skill. Use `$fadeno-driver` to drive or resume a run via
`fadeno next` and CLI role dispatch (cross-harness). Use `$fadeno-builder` when
the user wants to create or modify a reusable playbook.

Do not treat `.fadeno/runs/` as source code; it contains execution traces and
artifacts.
