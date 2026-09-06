import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const REPO = join(import.meta.dirname, '..');

/**
 * Docs-claims tripwires.
 *
 * Each entry pairs a claim made in a doc with the source that implements it:
 * BOTH sides must still match, or the test fails naming the side that drifted.
 * That catches the two silent failure modes — a doc that keeps describing a
 * removed field, and an implemented field the docs stopped mentioning.
 *
 * These are tripwires, NOT proofs. A match means "the token is still there,"
 * not "the prose is correct." So target *stable tokens* — field names, event
 * names, flags, CLI subcommands, exported identifiers — never prose, which
 * rewords freely and would make this test a nuisance.
 *
 * Adding a tripwire is one literal in the table below; read it as a table.
 * A side may carry several patterns (`patterns`) across several files
 * (`files`): every listed file must exist, and every pattern must match in
 * at least one of them (patterns may be split across files).
 */
type Side = {
  /** Files that may carry the claim; every listed file must exist. */
  files: string[];
  /** Stable tokens that must appear. ALL must match, each in at least one file. */
  patterns: RegExp[];
};

type Claim = { id: string; doc: Side; src: Side };

const DIALS = 'docs/experimental/dials-and-registry.md';
/** The catalog v4 design record — successor to DIALS for routes/`--via`. */
const HARNESSES = 'docs/experimental/harness-neutral-dials.md';
const SLOTS = 'docs/experimental/slots-and-archetypes.md';
const LOADOUTS = 'docs/experimental/loadouts-and-dispatch.md';
const EXTENDING = 'docs/extending.md';
const NEXT_PROTOCOL = 'docs/experimental/next-protocol.md';

const CLAIMS: Claim[] = [
  {
    id: 'effective-playbooks-command',
    doc: { files: ['README.md', 'docs/extending.md'], patterns: [/fadeno playbooks/] },
    src: { files: ['src/commands/playbooks.ts', 'src/cli.ts'], patterns: [/runPlaybooks/, /case 'playbooks'/] },
  },
  {
    id: 'two-row-evidence',
    doc: { files: [DIALS], patterns: [/dispatch_requested/, /dispatch_completed/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/dispatch_requested/, /dispatch_completed/] },
  },
  {
    // The lane predicate is the whole of "effort decides the lane"; if either
    // side loses the name, the design doc and the code have diverged on the
    // one decision the feature is.
    id: 'delivery-lane-predicate',
    doc: { files: [SLOTS], patterns: [/decideLane/, /lane_reason/, /hostEffortProven/] },
    src: { files: ['src/lib/lane.ts'], patterns: [/decideLane/, /lane_reason/, /hostEffortProven/] },
  },
  {
    // The trap: keying the lane on the resolved effort instead of the pin
    // inverts the feature. Both names must survive in both places.
    id: 'pinned-vs-effective-effort',
    doc: { files: [SLOTS], patterns: [/pinnedEffort/, /effectiveEffort/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/pinnedEffort/, /effectiveEffort/] },
  },
  {
    // A write-shaped pair is only a comparison if BOTH arms are isolated. If
    // the doc keeps claiming symmetry after someone reverts the primary to
    // the shared tree, the pair silently goes back to comparing a boolean
    // against a diff — the exact failure that looked legitimate for months.
    id: 'write-shaped-pair-symmetry',
    doc: { files: [SLOTS], patterns: [/workspace_mode_degraded/, /baseline_commit/, /local\/pair\//] },
    src: {
      files: ['src/commands/dispatch.ts'],
      patterns: [/workspace_mode_degraded/, /baseline_commit/, /'pair'/],
    },
  },
  {
    // Gitignored output is the one thing a pair silently destroys, so the
    // declaration that opts out of pairing and the detection that reports the
    // loss must both keep their names. Losing either returns this to the
    // silence it was built to end.
    id: 'ignored-output-opt-out',
    doc: { files: [SLOTS], patterns: [/ignored_output/, /kept/, /discardable/] },
    src: {
      files: ['src/lib/executors.ts', 'src/commands/dispatch.ts'],
      patterns: [/ignored_output/, /'kept'/, /'discardable'/],
    },
  },
  {
    // `carry_mutated` is the only signal that a hardlinked path was written
    // through. Losing the name in either place means the hazard is back to
    // being silent, which is how it survived this long.
    id: 'carry-mutation-stamp',
    doc: { files: [SLOTS], patterns: [/carry_mutated/, /nlink/, /ctime/] },
    src: {
      files: ['src/lib/workspace-isolation.ts'],
      patterns: [/carryMutationStamp/, /nlink/, /ctime/],
    },
  },
  {
    id: 'host-refused-row',
    doc: { files: [SLOTS], patterns: [/host_refused/, /resolver_timeout/, /restart_required/] },
    src: {
      files: ['templates/claude/hooks/dispatch-steering.mjs'],
      patterns: [/host_refused/, /resolver_timeout/, /restart_required/],
    },
  },
  {
    id: 'host-delivery-row',
    doc: { files: [DIALS], patterns: [/host_delivery/] },
    src: { files: ['templates/claude/hooks/dispatch-steering.mjs'], patterns: [/host_delivery/] },
  },
  {
    // The base claude lane's shell grant. Both halves have been wrong before:
    // through v4 the docs described a receipts loss and promised a one-line
    // remedy the catalog never carried. If the catalog's argv ever narrows back
    // to a scoped rule (or drops the flag) while the docs keep saying the lane
    // carries the same headless trust as every other vendor, that is the same
    // divergence again — so pin the flag.
    //
    // Re-pointed 2026-09-06: the pinned tokens were `--allowedTools Bash` and
    // `acceptEdits`, the partial grant this lane carried until the posture went
    // blanket. Pinning the blanket flag is the same tripwire on the current
    // fact; pinning the retired pair would have made the test assert a lane
    // nobody ships.
    id: 'claude-command-shell-grant',
    doc: {
      files: [HARNESSES, EXTENDING],
      patterns: [/--dangerously-skip-permissions/],
    },
    src: {
      files: ['templates/common/fadeno/executors.yaml'],
      patterns: [/--dangerously-skip-permissions/],
    },
  },
  {
    // The codex lane's half of the same posture, added 2026-09-06 with it. This
    // is the lane whose restriction people actually hit — `--sandbox
    // workspace-write` denied a worker's SSH twice while the host's own SSH
    // succeeded — so it gets its own tripwire rather than riding on the claude
    // one: a silent revert here would put the denial back with the docs still
    // promising every lane carries a headless-approval flag.
    id: 'codex-command-headless-approval',
    doc: {
      files: [HARNESSES, EXTENDING],
      patterns: [/--dangerously-bypass-approvals-and-sandbox/],
    },
    src: {
      files: ['templates/common/fadeno/executors.yaml'],
      patterns: [/--dangerously-bypass-approvals-and-sandbox/],
    },
  },
  {
    // The Codex steering ladder's only rung. Both halves have failed silently
    // before: a manifest that never registered the script makes the guard
    // inert cargo, and a guard that stops writing its row makes an unsteered
    // spawn indistinguishable from no spawn at all — which is precisely the
    // state the 2026-09-04 receipt was recorded in.
    id: 'codex-spawn-guard',
    doc: {
      files: ['docs/architecture.md'],
      patterns: [/spawn-guard\.mjs/, /native_spawn/, /generic_spawn_in_host_mode/],
    },
    src: {
      files: ['templates/codex/hooks/spawn-guard.mjs', 'templates/codex/hooks/hooks.json'],
      patterns: [/spawn-guard\.mjs/, /native_spawn/, /generic_spawn_in_host_mode/],
    },
  },
  {
    // Codex's precedence rule, which this repo has now asserted BOTH ways.
    // `delegate_to` is only safe to act on because the named file already
    // carries the locked identity, and the runner skill is what tells a
    // coordinator to act on it — so if either side stops stating the rule, the
    // advice to deliver an identity by stating it at spawn time is one edit
    // away from returning.
    //
    // `/takes precedence/` is the header's token rule stretched by exactly one
    // case: it is the operative clause of Codex's own documented sentence ("if
    // a custom agent file sets `model` or `model_reasoning_effort`, the value
    // in the file takes precedence"), quoted rather than paraphrased on every
    // surface, so it is as stable as a field name. Both runner surfaces are
    // registered as carrying the claim; what actually fails a revert of
    // SKILL.md alone is the direction test below, which scans each surface
    // separately. This entry pins that the claim is still made at all.
    id: 'codex-agent-file-precedence',
    doc: {
      files: [
        'templates/common/skills/fadeno-runner/references/runtime.md',
        'templates/common/skills/fadeno-runner/SKILL.md',
      ],
      patterns: [/takes precedence/, /delegate_to/],
    },
    src: {
      files: ['src/lib/codex-agent-file.ts', 'src/commands/steering.ts'],
      patterns: [/takes precedence/, /delegate_to/],
    },
  },
  {
    // Host mode's failure policy lives in two files with no import between
    // them: the hook that reinjects it every turn, and the skill that governs
    // the activation turn. Both halves must keep the claim that a Fadeno
    // failure stops the work, and both must keep the refusal sentence the
    // PreToolUse hooks append — that sentence is the only instruction a host
    // is guaranteed to read at the moment it is tempted to route around a
    // refusal, which is exactly what the 2026-09-04 receipt records it doing.
    id: 'host-mode-failure-policy',
    doc: {
      files: ['templates/common/skills/fadeno-host/SKILL.md'],
      patterns: [/Fadeno failing is a user-facing event/, /Report this refusal to the user/],
    },
    src: {
      files: [
        'templates/common/plugin/host-mode-hook.mjs',
        'templates/claude/hooks/dispatch-steering.mjs',
        'templates/codex/hooks/spawn-guard.mjs',
      ],
      patterns: [/Fadeno failing is a user-facing event/, /Report this refusal to the user/],
    },
  },
  {
    // The rewrite's evidence, and the digest that makes it joinable.
    //
    // Both halves have failed silently before, in the same 2026-09-05 receipt:
    // the hook rewrote a host-eligible spawn onto the dispatch proxy and wrote
    // no row at all, and the kernel rolled the pair on its own decorated
    // snapshot rather than the caller's bytes, so the two processes disagreed
    // about whether a pair existed. A `host_rewritten` row the docs stop
    // describing, or a `caller_prompt_sha256` the kernel stops writing, puts
    // that silence straight back.
    id: 'host-rewritten-evidence',
    doc: {
      files: ['docs/architecture.md', DIALS],
      patterns: [/host_rewritten/, /caller_prompt_sha256/, /shadow_pair_selected/],
    },
    src: {
      files: ['templates/claude/hooks/dispatch-steering.mjs', 'src/commands/dispatch.ts', 'src/commands/dispatches.ts'],
      patterns: [/host_rewritten/, /caller_prompt_sha256/, /shadow_pair_selected/],
    },
  },
  {
    // The one-digest contract itself. The helper is where the definition lives
    // ("before any kernel decoration"); the design doc is where a reader looks
    // for why hook and kernel cannot disagree. If either side loses the name,
    // the next person to add a consumer has nothing telling them which bytes
    // to hash.
    id: 'caller-prompt-digest',
    doc: { files: [SLOTS], patterns: [/callerPromptDigest/, /canonicalCallerPrompt/] },
    src: {
      files: ['src/lib/executors.ts', 'src/commands/dispatch.ts'],
      patterns: [/callerPromptDigest/, /callerPromptSha256/, /canonicalCallerPrompt/],
    },
  },
  {
    // The generic-spawn refusal is symmetric by decision, not by accident: one
    // predicate spelled the same way in both hooks, so a user who enabled host
    // mode gets the same answer from Claude and from Codex.
    id: 'generic-spawn-refusal-symmetry',
    doc: { files: ['docs/architecture.md'], patterns: [/generic_spawn_in_host_mode/, /native_spawn/] },
    src: {
      files: ['templates/claude/hooks/dispatch-steering.mjs', 'templates/codex/hooks/spawn-guard.mjs'],
      patterns: [/generic_spawn_in_host_mode/, /native_spawn/],
    },
  },
  {
    id: 'write-access-field',
    doc: { files: [DIALS, EXTENDING], patterns: [/write_access/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/write_access/] },
  },
  {
    id: 'requires-write-field',
    doc: { files: [DIALS], patterns: [/requires_write/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/requires_write/] },
  },
  {
    id: 'dispatch-nesting-guard',
    doc: { files: [NEXT_PROTOCOL], patterns: [/FADENO_IN_DISPATCH/, /FADENO_DISPATCH_NESTING/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/FADENO_IN_DISPATCH/, /FADENO_DISPATCH_NESTING/] },
  },
  {
    id: 'relay-attestation',
    doc: { files: [DIALS], patterns: [/relay_attested/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/relay_attested/] },
  },
  {
    // The refusal, not just the mark. A doc that still says the attestation is
    // "evidence-only" while the kernel refuses on it describes a Fadeno that
    // ships a success verdict over an altered prompt — which is the exact
    // failure this predicate was added to stop (E25, 2026-09-06). All three
    // tokens travel together: the predicate names the refusal, the flag is the
    // only way past it, and the field is what proves a person used the flag.
    id: 'relay-fidelity-refusal',
    doc: {
      files: [LOADOUTS, 'docs/architecture.md'],
      patterns: [/relay_fidelity/, /--allow-relay-mismatch/, /relay_mismatch_allowed/, /refus/],
    },
    src: {
      files: ['src/commands/dispatch.ts', 'src/commands/dispatches.ts', 'src/cli.ts'],
      patterns: [/'relay_fidelity'/, /--allow-relay-mismatch/, /relay_mismatch_allowed/, /allowRelayMismatch/],
    },
  },
  {
    id: 'stdin-relay-contract',
    doc: { files: [DIALS], patterns: [/FADENO_PROMPT/] },
    src: { files: ['templates/claude/claude-agents/dispatch-worker.md'], patterns: [/FADENO_PROMPT/] },
  },
  {
    id: 'surface-version-stamp',
    doc: { files: [DIALS, EXTENDING], patterns: [/\[fadeno /] },
    src: { files: ['src/commands/plugin.ts'], patterns: [/stampSurfaceVersion/] },
  },
  {
    id: 'schema-v4-catalog',
    doc: { files: [HARNESSES], patterns: [/schema_version: 4/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/schema_version: 4/, /schemaVersion/] },
  },
  {
    // The whole shape of the v4 bump: one table keyed by harness id, and the
    // fall-through key renamed with it. A doc that still describes `routes:`
    // while the loader refuses it is a design record for a product nobody has.
    id: 'harness-table',
    doc: { files: [HARNESSES], patterns: [/harnesses:/, /unregistered_model_harness/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/'harnesses'/, /'unregistered_model_harness'/] },
  },
  {
    // A relay belongs to the harness it forwards from, under `host:`.
    id: 'harness-host-relay',
    doc: { files: [HARNESSES], patterns: [/harnesses\.codex\.host\.relay/, /host\.relay/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/host\?\.relay/] },
  },
  {
    id: 'dispatches-command',
    doc: { files: [EXTENDING], patterns: [/fadeno dispatches/] },
    src: { files: ['src/cli.ts'], patterns: [/dispatches/] },
  },
  {
    id: 'hook-version-stamp',
    doc: { files: [DIALS], patterns: [/hook_version/] },
    src: { files: ['templates/claude/hooks/dispatch-steering.mjs'], patterns: [/HOOK_VERSION/] },
  },
  {
    id: 'write-conflict-enforcement',
    doc: { files: [DIALS], patterns: [/write_conflict/, /write_access_denied/] },
    src: { files: ['src/commands/steering.ts'], patterns: [/write_conflict/] },
  },
  {
    id: 'dispatches-format',
    doc: { files: [HARNESSES], patterns: [/`DISPATCHES_FORMAT` \*\*1\.1\*\*/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/DISPATCHES_FORMAT = '1\.1'/] },
  },
  {
    id: 'session-dials',
    doc: { files: [DIALS], patterns: [/fadeno dial/, /session dial/] },
    src: { files: ['src/commands/dial.ts'], patterns: [/resolveDialCascade/, /'session'/] },
  },
  {
    id: 'archetype-fallback-chains',
    doc: { files: [DIALS], patterns: [/requires_write: forbidden/, /fallback/, /resolved_via/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/'forbidden'/, /resolvedVia/] },
  },
  {
    id: 'constraint-tiers',
    doc: { files: [DIALS], patterns: [/distinct_provider_from_inputs/, /shadow_only/, /constraints:/] },
    src: {
      files: ['src/lib/executors.ts', 'src/lib/constraints.ts'],
      patterns: [/'shadow_only'/, /distinctProviderFromInputs/, /ConstraintError/],
    },
  },
  {
    id: 'dispatch-output-snapshot',
    doc: { files: [EXTENDING], patterns: [/output_snapshot/, /output_bytes/, /workspace_changed/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/output_snapshot/, /output_bytes/, /workspace_changed/] },
  },
  {
    id: 'shadow-evidence-fields',
    doc: { files: [DIALS, EXTENDING], patterns: [/shadow/, /primary_dispatch_id/, /diff_snapshot/, /shadow_source/] },
    src: { files: ['src/commands/dispatches.ts', 'src/commands/dispatch.ts'], patterns: [/shadow/, /primary_dispatch_id/, /diff_snapshot/, /shadow_source/] },
  },
  {
    // A finite attachment must remain inspectable after it spends its last
    // trigger. This names the persisted counter and the public flag on both
    // sides, so neither silently turns into a transient in-memory limit.
    id: 'shadow-trigger-budget',
    doc: { files: [DIALS, EXTENDING], patterns: [/--n/, /remaining/, /expired/] },
    src: { files: ['src/lib/executors.ts', 'src/commands/dial.ts'], patterns: [/remaining/, /shadowAttachmentExpired/, /--n/] },
  },
  {
    id: 'shadow-bakeoffs-surface',
    doc: { files: [DIALS, EXTENDING], patterns: [/--bakeoffs/, /Bakeoff/] },
    src: { files: ['src/commands/dispatches.ts'], patterns: [/runDispatchesBakeoffs/, /BakeoffArtifact/] },
  },
  {
    id: 'shadow-bakeoffs-tally',
    doc: { files: [DIALS, EXTENDING], patterns: [/prefer_challenger/, /prefer_baseline/] },
    src: { files: ['src/commands/dispatches.ts'], patterns: [/preferChallenger/, /preferBaseline/] },
  },
  {
    id: 'shadow-apply-command',
    doc: {
      files: [EXTENDING, 'docs/experimental/slots-and-archetypes.md'],
      patterns: [/fadeno shadow-apply/, /--3way/],
    },
    src: { files: ['src/commands/shadow-apply.ts', 'src/cli.ts'], patterns: [/runShadowApply/, /--3way/] },
  },
  {
    id: 'models-registry',
    doc: { files: [HARNESSES], patterns: [/models:/, /unregistered_model_harness/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/models:/, /unregisteredModelHarness/] },
  },
  {
    // The user-facing grammar, both halves: the flag and the ref-string form
    // it writes. `--via` and ` via ` are gone from both sides.
    id: 'dial-grammar',
    doc: { files: [HARNESSES], patterns: [/--harness <id>/, /model\[@effort\]\[ on <harness>\]/] },
    src: { files: ['src/cli.ts', 'src/commands/dial.ts'], patterns: [/--harness <id>/, /harness/] },
  },
  {
    id: 'dial-command',
    doc: { files: [DIALS], patterns: [/fadeno dial/] },
    src: { files: ['src/cli.ts'], patterns: [/fadeno dial/] },
  },
  {
    id: 'snapshot-v3',
    doc: { files: [DIALS], patterns: [/snapshot_version: 3/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/snapshot_version: 3/, /snapshot_version/] },
  },
  {
    id: 'effort-encoding',
    doc: { files: [DIALS], patterns: [/effort_encoding/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/effort_encoding/] },
  },
  {
    id: 'models-command-surface',
    doc: { files: [DIALS], patterns: [/fadeno models/] },
    src: { files: ['src/cli.ts'], patterns: [/fadeno models/] },
  },
  {
    id: 'model-add-discovery',
    doc: { files: [DIALS, EXTENDING, HARNESSES], patterns: [/fadeno model add/, /OpenRouter/] },
    src: { files: ['src/commands/models.ts', 'src/cli.ts'], patterns: [/runModelsAdd/, /opencode\/openrouter/] },
  },
  {
    // The permissions cut is the largest deliberate REMOVAL this project has
    // made, and a removal drifts the same way a feature does — by creeping
    // back one helper at a time. The doc states the rule; these literals are
    // what keep the source honest about having followed it.
    id: 'permissions-cut',
    doc: {
      files: ['docs/experimental/permissions-and-isolation.md'],
      patterns: [/no longer supported/, /capability_skew|argv-diff/, /isolation/i],
    },
    src: {
      files: ['src/lib/executors.ts', 'src/commands/bakeoff.ts', 'src/commands/dispatch.ts'],
      patterns: [/is no longer supported/, /capability_skew/, /permissions-and-isolation\.md/],
    },
  },
  {
    // The reconstruction trap, recorded because it is invisible: `git apply`
    // from inside the destination exits 0 and applies NOTHING, leaving a
    // baseline tree wearing an arm's label. The doc says why the applier uses
    // `--directory=` and verifies with `--reverse --check`; if the source
    // ever stops doing either, the doc is describing a safety property the
    // code no longer has.
    id: 'bakeoff-evidence-explored',
    doc: { files: [LOADOUTS], patterns: [/evidence_mode/, /--reverse --check/] },
    src: {
      files: ['src/commands/bakeoff.ts'],
      patterns: [/--directory=\$\{relDest\}/, /'--reverse', '--check'/],
    },
  },
  {
    // The column got its honest name back. It always held the EXECUTOR; the
    // word `harness` was taken by the ambient agent, so the column was renamed
    // `via` — and v4 renamed the other one to `host` instead. The doc records
    // the column and the `(inherits …)` half that had to stay distinct from
    // it; the source must actually print both, or the design record is
    // describing a table nobody sees.
    id: 'dial-harness-column',
    doc: { files: [HARNESSES], patterns: [/effort {2}harness {2}source/, /\(home\)/] },
    src: { files: ['src/cli.ts'], patterns: [/'harness'\.padEnd\(22\)/, /\(inherits \$\{row\.resolvedVia\}\)/] },
  },
  {
    id: 'models-command-probe',
    doc: { files: [DIALS], patterns: [/models_command/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/models_command/] },
  },
  {
    id: 'verification-cache',
    doc: { files: [DIALS], patterns: [/model-verifications/] },
    src: { files: ['src/lib/user-paths.ts'], patterns: [/modelVerificationsFile/, /model-verifications/] },
  },
  {
    // The two halves of registry upkeep. `--strict` is on the list because it
    // is the whole difference between "the backend is down" and "the model is
    // gone", and a README that keeps promising the distinction after the flag
    // is dropped is worse than one that never mentioned it.
    id: 'model-remove-verify-commands',
    doc: { files: ['README.md'], patterns: [/fadeno model remove/, /fadeno models verify/, /--strict/] },
    src: {
      files: ['src/cli.ts', 'src/commands/models-verify.ts'],
      patterns: [/fadeno model remove <alias>/, /runModelsVerify/, /strict/],
    },
  },
  {
    // The inventory is only a guarantee while the docs and the table agree on
    // the exported names; a recipe that names a helper the module dropped
    // sends the next contributor to a function that is not there.
    id: 'persisted-state-inventory',
    doc: {
      files: ['docs/architecture.md', EXTENDING],
      patterns: [/PERSISTED_SURFACES/, /USER_PATH_SURFACE_IDS/, /RUN_COMPANION_ROWS/, /UNVERSIONED_READERS/, /unversionedReaderFor/, /MEMBER_AUDIT_SCAN_LIMIT/, /stampSchemaVersion/, /migratePersistedState/, /auditPersistedState/, /schema_version/],
    },
    src: {
      files: ['src/lib/persisted-state.ts', 'src/commands/setup.ts', 'src/commands/doctor.ts'],
      patterns: [/PERSISTED_SURFACES/, /USER_PATH_SURFACE_IDS/, /RUN_COMPANION_ROWS/, /UNVERSIONED_READERS/, /unversionedReaderFor/, /MEMBER_AUDIT_SCAN_LIMIT/, /stampSchemaVersion/, /migratePersistedState/, /auditPersistedState/, /schema_version/],
    },
  },
  {
    // "A stamp is not a schema" is a claim about named functions, and the
    // whole point is that the validators live beside the readers rather than
    // in the audit. A doc that keeps naming a validator the module dropped —
    // or an audit that quietly goes back to trusting the stamp — is the same
    // silent-wrong-answer this check was added to close.
    id: 'persisted-state-shape-validation',
    doc: {
      files: ['docs/architecture.md', EXTENDING],
      patterns: [
        /SHAPE_VALIDATORS/,
        /shapeValidatorFor/,
        /validateUserDialsDocument/,
        /validateVerificationDocument/,
        /validateLocalDialDocument/,
        /validateInstallationManifestDocument/,
      ],
    },
    src: {
      files: [
        'src/lib/persisted-state.ts',
        'src/lib/user-paths.ts',
        'src/lib/executors.ts',
        'src/lib/installations.ts',
      ],
      patterns: [
        /SHAPE_VALIDATORS/,
        /shapeValidatorFor/,
        /validateUserDialsDocument/,
        /validateVerificationDocument/,
        /validateLocalDialDocument/,
        /validateInstallationManifestDocument/,
      ],
    },
  },
  {
    // One membership rule, two consumers. The doctor and `fadeno models` have
    // to decide "is this dial still listed" with the same function, or the
    // doctor can report a dial healthy that `fadeno dial` would refuse.
    id: 'model-listing-membership',
    doc: {
      files: ['docs/architecture.md', 'CHANGELOG.md'],
      patterns: [/listingContains/, /qualifyListedModelId/, /models_prefix/],
    },
    src: {
      files: ['src/lib/model-listing.ts', 'src/commands/models.ts', 'src/lib/executors.ts'],
      patterns: [/listingContains/, /qualifyListedModelId/, /models_prefix/],
    },
  },
  {
    // The four catalog-rot check ids ARE the user-facing surface of this
    // feature — a doc that keeps promising a check id doctor stopped emitting
    // is worse than one that never named it. `--probe-models` rides along
    // because it is the only reason three of them ever run.
    id: 'catalog-rot-doctor-checks',
    doc: {
      files: ['CHANGELOG.md', 'docs/architecture.md'],
      patterns: [/user-catalog-repairs/, /model-verification-stale/, /model-listing-missing/, /persisted-state:/, /--probe-models/, /VERIFICATION_MAX_AGE_DAYS/],
    },
    src: {
      files: ['src/lib/catalog-rot.ts', 'src/lib/model-listing.ts', 'src/lib/persisted-state.ts', 'src/commands/doctor.ts', 'src/cli.ts', 'src/lib/cli-help.ts'],
      patterns: [/user-catalog-repairs/, /model-verification-stale/, /model-listing-missing/, /persisted-state:/, /--probe-models/, /VERIFICATION_MAX_AGE_DAYS/],
    },
  },
  {
    id: 'engine-cancel-command',
    doc: { files: [EXTENDING, 'README.md'], patterns: [/fadeno cancel/] },
    src: { files: ['src/commands/cancel.ts', 'src/cli.ts'], patterns: [/runCancel/] },
  },
  {
    // RETIRED and replaced: `executor-timeout-route` used to pair the docs'
    // description of a route deadline with the code that ARMED one. Nothing
    // arms one now. The key is still parsed — catalogs written before the
    // removal declare it — and what the docs and the code must agree on is
    // that it is ignored, which is what this token is for. One spelling, three
    // consumers: the loader note, doctor's warning, and this claim.
    id: 'ignored-deadline-key',
    doc: { files: [EXTENDING, 'docs/architecture.md'], patterns: [/no longer runs executors under a deadline/] },
    src: {
      files: ['src/lib/executors.ts', 'src/lib/catalog-rot.ts'],
      patterns: [/IGNORED_DEADLINE_NOTE_TOKEN/, /ignoredDeadlineFindings/],
    },
  },
  {
    // The absence itself is asserted separately (cancel-integration checks the
    // template catalog declares no `timeout_ms`), since presence-pairing
    // cannot assert that something is NOT there.
    id: 'no-executor-deadline',
    doc: { files: [EXTENDING, 'docs/architecture.md'], patterns: [/a clock cannot tell slow from stuck/] },
    src: { files: ['src/lib/supervisor.ts'], patterns: [/a clock cannot tell slow from stuck/] },
  },
  {
    // The two artifact classes that carried no receipt before rc.61. The docs
    // that describe the ledger name both receipts and the checks that hold
    // them; the kernel emits the words they name.
    id: 'collective-provenance',
    doc: { files: ['docs/experimental/next-protocol.md', 'CHANGELOG.md', 'docs/architecture.md'], patterns: [/collective_assembled/, /collective-provenance/] },
    src: { files: ['src/commands/drive.ts', 'src/commands/verify.ts', 'scripts/tamper-matrix.mjs'], patterns: [/collective_assembled/, /collective-provenance/] },
  },
  {
    id: 'tool-recorded-receipt',
    doc: { files: ['docs/experimental/next-protocol.md', 'CHANGELOG.md', EXTENDING, 'templates/common/skills/fadeno-runner/references/runtime.md'], patterns: [/tool_recorded/] },
    src: { files: ['src/commands/tool-complete.ts', 'src/commands/verify.ts', 'scripts/tamper-matrix.mjs'], patterns: [/tool_recorded/, /recorded_by/] },
  },
  {
    // RETIRED: `timeout-cli-override` paired the documented `--timeout
    // <seconds>` with its parser. The flag is gone from both. What replaces it
    // is the pairing for the mechanism that DOES end a long attempt.
    id: 'cancel-ends-an-attempt',
    doc: { files: [EXTENDING, 'README.md'], patterns: [/fadeno cancel/] },
    src: { files: ['src/commands/cancel.ts'], patterns: [/SIGTERM/] },
  },
  {
    // Overlap detection is what replaced the writer lock, and shipping the
    // removal without it would have traded a loud wedge for silent lost
    // writes. The docs and the kernel must name the same receipt field.
    id: 'concurrent-write-receipt',
    doc: { files: [EXTENDING, 'docs/architecture.md'], patterns: [/concurrent_write/] },
    src: {
      files: ['src/lib/workspace-overlap.ts', 'src/commands/dispatch.ts', 'src/commands/drive.ts'],
      patterns: [/concurrent_write/],
    },
  },
  {
    // The other half, and the half that was missing for a release: the stamp
    // above was written by three modules and READ by none, which is the same
    // outcome as never detecting an overlap. Every projection a human meets is
    // named here, so deleting one fails by name rather than quietly restoring
    // the silence.
    id: 'concurrent-write-is-projected',
    doc: { files: [EXTENDING, 'docs/architecture.md'], patterns: [/concurrent-writes/] },
    src: {
      files: ['src/commands/verify.ts', 'src/commands/show.ts', 'src/commands/dispatches.ts'],
      patterns: [/concurrent_write/],
    },
  },
  {
    // A worktree merges back through `git add -A`, which respects .gitignore,
    // so an executor's output at an ignored path is staged by nothing and dies
    // with the worktree. `ignored_output_discarded` says so — and reached only
    // the `dispatches` listing, which is not where the loss was noticed.
    id: 'discarded-output-is-projected',
    doc: { files: [EXTENDING, 'docs/architecture.md'], patterns: [/ignored_output_discarded/] },
    src: {
      files: ['src/commands/verify.ts', 'src/commands/show.ts', 'src/commands/dispatches.ts', 'src/commands/drive.ts'],
      patterns: [/ignored_output_discarded/],
    },
  },
  {
    id: 'idle-output-warning',
    doc: { files: [EXTENDING, 'docs/architecture.md'], patterns: [/OUTPUT_IDLE_WARNING_MS/] },
    src: { files: ['src/commands/show.ts', 'src/cli.ts'], patterns: [/OUTPUT_IDLE_WARNING_MS/] },
  },
  {
    // The host axis has exactly two inputs, both stamped by a harness at call
    // time. A third one — a file remembering "your harness" — is what this
    // pins out: if the resolution expression grows a disk read again, or a doc
    // starts promising a stored default, one side of this fails by name.
    id: 'no-stored-default-harness',
    doc: {
      files: ['docs/architecture.md', LOADOUTS],
      patterns: [/activeHarness\(\)/, /FADENO_HARNESS/],
    },
    src: {
      files: ['src/lib/executors.ts'],
      patterns: [/export function activeHarness/, /detectAmbientHarness\(options\)\.harness \?\? 'standalone'/],
    },
  },
  {
    id: 'neutral-current-host',
    doc: { files: ['README.md', 'docs/architecture.md'], patterns: [/current-host/] },
    src: { files: ['src/commands/steering.ts'], patterns: [/current-host/, /requested_only/] },
  },
  {
    id: 'opencode-steering-runtime',
    doc: { files: [EXTENDING], patterns: [/fadeno-steering\.js/] },
    src: { files: ['templates/opencode/plugin/fadeno-steering.js'], patterns: [/fadeno-steering/] },
  },
  {
    id: 'opencode-background-task-steering',
    doc: { files: [EXTENDING], patterns: [/background: true/, /task_id/, /session_id/, /call_id/] },
    src: { files: ['templates/opencode/plugin/fadeno-steering.js'], patterns: [/background/, /task_id/, /session_id/, /call_id/] },
  },
  {
    id: 'self-contained-user-model-fallback',
    doc: { files: [EXTENDING], patterns: [/modelFallback/, /per-key/] },
    src: { files: ['src/lib/config-layers.ts', 'src/commands/dial.ts'], patterns: [/applyUserModelFallback/, /formatModelFallbackNote/] },
  },
  {
    id: 'opencode-dispatch-tool',
    doc: { files: [EXTENDING], patterns: [/fadeno_dispatch/, /fadeno-dispatch-tool\.js/, /wait_seconds/, /dispatch-watch\.json/, /session\.prompt/] },
    src: { files: ['templates/opencode/plugin/fadeno-dispatch-tool.js'], patterns: [/fadeno_dispatch/, /wait_seconds/, /dispatch-watch\.json/, /session\?\.prompt/] },
  },
  {
    id: 'isolated-host-workspace',
    doc: { files: ['README.md', 'docs/architecture.md'], patterns: [/fadeno dispatch-prepare/, /--isolate/, /workspace_mode: isolated/] },
    src: { files: ['src/commands/dispatch-prepare.ts', 'src/lib/host-workspace.ts'], patterns: [/dispatch-prepare/, /workspace_mode/, /host-worktrees/] },
  },
  {
    id: 'approval-gate-condition',
    doc: { files: ['docs/architecture.md', 'docs/roadmap.md'], patterns: [/all_reviews_approved/] },
    src: { files: ['src/commands/gate.ts'], patterns: [/all_reviews_approved/, /verdict/] },
  },
  {
    id: 'contract-acceptance-gate',
    doc: { files: ['docs/experimental/loadouts-and-dispatch.md'], patterns: [/accept_contract/] },
    src: { files: ['templates/common/fadeno/playbooks/parallel-workstreams.yaml'], patterns: [/accept_contract/, /reaccept_contract/] },
  },
  {
    id: 'event-vocabulary-check',
    doc: { files: ['docs/experimental/next-protocol.md', 'CHANGELOG.md'], patterns: [/event-vocabulary/] },
    src: { files: ['src/commands/verify.ts', 'src/lib/run-ledger.ts'], patterns: [/event-vocabulary/, /LEGACY_EVENT_RENAMES/] },
  },
  {
    id: 'receipt-output-manifests-check',
    doc: { files: ['docs/experimental/next-protocol.md', 'CHANGELOG.md'], patterns: [/receipt-output-manifests/] },
    src: { files: ['src/commands/verify.ts'], patterns: [/receipt-output-manifests/, /output_valid/] },
  },
  {
    id: 'tamper-matrix',
    doc: { files: ['docs/experimental/next-protocol.md'], patterns: [/scripts\/tamper-matrix\.mjs/] },
    src: { files: ['scripts/tamper-matrix.mjs', 'package.json'], patterns: [/baselineVerify/, /tamper-matrix/] },
  },
  {
    // The recovery reader's verdict line. A proxy relayed a deadline-killed
    // executor as "completed" because `--output` printed only the attestation;
    // the skill doc and the four proxy templates now describe the verdict,
    // and the CLI has to keep printing it in those words.
    id: 'dispatch-output-verdict',
    doc: {
      files: [
        'templates/common/skills/fadeno-driver/SKILL.md',
        'templates/claude/claude-agents/dispatch-worker.md',
        'templates/claude/claude-agents/dispatch-reviewer.md',
        'templates/claude/claude-agents/dispatch-judge.md',
        'templates/claude/claude-agents/dispatch-director.md',
        'CHANGELOG.md',
      ],
      patterns: [/TIMED OUT/],
    },
    src: { files: ['src/cli.ts'], patterns: [/TIMED OUT: the kernel killed the executor/, /NO OUTPUT: exit 0/] },
  },
  {
    // Merge-back of a path the workspace holds untracked. The isolation doc
    // and changelog describe the working-tree fallback; the helper is the one
    // place both merge-backs get it from.
    id: 'merge-back-untracked-paths',
    doc: { files: ['docs/experimental/permissions-and-isolation.md', 'CHANGELOG.md'], patterns: [/does not exist in index/] },
    src: { files: ['src/lib/workspace-baseline.ts'], patterns: [/does not exist in index/, /settleIsolatedWork/] },
  },
  {
    // The pull-request model's two ledger words. A conflict round and a
    // human acceptance are attempt reasons the verifier pairs with the
    // unresolved failure they follow; the docs an agent reads name both.
    id: 'merge-conflict-rounds',
    doc: {
      files: ['docs/experimental/permissions-and-isolation.md', 'templates/common/skills/fadeno-driver/SKILL.md', 'CHANGELOG.md'],
      patterns: [/merge_conflict/, /host_resolved/, /attempt-accept/, /dispatches --merge/],
    },
    src: {
      files: ['src/commands/verify.ts', 'src/commands/drive.ts', 'src/commands/dispatches.ts'],
      patterns: [/merge-conflict-rounds/, /'merge_conflict'/, /'host_resolved'/, /MAX_MERGE_CONFLICT_ROUNDS/, /dispatch_merged/],
    },
  },
  {
    id: 'schema-envelope-extraction',
    doc: { files: ['docs/experimental/next-protocol.md'], patterns: [/output_extraction/] },
    src: { files: ['src/lib/schema-envelope.ts'], patterns: [/extractSchemaEnvelope/, /EnvelopeKind/] },
  },
  {
    id: 'envelope-raw-evidence',
    doc: { files: ['docs/experimental/next-protocol.md'], patterns: [/raw_output_sha256/] },
    src: { files: ['src/commands/drive.ts', 'src/lib/host-dispatch.ts'], patterns: [/raw_output_sha256/] },
  },
  {
    id: 'drive-parallel-flag',
    doc: { files: ['docs/experimental/compositional-runtime.md', 'CHANGELOG.md'], patterns: [/--parallel/] },
    src: { files: ['src/commands/drive.ts', 'src/cli.ts'], patterns: [/--parallel/, /DRIVE_PARALLEL/] },
  },
  {
    id: 'drive-parallel-agent-surface',
    doc: { files: ['templates/common/skills/fadeno-runner/references/runtime.md', 'templates/common/skills/fadeno-driver/SKILL.md'], patterns: [/--parallel/] },
    src: { files: ['src/commands/drive.ts', 'src/cli.ts'], patterns: [/--parallel/, /DRIVE_PARALLEL/] },
  },
  {
    id: 'wave-supervisor-lost',
    doc: { files: ['CHANGELOG.md'], patterns: [/supervisor_lost/] },
    src: { files: ['src/commands/drive.ts'], patterns: [/supervisor_lost/] },
  },
  {
    id: 'wave-duration-evidence',
    doc: { files: ['CHANGELOG.md'], patterns: [/duration_ms/] },
    src: { files: ['src/commands/drive.ts'], patterns: [/duration_ms/] },
  },
  {
    id: 'wave-output-unreadable',
    doc: { files: ['CHANGELOG.md'], patterns: [/output_unreadable/] },
    src: { files: ['src/commands/drive.ts'], patterns: [/output_unreadable/] },
  },
  {
    id: 'wave-output-too-large',
    doc: { files: ['CHANGELOG.md'], patterns: [/output_too_large/] },
    src: { files: ['src/commands/drive.ts'], patterns: [/output_too_large/] },
  },
  {
    id: 'tool-run-command',
    doc: { files: ['docs/roadmap.md', 'docs/architecture.md', 'docs/extending.md'], patterns: [/fadeno tool-run/] },
    src: { files: ['src/cli.ts', 'src/commands/tool-run.ts'], patterns: [/tool-run/, /runToolRun/] },
  },
  {
    id: 'tools-registry',
    doc: { files: ['docs/architecture.md', 'docs/extending.md'], patterns: [/tools:/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/tools:/] },
  },
  {
    id: 'tool-lifecycle-events',
    doc: { files: ['docs/architecture.md'], patterns: [/tool_dispatched/, /tool_completed/, /tool_failed/] },
    src: { files: ['src/lib/tool-exec.ts'], patterns: [/tool_dispatched/, /tool_completed/, /tool_failed/] },
  },
  {
    id: 'verify-tool-checks',
    doc: { files: ['docs/roadmap.md', 'docs/architecture.md'], patterns: [/tool-result-coherence/, /tool-command-digest/, /tool-lifecycle/] },
    src: { files: ['src/commands/verify.ts'], patterns: [/tool-result-coherence/, /tool-command-digest/, /tool-lifecycle/] },
  },
  {
    id: 'host-attestation-command',
    doc: {
      files: ['docs/experimental/slots-and-archetypes.md'],
      patterns: [/fadeno attest/, /host_attestation/, /never attested/],
    },
    src: {
      files: ['src/commands/attest.ts', 'src/cli.ts', 'src/commands/dispatches.ts'],
      patterns: [/runAttest/, /host_attestation/, /never attested/],
    },
  },
  {
    // The third terminal receipt. A doc that still enumerates two, or a source
    // that stops minting the event, is the drift this catches.
    id: 'host-dispatch-withdraw',
    doc: {
      files: ['docs/experimental/host-dispatch-contract.md', 'docs/architecture.md'],
      patterns: [/dispatch-withdraw/, /host_dispatch_withdrawn/, /hostRequestTerminalState/],
    },
    src: {
      files: ['src/commands/dispatch-withdraw.ts', 'src/lib/host-dispatch.ts', 'src/cli.ts', 'src/commands/show.ts'],
      patterns: [/runDispatchWithdraw/, /host_dispatch_withdrawn/, /case 'dispatch-withdraw'/, /hostRequestTerminalState/],
    },
  },
  {
    // Producer (agent sidecar) → mirror (supervisor claim) → readers. Losing
    // any name means a live command attempt is silently undescribable again.
    id: 'command-lane-progress-mirror',
    doc: {
      files: ['docs/architecture.md', EXTENDING],
      patterns: [/attempt-progress/, /attemptProgressRelPath/, /readClaimProgress/, /describeIdleOutput/, /progress_source/],
    },
    src: {
      files: ['src/lib/attempt-progress.ts', 'src/lib/supervisor.ts', 'src/commands/drive.ts', 'src/cli.ts'],
      patterns: [/attemptProgressRelPath/, /readClaimProgress/, /describeIdleOutput/, /progress_source/],
    },
  },
  {
    // One spelling of the fix, in one place: `status` and `dial` both print
    // what `codexIdentityRemediation` picks rather than either re-spelling it
    // — and both judge the file `effectiveCodexAgentCandidates` says Codex
    // would load, which is the same rule `doctor` reads. Reading a DIFFERENT
    // file was the 2026-09-06 finding, so the effective-file resolver is named
    // on both sides and not just the constants it selects between.
    id: 'codex-identity-remediation',
    doc: {
      files: ['docs/architecture.md'],
      patterns: [
        /CODEX_IDENTITY_REMEDIATION/,
        /CODEX_PROJECT_IDENTITY_REMEDIATION/,
        /CODEX_UNMANAGED_IDENTITY_REMEDIATION/,
        /codexIdentityRemediation/,
        /codexAgentIdentityStatus/,
        /effectiveCodexAgentCandidates/,
        /not_applicable/,
        // The standing half: the verdict about the file's TEXT rather than its
        // identity, and the one list the renderers write it from. A doc that
        // still describes two standing verdicts, or a source that stops
        // rendering from the list it judges against, is the drift this catches.
        /CODEX_MANAGED_SETTINGS/,
        /codexManagedSettingsBlock/,
        /outdated/,
      ],
    },
    src: {
      files: ['src/lib/codex-agent-file.ts', 'src/commands/status.ts', 'src/commands/dial.ts'],
      patterns: [
        /CODEX_IDENTITY_REMEDIATION/,
        /CODEX_PROJECT_IDENTITY_REMEDIATION/,
        /CODEX_UNMANAGED_IDENTITY_REMEDIATION/,
        /codexIdentityRemediation/,
        /codexAgentIdentityStatus/,
        /effectiveCodexAgentCandidates/,
        /not_applicable/,
        /outdated/,
      ],
    },
  },
  {
    // The command lane's own terminal receipt, and the one list every reader
    // of "is this dispatch over?" consults. A doc that still describes one
    // terminal receipt, or a source that stops minting the event, is the
    // drift this catches.
    id: 'command-dispatch-withdraw',
    doc: {
      files: ['docs/architecture.md', 'templates/common/skills/fadeno-host/SKILL.md'],
      patterns: [/dispatch_withdrawn/, /commandDispatchTerminalState/, /--withdraw/, /--work-left/],
    },
    src: {
      files: ['src/commands/dispatches.ts', 'src/commands/dispatch.ts', 'src/cli.ts'],
      patterns: [/runDispatchesWithdraw/, /dispatch_withdrawn/, /commandDispatchTerminalState/, /work_left/],
    },
  },
  {
    // The role-agent git refusal, and the honest scope beside it. The scope
    // note is the half that rots first: a guard whose limits stop being
    // written down starts being trusted for coverage it does not have.
    id: 'role-agent-git-guard',
    doc: {
      files: ['docs/architecture.md', 'templates/common/skills/fadeno-host/SKILL.md'],
      patterns: [/DESTRUCTIVE_GIT/, /dispatch-proxy-guard\.mjs/, /agent_type/, /partial/],
    },
    src: {
      files: ['templates/claude/hooks/dispatch-proxy-guard.mjs'],
      patterns: [/DESTRUCTIVE_GIT/, /ROLE_RE/, /denyRole/],
    },
  },
  {
    // The recovery procedure a fresh host actually follows. There was none
    // until a Codex director reading these skills in another repo reported
    // that the operating knowledge lived only in a human handoff document, so
    // every new host repeated the earlier mistakes. Each token is a command, a
    // check name, or a receipt field the procedure tells the host to go and
    // read; a source that stops emitting one leaves the skill sending a host
    // to look for output that no longer exists, which is worse than the gap it
    // replaced.
    id: 'host-recovery-procedure',
    doc: {
      files: ['templates/common/skills/fadeno-host/SKILL.md'],
      patterns: [
        /dispatches --withdraw/,
        /dispatch-close/,
        /concurrent-writes/,
        /discarded-output/,
        /--ignored-output/,
        /no leftover writer lease/,
        /host-workspaces/,
      ],
    },
    src: {
      files: [
        'src/commands/dispatches.ts',
        'src/commands/dispatch-adhoc.ts',
        'src/commands/verify.ts',
        'src/commands/doctor.ts',
        'src/lib/host-workspace.ts',
        'src/cli.ts',
      ],
      patterns: [
        /runDispatchesWithdraw/,
        /runDispatchClose/,
        /'concurrent-writes'/,
        /'discarded-output'/,
        /'ignored-output'/,
        /no leftover writer lease/,
        /host-workspaces/,
      ],
    },
  },
  {
    id: 'omp-host-adapter',
    doc: {
      files: ['README.md', 'docs/kickoff-memo.md'],
      patterns: [/init --omp/, /\.omp\/agents/],
    },
    src: {
      files: ['src/commands/init.ts', 'src/lib/executors.ts'],
      patterns: [/case 'omp'/, /'omp' \| 'standalone'/],
    },
  },
];

/**
 * Check one side of a claim. Returns null when it holds, else a failure line
 * naming the entry, the drifted side, the file(s), and the pattern that missed.
 */
function checkSide(id: string, which: 'doc' | 'src', side: Side): string | null {
  const drifted =
    which === 'doc'
      ? 'the doc no longer documents it'
      : 'the source no longer implements it';
  const texts: Array<{ file: string; text: string }> = [];

  for (const file of side.files) {
    try {
      texts.push({ file, text: readFileSync(join(REPO, file), 'utf8') });
    } catch {
      return `[${id}] ${which} side drifted (${drifted}): ${file} is missing`;
    }
  }

  const miss = side.patterns.find((p) => !texts.some((entry) => p.test(entry.text)));
  if (!miss) return null;

  const where = side.files.length > 1 ? `none of ${side.files.join(', ')}` : side.files[0];
  return `[${id}] ${which} side drifted (${drifted}): ${where} does not match ${miss}`;
}

test('documented claims still match the source that implements them', () => {
  const failures: string[] = [];
  for (const claim of CLAIMS) {
    for (const which of ['doc', 'src'] as const) {
      const failure = checkSide(claim.id, which, claim[which]);
      if (failure) failures.push(failure);
    }
  }
  assert.deepEqual(failures, [], `docs/source drift:\n${failures.join('\n')}`);
});

test('the claims registry is well-formed', () => {
  const ids = CLAIMS.map((c) => c.id);
  assert.deepEqual([...new Set(ids)], ids, 'claim ids must be unique');
  for (const claim of CLAIMS) {
    for (const which of ['doc', 'src'] as const) {
      assert.ok(claim[which].files.length > 0, `[${claim.id}] ${which} needs at least one file`);
      assert.ok(claim[which].patterns.length > 0, `[${claim.id}] ${which} needs at least one pattern`);
    }
  }
});

/**
 * The `--parallel` mechanism is described on three surfaces a human or an
 * agent actually reads: the CLI help and the two runner/driver skill docs.
 * They drifted independently — the help kept asserting that command members
 * "serialize whatever you pass", and both skills still explained concurrency
 * as "read-only members overlap, shared writers stay serialized", a mechanism
 * the permissions cut deleted two releases before worktree isolation replaced
 * it. Presence-pairing could not catch that: every file still said
 * `--parallel`, they just said something untrue about it.
 *
 * So this pins the *named mechanism* instead. Every surface must name the one
 * that is implemented (a worktree per member) and must not name the deleted
 * one. Change how concurrency is obtained and all three fail together, which
 * is the point: one truth, three consumers.
 */
const PARALLEL_SURFACES = [
  'src/lib/cli-help.ts',
  'templates/common/skills/fadeno-driver/SKILL.md',
  'templates/common/skills/fadeno-runner/references/runtime.md',
];

test('every --parallel surface names the mechanism that is actually implemented', () => {
  const failures: string[] = [];
  for (const rel of PARALLEL_SURFACES) {
    const lines = readFileSync(join(REPO, rel), 'utf8').split('\n');
    const hits = lines.flatMap((line, i) => (line.includes('--parallel') ? [i] : []));
    if (hits.length === 0) {
      failures.push(`[${rel}] no --parallel passage found; the surface moved or the flag was renamed`);
      continue;
    }
    let explained = 0;
    for (const at of hits) {
      // The passage that explains the flag: the option's own block, or the
      // prose paragraph around the mention. Mentions that make no claim about
      // interleaving — the usage line, the range validator — have nothing to
      // go stale, so only passages that actually discuss it are held to this.
      const window = lines.slice(Math.max(0, at - 2), at + 12).join('\n');
      if (!/concurrent|serializ|overlap/i.test(window)) continue;
      explained += 1;
      if (!/worktree/i.test(window)) {
        failures.push(`[${rel}:${at + 1}] describes --parallel without naming the worktree that provides the concurrency`);
      }
      for (const stale of [/read-only members/i, /shared writers/i, /serializes? whatever you pass/i]) {
        if (stale.test(window)) {
          failures.push(`[${rel}:${at + 1}] still explains --parallel via the deleted read-only/write_access model: ${stale}`);
        }
      }
    }
    if (explained === 0) {
      failures.push(`[${rel}] mentions --parallel but no longer explains how members interleave`);
    }
  }
  assert.deepEqual(failures, [], `--parallel drift:\n${failures.join('\n')}`);
});

/**
 * Which WAY the Codex precedence claim points.
 *
 * The second deliberate exception to this file's token-only rule, and for the
 * same reason as the `--parallel` test above: presence-pairing cannot catch
 * this drift. The repo asserted both readings, in prose, on five surfaces at
 * once — from 2026-08-20 until this correction, `delegate_to`, `doctor`'s
 * avoidable-fallback check, the runner skill and two doc comments all said an
 * explicit spawn value beats the agent file, so a coordinator was told to
 * deliver a locked identity by stating it at spawn time, which silently ran
 * whatever the file said instead. Every surface still said `delegate_to`; they
 * just said something untrue about how it is delivered.
 *
 * So this pins the *direction*: the phrasings that can only mean the reading
 * that was wrong are banned outright from every surface that carries the
 * claim. They are prose, knowingly — that is what the exception buys. The rule
 * they contradict, with its receipt, is stated once on
 * `findSpawnableCodexAgent`.
 *
 * Matching is done against a whitespace-collapsed copy of each file, with
 * comment prefixes stripped, so a phrase that wraps across two lines — or
 * across a `*` continuation in a JSDoc block — is caught the same as one that
 * fits on a single line. That is how the old SKILL.md and runtime.md wordings
 * were written, and a per-line scan missed them.
 */
const PRECEDENCE_SURFACES = [
  'src/lib/codex-agent-file.ts',
  'src/commands/steering.ts',
  'src/commands/doctor.ts',
  'templates/common/skills/fadeno-runner/SKILL.md',
  'templates/common/skills/fadeno-runner/references/runtime.md',
];

const INVERTED_PRECEDENCE = [
  /LOWEST-priority/i,
  /applies an agent file only after/i,
  /applies the agent file last/i,
  /neither constrains? nor deliver/i,
  /explicit spawn values? (?:first|ahead)/i,
  /as explicit spawn values/i,
];

/**
 * One line of running text per file: comment markers dropped, every run of
 * whitespace (newlines included) folded to a single space.
 */
function flattenForClaimScan(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/+|\*(?=\s|$)|#+)\s?/, ''))
    .join(' ')
    .replace(/\s+/g, ' ');
}

test('no surface claims an explicit spawn value beats the Codex agent file', () => {
  const failures: string[] = [];
  for (const rel of PRECEDENCE_SURFACES) {
    const flat = flattenForClaimScan(readFileSync(join(REPO, rel), 'utf8'));
    for (const inverted of INVERTED_PRECEDENCE) {
      const hit = inverted.exec(flat);
      if (hit != null) {
        // Enough surrounding text to find the passage without a line number,
        // which the flattening necessarily gives up.
        const from = Math.max(0, hit.index - 60);
        failures.push(
          `[${rel}] reinstates the inverted precedence claim (${inverted}): …${flat.slice(from, hit.index + hit[0].length + 60)}…`,
        );
      }
    }
  }
  assert.deepEqual(failures, [], `Codex agent-file precedence drift:\n${failures.join('\n')}`);
});
