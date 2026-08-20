import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AttestCommandError, runAttest } from '../src/commands/attest.ts';
import { DISPATCHES_FILE } from '../src/commands/dispatch.ts';
import { tempRepo } from './helpers.ts';

// The suite may run inside a live Claude Code session, where CLAUDE_EFFORT is
// already set in the real process environment (same reasoning as
// test/steering-claude.test.ts). Delete it so tests asserting "unmeasured"
// are hermetic; tests that need a value present pass an explicit `env`
// instead of relying on ambient state either way.
delete process.env.CLAUDE_EFFORT;

function readRows(root: string): Record<string, unknown>[] {
  return readFileSync(join(root, DISPATCHES_FILE), 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('runAttest measures CLAUDE_EFFORT when present and labels model as requested_only', (t) => {
  const root = tempRepo(t);
  const result = runAttest({
    archetype: 'worker',
    repoRoot: root,
    env: { CLAUDE_EFFORT: 'xhigh' },
    pid: 4242,
    now: new Date('2026-08-19T12:00:00.000Z'),
  });
  assert.equal(result.archetype, 'worker');
  assert.equal(result.effort, 'xhigh');
  assert.equal(result.effortEvidence, 'measured');
  assert.equal(result.pid, 4242);
  assert.equal(result.identityEvidence, 'requested_only');
  assert.equal(result.timestamp, '2026-08-19T12:00:00.000Z');

  const rows = readRows(root);
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.event, 'host_attestation');
  assert.equal(row.format, '1.0');
  assert.equal(row.archetype, 'worker');
  assert.equal(row.effort, 'xhigh');
  assert.equal(row.effort_evidence, 'measured');
  assert.equal(row.pid, 4242);
  assert.equal(row.identity_evidence, 'requested_only');
  assert.ok(typeof row.fadeno_version === 'string' && (row.fadeno_version as string).length > 0);
  // The row never claims a model of its own — there is no environment
  // channel to measure one from, and this command never asks the model to
  // self-report its own name.
  assert.equal('model' in row, false);
});

test('runAttest says explicitly when effort could not be measured, rather than omitting the field', (t) => {
  const root = tempRepo(t);
  const result = runAttest({ archetype: 'reviewer', repoRoot: root, env: {} });
  assert.equal(result.effort, null);
  assert.equal(result.effortEvidence, 'unavailable');

  const row = readRows(root)[0]!;
  // Present-and-null, not absent: a reader must be able to tell "measured as
  // nothing" from "this row predates the field" from the sibling
  // `effort_evidence`, never from whether the key exists at all.
  assert.ok(Object.hasOwn(row, 'effort'));
  assert.equal(row.effort, null);
  assert.equal(row.effort_evidence, 'unavailable');
});

test('runAttest whitespace-trims CLAUDE_EFFORT and treats a blank value as unmeasured', (t) => {
  const root = tempRepo(t);
  const padded = runAttest({ archetype: 'judge', repoRoot: root, env: { CLAUDE_EFFORT: '  high  ' } });
  assert.equal(padded.effort, 'high');
  assert.equal(padded.effortEvidence, 'measured');

  const blank = runAttest({ archetype: 'judge', repoRoot: root, env: { CLAUDE_EFFORT: '   ' } });
  assert.equal(blank.effort, null);
  assert.equal(blank.effortEvidence, 'unavailable');
});

test('runAttest rejects a missing or malformed --archetype', (t) => {
  const root = tempRepo(t);
  assert.throws(() => runAttest({ archetype: '', repoRoot: root }), AttestCommandError);
  assert.throws(() => runAttest({ archetype: '   ', repoRoot: root }), AttestCommandError);
  assert.throws(() => runAttest({ archetype: 'Worker', repoRoot: root }), AttestCommandError);
  assert.throws(() => runAttest({ archetype: 'worker reviewer', repoRoot: root }), AttestCommandError);
});

test('runAttest accepts a declared archetype outside the built-in three', (t) => {
  // The row records "the archetype it was told it is", not a closed set —
  // fallback-chain archetypes (docs/experimental/slots-and-archetypes.md,
  // "Phase 2") are ordinary bare identifiers too.
  const root = tempRepo(t);
  const result = runAttest({ archetype: 'senior_reviewer', repoRoot: root, env: {} });
  assert.equal(result.archetype, 'senior_reviewer');
});
