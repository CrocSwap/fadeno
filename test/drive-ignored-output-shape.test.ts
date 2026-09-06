import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runDrive } from '../src/commands/drive.ts';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runShow } from '../src/commands/show.ts';
import { runVerify } from '../src/commands/verify.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { FADENO_IGNORE_PATTERNS } from '../src/lib/source-control.ts';
import { tempRepo } from './helpers.ts';

// ---------------------------------------------------------------------------
// The engine's ignored-output stamp, end to end.
//
// An engine attempt isolates into a worktree whenever git is available, and
// that worktree merges back through `git add -A` + `git diff --binary
// --cached`. `git add -A` RESPECTS `.gitignore`, so whatever the executor
// wrote at an ignored path is staged by nothing, carried by no diff, and dies
// when the worktree is torn down.
//
// The engine detected that and then threw away the two facts the scan exists
// to state: it wrote `ignored_output_discarded` as a bare `string[]`, so a
// capped or failed listing was indistinguishable from a complete one and a
// truncated scan that enumerated nothing was written as `[]` — byte-identical
// to a listing that found nothing. This pins the object shape at the writer
// and its arrival at both readers.
// ---------------------------------------------------------------------------

const PLAYBOOK = `kind: AgentPlaybook
schema_version: "0.1"
name: ignored-shape
description: one isolated attempt that builds into an ignored path
roles:
  worker:
    purpose: implement
    archetype: worker
flow:
  - id: done
    kind: actor_call
    actor: worker
    output: ReviewReport
    terminal_status: completed
`;

const VALID_REVIEW = JSON.stringify({ reviewer: 'worker', summary: 'done', issues: [], verdict: 'approve' });

/** The executor writes into a gitignored directory, then reports normally. */
const BUILDS_INTO_IGNORED_PATH = [
  'node',
  '-e',
  "require('fs').mkdirSync('outbox',{recursive:true});" +
    "require('fs').writeFileSync('outbox/research.md','the deliverable\\n');" +
    `process.stdout.write(${JSON.stringify(VALID_REVIEW)})`,
];

function seed(t: TestContext, command: string[]): { root: string; runId: string } {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  writeFileSync(join(root, '.fadeno', 'playbooks', 'ignored-shape.yaml'), PLAYBOOK, 'utf8');
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml({
      schema_version: 4,
      models: { 'rw-worker': { provider: 'rw_worker_p', id: 'rw-worker', effort: 'high' } },
      harnesses: { rw_worker_p: { provider: 'rw_worker_p', command } },
      archetypes: { worker: {} },
      dials: {},
      bindings: { worker: 'rw-worker', '*': 'rw-worker' },
    }),
    'utf8',
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid',
  };
  spawnSync('git', ['init'], { cwd: root, env });
  writeFileSync(join(root, '.gitignore'), `${FADENO_IGNORE_PATTERNS.join('\n')}\n`, 'utf8');
  // The shape from the field report: a broad ignore rule that happens to cover
  // a directory the task treats as its deliverable.
  appendFileSync(join(root, '.gitignore'), 'outbox/\n', 'utf8');
  spawnSync('git', ['add', '-A'], { cwd: root, env });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: root, env });
  const { runId } = runNewRun({ playbook: 'ignored-shape', task: 'build into an ignored path', repoRoot: root });
  return { root, runId };
}

test('the engine records a discard as an OBJECT, and both readers surface it', (t) => {
  const { root, runId } = seed(t, BUILDS_INTO_IGNORED_PATH);
  runDrive({ repoRoot: root, run: runId, act: () => {} });

  const events = readEvents(join(root, '.fadeno', 'runs', runId)).events;
  const receipt = events.find((e) => e.type === 'actor_completed');
  assert.ok(receipt != null, 'the attempt completed');
  const stamp = receipt.extra.ignored_output_discarded;
  assert.ok(stamp != null, 'the worktree held gitignored output when it was torn down');
  assert.ok(
    !Array.isArray(stamp) && typeof stamp === 'object',
    'a bare array cannot carry `truncated` or `note`, so a floor reads as a complete set',
  );
  const paths = (stamp as { paths?: unknown }).paths;
  assert.ok(Array.isArray(paths) && paths.includes('outbox/'), `expected outbox/ in ${JSON.stringify(stamp)}`);

  // And the two projections that a human actually meets.
  const discarded = runShow({ repoRoot: root, run: runId }).projection!.discardedOutput;
  assert.equal(discarded.length, 1);
  assert.deepEqual(discarded[0]!.paths, ['outbox/']);
  assert.equal(discarded[0]!.truncated, false, 'git answered, so this listing is the set and must not claim to be a floor');

  const result = runVerify({ repoRoot: root, run: runId });
  const finding = result.findings.find((f) => f.check === 'discarded-output')!;
  assert.equal(finding.status, 'warn', 'named content was destroyed; this run is not clean');
  assert.equal(result.ok, true, 'but `discardable` is the declared default, so the run stays promotable');
  assert.match(finding.detail, /outbox\//);
});

test('an attempt that leaves nothing ignored behind says nothing', (t) => {
  const { root, runId } = seed(t, ['node', '-e', `process.stdout.write(${JSON.stringify(VALID_REVIEW)})`]);
  runDrive({ repoRoot: root, run: runId, act: () => {} });

  const events = readEvents(join(root, '.fadeno', 'runs', runId)).events;
  const receipt = events.find((e) => e.type === 'actor_completed')!;
  assert.equal(receipt.extra.ignored_output_discarded, undefined, 'absence is the only spelling of "nothing was discarded"');
  assert.deepEqual(runShow({ repoRoot: root, run: runId }).projection!.discardedOutput, []);
  assert.equal(runVerify({ repoRoot: root, run: runId }).findings.find((f) => f.check === 'discarded-output')!.status, 'ok');
});
