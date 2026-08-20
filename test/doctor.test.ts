import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runDoctor } from '../src/commands/doctor.ts';
import { tempRepo } from './helpers.ts';

// `fadeno steering apply --claude` no longer writes anything: effort decides
// the lane, so nothing is left for an agent file to pin. Its whole job on this
// surface is REMOVAL — of the retired identity grid
// (`fadeno-<archetype>-<effort>.md`, marked `source=grid:…`) and of the legacy
// per-dial agents it once replaced (`<archetype>.md`, which additionally pin
// whatever model was dialed the moment they were written).
//
// Both linger silently: the harness registers whatever is in the directory at
// session start, so a survivor keeps overriding what `fadeno dial` reports
// with no symptom short of the wrong identity actually running — this repo's
// own dogfooded `.claude/agents/` was exactly that (see the
// `fadeno-loadouts-dispatch` memory note), with a `judge.md` pinning
// `model: fable` over a `current-host` dial. These tests exercise the doctor
// findings that surface both.

function claudeAgentsDir(root: string): string {
  const dir = join(root, '.claude', 'agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Shape a real `runSteeringApplyClaude` write, pre-grid: frontmatter with a
 * bare model/effort pin, then the trailing managed marker on its own line. */
function legacyAgentBody(model: string, effort: string, version: string): string {
  return [
    '---',
    'name: judge',
    'description: Evaluator role for Fadeno playbooks.',
    `model: ${model}`,
    `effort: ${effort}`,
    '---',
    '',
    'You are an evaluator in a Fadeno playbook run.',
    '',
    `<!-- fadeno:managed version=${version} digest=deadbeef source=${model} -->`,
    '',
  ].join('\n');
}

function gridAgentBody(archetype: string, effort: string, version: string): string {
  return [
    '---',
    `name: fadeno-${archetype}-${effort}`,
    'description: Grid cell.',
    'model: inherit',
    `effort: ${effort}`,
    '---',
    '',
    'Grid body.',
    '',
    `<!-- fadeno:managed version=${version} digest=cafebabe source=grid:${archetype}@${effort} -->`,
    '',
  ].join('\n');
}

test('doctor names a legacy per-dial managed agent and the model it silently pins, and stays silent on an unmanaged file of the same shape', (t) => {
  const root = tempRepo(t);
  const dir = claudeAgentsDir(root);
  // The exact scenario this repo dogfooded: a pre-grid `judge.md` pinning
  // `fable`/`high` regardless of what the current dial resolves to.
  writeFileSync(join(dir, 'judge.md'), legacyAgentBody('fable', 'high', '0.6.0-rc.30'));
  // A hand-authored `worker.md` with no managed marker at all — this MUST
  // never be reported, marker-carrying or not is the only thing that may
  // gate a finding on a user's own agent file.
  writeFileSync(join(dir, 'worker.md'), [
    '---',
    'name: worker',
    'description: my own custom worker, not fadeno-managed',
    'model: opus',
    '---',
    '',
    'Do it my way.',
    '',
  ].join('\n'));

  const result = runDoctor({ repoRoot: root, target: 'claude' });

  const legacy = result.findings.find((f) => f.check === 'claude-agents-legacy');
  assert.ok(legacy, `expected a claude-agents-legacy finding; got ${JSON.stringify(result.findings)}`);
  assert.equal(legacy!.severity, 'warning');
  assert.match(legacy!.detail, /judge\.md/);
  assert.match(legacy!.detail, /fable/);
  assert.match(legacy!.remediation ?? '', /fadeno steering apply --claude/);
  // The fix is removal now, not replacement by a grid that no longer exists.
  assert.match(legacy!.remediation ?? '', /remove it/);

  // Nothing about the hand-authored file anywhere in the report.
  assert.ok(
    result.findings.every((f) => !f.detail.includes('worker.md') && !(f.remediation ?? '').includes('worker.md')),
    JSON.stringify(result.findings),
  );
});

test('doctor reports a surviving identity-grid cell as retired, whatever version stamped it', (t) => {
  const root = tempRepo(t);
  const dir = claudeAgentsDir(root);
  // The grid is gone. A cell left on disk is not "stale and refreshable" — the
  // harness still registers it at session start, and it pins an effort the
  // lane rule no longer consults. The version it was stamped with is beside
  // the point: current and ancient cells are equally retired.
  writeFileSync(join(dir, 'fadeno-worker-medium.md'), gridAgentBody('worker', 'medium', '0.0.1-rc.1'));
  writeFileSync(join(dir, 'fadeno-judge-xhigh.md'), gridAgentBody('judge', 'xhigh', '999.0.0'));

  const result = runDoctor({ repoRoot: root, target: 'claude' });

  const grid = result.findings.find((f) => f.check === 'claude-agents-grid');
  assert.ok(grid, `expected a claude-agents-grid finding; got ${JSON.stringify(result.findings)}`);
  assert.equal(grid!.severity, 'warning');
  assert.match(grid!.detail, /2 retired identity-grid cell/);
  assert.match(grid!.detail, /fadeno-judge-xhigh\.md/);
  assert.match(grid!.remediation ?? '', /fadeno steering apply --claude/);

  // A cell is not a legacy per-dial agent, and never was.
  assert.equal(result.findings.some((f) => f.check === 'claude-agents-legacy'), false);
  // The old "stamped older than this CLI, refresh it" finding retired with the
  // grid: nothing writes these files any more, so refreshing is wrong advice.
  assert.equal(result.findings.some((f) => f.check === 'claude-agents-stale'), false);
});

test('doctor never claims a hand-authored agent, even one wearing a grid cell\'s exact name', (t) => {
  const root = tempRepo(t);
  const dir = claudeAgentsDir(root);
  // Same name a cell would have, no managed marker. Ownership is the marker.
  writeFileSync(
    join(dir, 'fadeno-worker-medium.md'),
    '---\nname: fadeno-worker-medium\nmodel: inherit\neffort: medium\n---\n\nMine.\n',
  );

  const result = runDoctor({ repoRoot: root, target: 'claude' });

  assert.ok(
    result.findings.every(
      (f) => !f.detail.includes('fadeno-worker-medium.md') && !(f.remediation ?? '').includes('fadeno-worker-medium.md'),
    ),
    JSON.stringify(result.findings),
  );
});

test('doctor is silent about Claude agents when apply has done its job', (t) => {
  const root = tempRepo(t);
  claudeAgentsDir(root); // present but empty: exactly what apply leaves behind

  const result = runDoctor({ repoRoot: root, target: 'claude' });

  assert.equal(result.findings.some((f) => f.check === 'claude-agents-legacy'), false);
  assert.equal(result.findings.some((f) => f.check === 'claude-agents-grid'), false);
  assert.equal(result.findings.some((f) => f.check === 'claude-agents-stale'), false);
  // Dials in use no longer imply anything must be registered: the plugin's
  // role agents deliver the dial live, so an empty directory is the healthy
  // steady state rather than a repo that never ran apply.
});
