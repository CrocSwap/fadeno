# Fadeno evaluation suite

This directory contains a deliberately small evaluation harness for comparing agent workflow treatments. It is not a benchmark leaderboard and it does not produce a composite "Fadeno score". Read [design.md](design.md) before running anything.

## Status

The fixtures, isolated oracles, result format, and corrected manual run procedure are ready for a post-Milestone-1 pilot. Batch 1 is pinned to Milestone 1 commit `a5e3dd3`. An initial three-cell Codex procedure run was classified as setup failure after exposing missing capability installation and Git-root isolation; it is not treatment evidence. The preparation path now installs pinned capability for Fadeno treatments and creates an independent committed Git repository for every workspace. The only committed smoke evidence validates fixture and scorer mechanics, not an agent treatment.

## Manual run procedure

From the repository root, create an isolated unit:

```sh
node evals/scripts/prepare-run.mjs --fixture clean-first-pass --treatment careful-skill --host codex --model '<model-id>' --repetition 1 --fadeno-commit a5e3dd3
```

The command prints a run-root. Its `workspace/` is an independent Git repository with a committed fixture baseline, so Fadeno root detection and agent diff review cannot escape into the enclosing repository. Fadeno treatments also receive the runner skill and bundled CLI extracted from the pinned Fadeno commit. Start a fresh host session in `workspace/` and give it the exact `agent-input.md` from the run-root. Do not expose `evals/fixtures/<fixture>/oracle/` to the agent. Preserve the unmodified run-root, including any transcript placed in `raw-artifacts/`.

Copy [host-metadata.example.json](host-metadata.example.json) to `raw-artifacts/host-metadata.json` when host telemetry is available. Record unknown values as `null`; do not estimate tokens. Put transcript-derived measurements only in `workflow_observed` and cite their evidence paths. The scorer writes Fadeno-ledger measurements separately in `workflow_claimed`; neither source overrides the other. This file is also the place to classify a predefined host/setup/harness failure.

When the session ends, score it from the repository root:

```sh
node evals/scripts/score-run.mjs --run-root /absolute/path/to/run-root
```

This writes `result.yaml` (JSON is valid YAML) and prints it. It runs the fixture's oracle against `workspace/`, which is intentionally the only code state the oracle reads. Score every prepared unit, including malformed traces and bad implementations. Re-run only the infrastructure statuses defined in the design.

To make a compact, non-aggregated report from scored runs:

```sh
node evals/scripts/summarize-results.mjs /path/to/run-root/result.yaml ...
```

## Fixture smoke tests

The smoke command creates temporary workspaces, applies each fixture's known-good reference change, and runs the hidden oracle. `test-scorer.mjs` additionally checks sequence, review-schema, loop-exhaustion, and provenance separation. Neither runs an agent treatment:

```sh
node evals/scripts/smoke-fixtures.mjs
node evals/scripts/test-scorer.mjs
```

Generated runs and raw transcripts belong outside Git. `evals/results/` is a convenient ignored local location when no external results store is available.
