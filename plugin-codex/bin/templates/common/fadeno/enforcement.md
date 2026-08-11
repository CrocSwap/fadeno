# Enforcement: advisory vs. enforced

Fadeno targets three tiers of host capability. The **same playbooks** run on all
three; only the host adapter changes.

| Tier | Hosts | Gate / approval enforcement |
|------|-------|------------------------------|
| 1. Instruction-only | Codex, Claude Code | **Advisory** — the model is *asked* to honor `require_user_approval_for`. No hard guarantee. |
| 2. Hook-enabled | CI, pre-commit, Claude Code hooks | **Enforced** — deterministic checks run regardless of model compliance. |
| 3. Compiled runtime (future) | purpose-built orchestrator | **Enforced** at the runtime level. |

> In tier 1, `require_user_approval_for` and gate conditions are *advisory data
> the model is asked to follow* — not guarantees. The portable place for **real**
> enforcement is your git/CI/pre-commit layer, because it is harness-agnostic and
> also protects against human mistakes, not just agent ones.

This file ships **documented stubs**, not wired-up enforcement. The point is that
the data shapes already support enforcement: gate conditions are computable from a
structured judgment artifacts (`schemas/review-report.schema.json` and
`schemas/test-result.schema.json`), and approval categories map to concrete,
detectable actions.

## Example: gate condition as a deterministic check

A reviewer writes `artifacts/review-report.json` conforming to
`review-report.schema.json`. The gate `no_blocking_issues` is then *computable*,
not a re-prompt. The CLI validates the artifact before evaluating it:

```bash
# exit 0 = pass (no blocking issues), exit 1 = fail
fadeno gate <run-id> no_blocking_issues \
  --artifact artifacts/review-report.json
```

A Claude Code `Stop`/`PostToolUse` hook, a CI step, or a future runtime can run
the exact same check. The shipped Claude example uses the most recent run as a
fallback heuristic; when the host exposes an active run ID, pass that explicit
ID instead.

For tests, the structured artifact is `artifacts/test-result.json` and the
corresponding command is `fadeno gate <run-id> tests_pass --artifact
artifacts/test-result.json`. It passes only when `status` is `passed` and
`exit_code` is `0`.

To audit a whole trace rather than a single condition, `fadeno verify <run-id>`
(or `--latest`) recomputes every deterministic claim the ledger makes — schema
validity, a parseable event log, a terminal status, artifact presence, and each
recorded gate result re-evaluated from its artifact. It exits non-zero if any
check fails and never writes to the ledger, so it drops straight into a CI step
or `Stop` hook. `.github/workflows/fadeno-verify.yml` (from `init --with-hooks`)
runs it on every run ledger a PR touches — no valid trace with passing gates, no
merge.

## Example: pre-commit guard for an approval category

`dependency_addition` maps to changes in dependency manifests. A pre-commit hook
makes the approval real:

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit (example — adapt to your stack)
if git diff --cached --name-only | grep -qE '(^|/)(package\.json|package-lock\.json|pnpm-lock\.yaml|requirements\.txt|go\.mod|Cargo\.toml)$'; then
  echo "Dependency manifest changed — requires explicit human approval (Fadeno: dependency_addition)." >&2
  echo "Re-commit with FADENO_APPROVE_DEPS=1 to confirm." >&2
  [ "${FADENO_APPROVE_DEPS:-}" = "1" ] || exit 1
fi
```

## Example: CI guard for deploy-affecting diffs

```yaml
# .github/workflows/fadeno-guard.yml (sketch)
on: [pull_request]
jobs:
  deploy-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Block deploy-affecting changes without the deploy-approved label
        run: |
          changed=$(git diff --name-only origin/${{ github.base_ref }}...HEAD)
          if echo "$changed" | grep -qE '(Dockerfile|^deploy/|^infra/|\.tf$)'; then
            echo "$changed" | grep -qE 'deploy-approved' || {
              echo "Deploy-affecting change without approval (Fadeno: deploy)." >&2; exit 1; }
          fi
```

Keep the advisory and enforced layers in sync: the playbook documents intent;
git/CI/hooks enforce it.
