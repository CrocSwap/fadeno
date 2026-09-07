# Redesign — 2026-09-07

The scratchpad these were written in is session-scoped; they live here so they
survive it.

| file | what it is |
| --- | --- |
| `spec.html` | **The spec.** What Fadeno becomes. Four OPEN CALL blocks mark decisions made while drafting rather than in the design session. |
| `decisions.html` | 33 decisions with the reasoning that produced each, plus the measured harness facts. The spec's source. |
| `inventory-2026-09-06.html` | The 45 promises the code made *before* the redesign, with what each cost. Accurate description of the tree as of `fdf3c08`. |

Published copies:

- spec — https://claude.ai/code/artifact/8dc00224-517e-4ddb-a033-ecf0d21cd211
- decisions — https://claude.ai/code/artifact/bf6401ce-0a54-4d53-ae95-593293a8105f
- inventory — https://claude.ai/code/artifact/f7ff4430-8453-4f1d-97e1-085fdefc1f8a

## The one thing to read first

`decisions.html` closes with a table of **harness facts measured from the
binaries** — Codex's spawn parameters, Claude's `SubagentStop` behaviour on the
interrupted path, model/effort precedence. None of it is documented anywhere
citable, each item cost an experiment or a production incident, and the design
depends on all of it. If anything from this redesign survives a change of
direction, it should be that table.
