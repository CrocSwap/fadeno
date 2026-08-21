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
const SLOTS = 'docs/experimental/slots-and-archetypes.md';
const LOADOUTS = 'docs/experimental/loadouts-and-dispatch.md';
const EXTENDING = 'docs/extending.md';

const CLAIMS: Claim[] = [
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
      files: ['src/lib/workspace-lease.ts'],
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
    id: 'relay-attestation',
    doc: { files: [DIALS], patterns: [/relay_attested/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/relay_attested/] },
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
    id: 'schema-v3-catalog',
    doc: { files: [DIALS], patterns: [/schema_version: 3/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/schema_version: 3/, /schemaVersion/] },
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
    doc: { files: [DIALS], patterns: [/format: "1\.0"/, /\[legacy\]/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/DISPATCHES_FORMAT = '1\.0'/] },
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
    doc: { files: [DIALS], patterns: [/models:/, /unregistered_model_driver/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/models:/, /unregisteredModelDriver/] },
  },
  {
    id: 'dial-grammar',
    doc: { files: [DIALS], patterns: [/--via/] },
    src: { files: ['src/cli.ts', 'src/commands/dial.ts'], patterns: [/--via/, /via/] },
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
    id: 'write-variant',
    doc: { files: [DIALS], patterns: [/write_variant/, /applyWritePosture/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/write_variant/, /applyWritePosture/] },
  },
  {
    // Two independent `commandRoutable(spec)` literals at dial/steering
    // resolve is how `shadow.routable` promised pairs the kernel then
    // refused. One helper, named in the design record and at every caller.
    id: 'pair-routability-write-posture',
    doc: { files: [SLOTS], patterns: [/explainPairRoutability/, /shadow_write_posture/] },
    src: {
      files: ['src/lib/executors.ts', 'src/commands/dispatch.ts', 'src/commands/dial.ts', 'src/commands/steering.ts'],
      patterns: [/explainPairRoutability/, /shadow_write_posture/],
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
    // The `harness`-headed column that never held a harness. The doc records
    // the rename and the `(inherits …)` half that had to move with it; the
    // source must actually print both, or the design record is describing a
    // table nobody sees.
    id: 'dial-via-column',
    doc: { files: [DIALS], patterns: [/effort {4}via/, /inherits worker/] },
    src: { files: ['src/cli.ts'], patterns: [/'via'\.padEnd\(22\)/, /\(inherits \$\{row\.resolvedVia\}\)/] },
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
    id: 'engine-cancel-command',
    doc: { files: [EXTENDING, 'README.md'], patterns: [/fadeno cancel/] },
    src: { files: ['src/commands/cancel.ts', 'src/cli.ts'], patterns: [/runCancel/] },
  },
  {
    id: 'executor-timeout-route',
    doc: { files: [EXTENDING, 'docs/architecture.md'], patterns: [/timeout_ms: 1200000/] },
    src: { files: ['src/lib/executors.ts', 'src/lib/supervisor.ts'], patterns: [/timeout_ms/] },
  },
  {
    id: 'executor-timeout-receipt',
    doc: { files: [EXTENDING], patterns: [/executor_timeout/] },
    src: { files: ['src/commands/drive.ts', 'src/commands/dispatch.ts'], patterns: [/executor_timeout/] },
  },
  {
    id: 'timeout-cli-override',
    doc: { files: [EXTENDING, 'README.md'], patterns: [/--timeout <seconds>/] },
    src: { files: ['src/cli.ts'], patterns: [/--timeout/] },
  },
  {
    id: 'idle-output-warning',
    doc: { files: [EXTENDING, 'docs/architecture.md'], patterns: [/OUTPUT_IDLE_WARNING_MS/] },
    src: { files: ['src/commands/show.ts', 'src/cli.ts'], patterns: [/OUTPUT_IDLE_WARNING_MS/] },
  },
  {
    id: 'neutral-current-host',
    doc: { files: ['README.md', 'docs/architecture.md'], patterns: [/current-host/] },
    src: { files: ['src/commands/steering.ts'], patterns: [/current-host/, /requested_only/] },
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
