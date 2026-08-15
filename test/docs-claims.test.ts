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
const EXTENDING = 'docs/extending.md';

const CLAIMS: Claim[] = [
  {
    id: 'two-row-evidence',
    doc: { files: [DIALS], patterns: [/dispatch_requested/, /dispatch_completed/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/dispatch_requested/, /dispatch_completed/] },
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
    id: 'shadow-comparisons-surface',
    doc: { files: [DIALS, EXTENDING], patterns: [/--comparisons/, /ModelComparison/] },
    src: { files: ['src/commands/dispatches.ts'], patterns: [/runDispatchesComparisons/, /ModelComparison/] },
  },
  {
    id: 'shadow-comparisons-tally',
    doc: { files: [DIALS, EXTENDING], patterns: [/prefer_challenger/, /prefer_baseline/] },
    src: { files: ['src/commands/dispatches.ts'], patterns: [/preferChallenger/, /preferBaseline/] },
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
    id: 'models-command-probe',
    doc: { files: [DIALS], patterns: [/models_command/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/models_command/] },
  },
  {
    id: 'verification-cache',
    doc: { files: [DIALS], patterns: [/model-verifications/] },
    src: { files: ['src/lib/user-paths.ts'], patterns: [/modelVerificationsFile/, /model-verifications/] },
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
