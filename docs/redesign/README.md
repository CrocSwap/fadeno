# Redesign — 2026-09-07

The scratchpad these were written in is session-scoped; they live here so they
survive it.

| file | what it is |
| --- | --- |
| `spec.html` | **The spec.** What Fadeno is. Draft 3: amended 2026-09-07 to name the four verbs the hooks call, the lane decision, and the stopped row's `model_observed` — the surface as built. |
| `decisions.html` | 34 decisions with the reasoning that produced each, plus the measured harness facts. The spec's source. |
| `inventory-2026-09-06.html` | The 45 promises the code made *before* the redesign, with what each cost. Accurate description of the tree as of `fdf3c08`. |
| `lessons.md` | One line per behaviour the tests had learned that the rebuild must keep, in the spec's vocabulary, tagged with its source test. Harvested at `fc5e1ae` before the trunk rewrite; also lists what is deliberately NOT carried. |

Published copies:

- spec — https://claude.ai/code/artifact/8dc00224-517e-4ddb-a033-ecf0d21cd211
- decisions — https://claude.ai/code/artifact/bf6401ce-0a54-4d53-ae95-593293a8105f
- inventory — https://claude.ai/code/artifact/f7ff4430-8453-4f1d-97e1-085fdefc1f8a

## Status

The spec is **built**. The trunk, the hook family, the dial/setup/status
surfaces and the catalog trim all shipped between 2026-09-07 and the commits
that follow; `docs/architecture.md` describes the result. The one item the spec
claims that the code does not yet deliver is a true **Codex host lane** — a
Codex hook can refuse a spawn but not rewrite one, so an archetype spawn there
is refused with the command that runs it instead of being delivered in-session.

## The one thing to read first

`decisions.html` closes with a table of **harness facts measured from the
binaries** — Codex's spawn parameters, Claude's `SubagentStop` behaviour on the
interrupted path, model/effort precedence. None of it is documented anywhere
citable, each item cost an experiment or a production incident, and the design
depends on all of it. If anything from this redesign survives a change of
direction, it should be that table.
