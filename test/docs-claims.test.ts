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
 * A side may carry several patterns (`patterns`), and a doc claim may live in
 * either of several files (`files`) — all patterns must match, in at least one
 * of the listed files.
 */
type Side = {
  /** Files that may carry the claim; the side passes if ANY one matches all patterns. */
  files: string[];
  /** Stable tokens that must appear. ALL must match. */
  patterns: RegExp[];
};

type Claim = { id: string; doc: Side; src: Side };

const LOADOUTS = 'docs/experimental/loadouts-and-dispatch.md';
const EXTENDING = 'docs/extending.md';

const CLAIMS: Claim[] = [
  {
    id: 'two-row-evidence',
    doc: { files: [LOADOUTS], patterns: [/dispatch_requested/, /dispatch_completed/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/dispatch_requested/, /dispatch_completed/] },
  },
  {
    id: 'native-delivery-row',
    doc: { files: [LOADOUTS], patterns: [/native_delivery/] },
    src: { files: ['templates/claude/hooks/dispatch-steering.mjs'], patterns: [/native_delivery/] },
  },
  {
    id: 'write-access-field',
    doc: { files: [LOADOUTS, EXTENDING], patterns: [/write_access/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/write_access/] },
  },
  {
    id: 'requires-write-field',
    doc: { files: [LOADOUTS], patterns: [/requires_write/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/requires_write/] },
  },
  {
    id: 'relay-attestation',
    doc: { files: [LOADOUTS], patterns: [/relay_attested/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/relay_attested/] },
  },
  {
    id: 'stdin-relay-contract',
    doc: { files: [LOADOUTS], patterns: [/FADENO_PROMPT/] },
    src: { files: ['templates/claude/claude-agents/dispatch-worker.md'], patterns: [/FADENO_PROMPT/] },
  },
  {
    id: 'surface-version-stamp',
    doc: { files: [LOADOUTS, EXTENDING], patterns: [/\[fadeno /] },
    src: { files: ['src/commands/plugin.ts'], patterns: [/stampSurfaceVersion/] },
  },
  {
    id: 'schema-v2-catalog',
    doc: { files: [LOADOUTS], patterns: [/schema_version: 2/] },
    src: { files: ['templates/common/fadeno/executors.yaml'], patterns: [/schema_version: 2/] },
  },
  {
    id: 'dispatches-command',
    doc: { files: [EXTENDING], patterns: [/fadeno dispatches/] },
    src: { files: ['src/cli.ts'], patterns: [/dispatches/] },
  },
  {
    id: 'hook-version-stamp',
    doc: { files: [LOADOUTS], patterns: [/hook_version/] },
    src: { files: ['templates/claude/hooks/dispatch-steering.mjs'], patterns: [/HOOK_VERSION/] },
  },
  {
    id: 'write-conflict-enforcement',
    doc: { files: [LOADOUTS], patterns: [/write_conflict/, /write_access_denied/] },
    src: { files: ['src/commands/steering.ts'], patterns: [/write_conflict/] },
  },
  {
    id: 'dispatches-format',
    doc: { files: [LOADOUTS], patterns: [/format: "0\.2"/, /\[legacy\]/] },
    src: { files: ['src/commands/dispatch.ts'], patterns: [/DISPATCHES_FORMAT = '0\.2'/] },
  },
  {
    id: 'session-slot-overrides',
    doc: { files: [LOADOUTS], patterns: [/loadout set/, /OVERRIDE \(base:/, /resolution: "override"/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/applicableOverrides/, /'override'/] },
  },
  {
    id: 'archetype-fallback-chains',
    doc: { files: [LOADOUTS], patterns: [/requires_write: forbidden/, /fallback/, /resolved_via/] },
    src: { files: ['src/lib/executors.ts'], patterns: [/'forbidden'/, /resolvedVia/] },
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
  let bestMiss: { file: string; pattern: RegExp } | null = null;

  for (const file of side.files) {
    let text: string;
    try {
      text = readFileSync(join(REPO, file), 'utf8');
    } catch {
      return `[${id}] ${which} side drifted (${drifted}): ${file} is missing`;
    }
    const miss = side.patterns.find((p) => !p.test(text));
    if (!miss) return null; // this file carries every pattern → side holds
    bestMiss ??= { file, pattern: miss };
  }

  const where = side.files.length > 1 ? `none of ${side.files.join(', ')}` : bestMiss!.file;
  return `[${id}] ${which} side drifted (${drifted}): ${where} does not match ${bestMiss!.pattern}`;
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
