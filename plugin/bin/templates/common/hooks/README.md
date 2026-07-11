# Fadeno enforcement hooks (tier-2)

These files turn Fadeno's **advisory** policies into **enforced**, deterministic
checks that run regardless of any agent's compliance — and protect against human
mistakes too. See `../enforcement.md` for the why.

Nothing here is active until you wire it up.

## `pre-commit`

Blocks dependency-manifest changes (unless `FADENO_APPROVE_DEPS=1`) and obvious
secret files. Activate it:

```bash
ln -s ../../.fadeno/hooks/pre-commit .git/hooks/pre-commit
# or, if you prefer a copy:
cp .fadeno/hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

(If your team uses the `pre-commit` framework or Husky, call this script from
your existing config instead.)

## `.github/workflows/fadeno-guard.yml`

A CI guard that fails PRs with deploy-affecting changes unless a
`deploy-approved` label is present. Active automatically once committed on a repo
using GitHub Actions. Adapt the paths/labels to your project.

## Computing gate conditions deterministically

A reviewer writes `review-report.json` (conforming to
`../schemas/review-report.schema.json`); the gate is then a check, not a
re-prompt:

```bash
fadeno gate <run-id> no_blocking_issues \
  --artifact artifacts/review-report.json
```

Run either from a CI step, a `pre-push` hook, or a Claude Code `Stop` hook
(see `claude-settings.example.json` if present).

The Claude example selects the most recent run as a fallback heuristic. Prefer
an explicitly supplied active run ID when the host exposes one, and do not
swallow a non-zero gate result in the hook.
