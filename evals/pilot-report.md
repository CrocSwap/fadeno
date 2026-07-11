# Milestone 1 evaluation pilot

## Decision

The evaluation suite is sufficient as a baseline for the current product stage. Freeze fixture and repetition expansion until a product change, real workflow, or new falsifiable hypothesis requires it. The pilot supports Fadeno's traceability claim; it does not show improved coding correctness.

## Scope

- Fadeno capability pinned to commit `a5e3dd3`.
- Host/model label: Codex.
- Five fixtures, three treatments, two repetitions: 30 valid runs.
- Treatments: `plain-prompt`, `careful-skill`, and `fadeno-degraded`.
- Three initial procedure-discovery cells and one retry were retained as setup failures and excluded from treatment evidence.
- Deterministic fixture oracles scored repository outcomes. Fadeno traces were scored separately from transcript-derived observations.

## Raw outcome counts

| Treatment | Valid runs | Passed | Correctly unresolved | Durable trace detected | Trace terminal agreed with oracle | Review schema valid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Plain prompt | 10 | 6 | 4 | 0 | unavailable | unavailable |
| Careful skill | 10 | 6 | 4 | 0 | unavailable | unavailable |
| Fadeno degraded | 10 | 6 | 4 | 10 | 10 | 10 |

The four unresolved outcomes per treatment are expected: two repetitions each of the immutable review blocker and missing remote-check environment. They are not implementation failures. All treatments preserved the protected boundary rather than manufacturing success.

## What the pilot supports

Fadeno consistently produced parseable, schema-valid evidence that exposed review decisions, gate routing, bounded revision, test results, and terminal status. Its terminal state agreed with the independent oracle in all ten Fadeno runs. Both revision-success repetitions recorded a failed review followed by a bounded successful revision; both revision-exhaustion repetitions recorded the persistent blocker and terminated as unresolved after one revision.

The corrected harness provides independent Git roots and extracts definitions, runner capability, and CLI from the same pinned commit. Fixture smoke checks and scorer provenance tests pass.

## What the pilot does not support

Task outcomes were identical across treatments: six passed and four correctly unresolved. This pilot therefore provides no evidence that Fadeno improves coding correctness relative to either baseline. It also cannot establish production-repository performance, portability to Claude Code, native-subagent value, or comparative cost.

Timing, token, model-call, and tool-call comparisons are incomplete because equivalent host telemetry was unavailable for the non-Fadeno treatments. Fadeno artifact counts and ledger durations must not be presented as a fair cost comparison. The repositories are intentionally small, and agents often implemented the strict cases correctly before review.

## Housekeeping and next use

Generated workspaces, transcripts, and results remain under ignored `evals/results/`. Run `npm run --silent eval:summary` to rediscover locally retained valid `result.yaml` files and emit the raw vectors; the command produces no composite score.

Future evaluation work should be triggered by one of three events: a material protocol change needs regression coverage, real usage reveals a concrete failure hypothesis, or the product is ready for larger representative tasks and native-host comparisons. Product work should otherwise take priority.
