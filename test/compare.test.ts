import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runCompare, CompareCommandError } from '../src/commands/compare.ts';
import { tempRepo } from './helpers.ts';

function git(root: string, ...args: string[]): void {
  const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

/**
 * A repo with one committed baseline and a pair of diff artifacts, seeded
 * straight into the ledger. `runCompare` reads evidence and git, so the
 * fixture has to be a real commit — not a stub — for the baseline probes to
 * mean anything.
 */
function seedPair(t: TestContext, opts: {
  baselineSources?: Record<string, string>;
  primaryDiff: string;
  challengerDiff: string;
  surfaces?: string[];
  primaryRowExtra?: Record<string, unknown>;
  challengerRowExtra?: Record<string, unknown>;
}): string {
  const root = tempRepo(t);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'cli.ts'), 'export function main(): void {}\n');
  for (const [rel, body] of Object.entries(opts.baselineSources ?? {})) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'baseline');
  const baseline = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();

  mkdirSync(join(root, '.fadeno', 'local', 'outputs'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'local', 'outputs', 'p.diff'), opts.primaryDiff);
  writeFileSync(join(root, '.fadeno', 'local', 'outputs', 'c.diff'), opts.challengerDiff);
  if (opts.surfaces != null) {
    writeFileSync(
      join(root, '.fadeno', 'executors.yaml'),
      `schema_version: 3\nsurfaces:\n${opts.surfaces.map((s) => `  - ${s}`).join('\n')}\n`,
    );
  }

  const rows = [
    {
      event: 'dispatch_completed', format: '1.0',
      pair_id: 'pair0001-aaaa-bbbb-cccc-dddddddddddd', dispatch_id: 'prim0001-aaaa-bbbb-cccc-dddddddddddd',
      archetype: 'worker', executor: 'sonnet', model: 'sonnet', reasoning_effort: 'xhigh',
      exit_code: 0, duration_ms: 1000, output_bytes: 10,
      diff_snapshot: '.fadeno/local/outputs/p.diff', diff_bytes: opts.primaryDiff.length,
      baseline_commit: baseline, ...(opts.primaryRowExtra ?? {}),
    },
    {
      event: 'dispatch_completed', format: '1.0', shadow: true,
      pair_id: 'pair0001-aaaa-bbbb-cccc-dddddddddddd', dispatch_id: 'chal0001-aaaa-bbbb-cccc-dddddddddddd',
      archetype: 'worker', executor: 'grok', model: 'grok', reasoning_effort: 'xhigh',
      exit_code: 0, duration_ms: 1200, output_bytes: 20,
      diff_snapshot: '.fadeno/local/outputs/c.diff', diff_bytes: opts.challengerDiff.length,
      baseline_commit: baseline, ...(opts.challengerRowExtra ?? {}),
    },
  ];
  writeFileSync(join(root, '.fadeno', 'dispatches.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return root;
}

function diffFor(file: string, addedLines: string[], removedLines: string[] = []): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,1 +1,9 @@',
    ...removedLines.map((l) => `-${l}`),
    ...addedLines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

test('the reach differential names a value one arm wired to a surface and the other did not', (t) => {
  // Both arms compute `delegate_to`; only the challenger adds it to the
  // printed object. This is shadow pair 89536181 in miniature — the defect
  // that 1282 green tests and an identical diffstat both missed.
  const root = seedPair(t, {
    surfaces: ['src/cli.ts'],
    primaryDiff: diffFor('src/commands/steering.ts', ['  delegate_to: DelegateTo;']),
    challengerDiff:
      diffFor('src/commands/steering.ts', ['  delegate_to: DelegateTo;']) +
      diffFor('src/cli.ts', ['      delegate_to: result.delegate_to ?? null,']),
  });
  const result = runCompare({ repoRoot: root, ref: 'pair0001-aaaa-bbbb-cccc-dddddddddddd', measureOnly: true });

  assert.deepEqual(result.reachDifferential, [
    { identifier: 'delegate_to', reachedIn: 'challenger', unreachedIn: 'primary' },
  ]);
  const primary = result.arms.find((a) => a.arm === 'primary')!;
  assert.deepEqual(primary.signals?.unreached, ['delegate_to']);
  const challenger = result.arms.find((a) => a.arm === 'challenger')!;
  assert.deepEqual(challenger.signals?.unreached, []);
});

test('reach is withheld, not reported clean, when the repo declares no surfaces', (t) => {
  const root = seedPair(t, {
    primaryDiff: diffFor('src/commands/steering.ts', ['  delegate_to: DelegateTo;']),
    challengerDiff: diffFor('src/commands/steering.ts', ['  delegate_to: DelegateTo;']),
  });
  const result = runCompare({ repoRoot: root, ref: 'pair0001', measureOnly: true });

  // `null`, never `[]`. An empty list reads as "everything reached a
  // consumer"; absent a declaration this cannot tell that from "there was
  // nothing to reach", and the difference is the whole value of the signal.
  for (const arm of result.arms) assert.equal(arm.signals?.unreached, null);
  assert.equal(result.reachDifferential, null);
});

test('a MOVED symbol is not reported as a duplication', (t) => {
  // The old home did not export it; the new one does. Treating that as
  // "already defined at baseline" would flag every extraction-into-a-shared-
  // module — which is the refactor this codebase's own convention asks for.
  const root = seedPair(t, {
    baselineSources: { 'src/doctor.ts': "const SHARED_MARK = '# fadeno:managed';\n" },
    primaryDiff:
      diffFor('src/doctor.ts', [], ["const SHARED_MARK = '# fadeno:managed';"]) +
      diffFor('src/shared.ts', ["export const SHARED_MARK = '# fadeno:managed';"]),
    challengerDiff: diffFor('src/other.ts', ["export const SHARED_MARK = '# fadeno:managed';"]),
  });
  const result = runCompare({ repoRoot: root, ref: 'pair0001', measureOnly: true });

  const primary = result.arms.find((a) => a.arm === 'primary')!;
  assert.deepEqual(primary.signals?.redefined, [], 'the primary moved the symbol, it did not duplicate it');

  // The challenger added a second definition and removed nothing, which is a
  // genuine duplication and MUST still be reported. This half is the tripwire:
  // the baseline probe shells out to `git grep -E`, whose POSIX ERE does not
  // honour `\\s` or `\\b`. The first version used both, matched nothing ever,
  // and reported a clean bill that was indistinguishable from a real one.
  const challenger = result.arms.find((a) => a.arm === 'challenger')!;
  assert.deepEqual(challenger.signals?.redefined, ['SHARED_MARK']);
});

test('confounds are stamped from the ledger, and generated files are called out', (t) => {
  const root = seedPair(t, {
    primaryDiff: diffFor('plugin/bin/fadeno', ['export const generated = 1;']),
    challengerDiff: diffFor('src/thing.ts', ['export const thing = 1;']),
    primaryRowExtra: { ignored_output_discarded: { paths: ['dist/'] }, exit_code: 1 },
    challengerRowExtra: { carry_mutated: true, workspace_mode_degraded: 'worktree_unavailable' },
  });
  const result = runCompare({ repoRoot: root, ref: 'pair0001', measureOnly: true });
  const codes = result.confounds.map((c) => c.code).sort();

  assert.ok(codes.includes('ignored_output_discarded'));
  assert.ok(codes.includes('carry_mutated'), 'carry_mutated must survive the reader');
  assert.ok(codes.includes('workspace_mode_degraded'), 'workspace_mode_degraded must survive the reader');
  assert.ok(codes.includes('exit_code_differs'));
  assert.ok(codes.includes('effort_unattested'));

  // A regenerated bundle is one 1.7 MB line: a pair that merely rebuilt it
  // reads as an enormous change unless the diffstat says so.
  const primary = result.arms.find((a) => a.arm === 'primary')!;
  assert.deepEqual(primary.diff?.generatedFiles, ['plugin/bin/fadeno']);
  // ...and its identifiers are excluded from the signals entirely.
  assert.deepEqual(primary.signals?.introduced, []);
});

test('compare refuses to run without --measure-only rather than writing an empty verdict', (t) => {
  const root = seedPair(t, { primaryDiff: diffFor('src/a.ts', []), challengerDiff: diffFor('src/b.ts', []) });
  assert.throws(
    () => runCompare({ repoRoot: root, ref: 'pair0001' }),
    (err: unknown) => err instanceof CompareCommandError && /measures only/.test((err as Error).message),
  );
});
