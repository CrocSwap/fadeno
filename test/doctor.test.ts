import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runDoctor } from '../src/commands/doctor.ts';
import { writeLocalDialState } from '../src/lib/executors.ts';
import { tempRepo } from './helpers.ts';

// `fadeno steering apply --claude` pre-registers a dial-independent identity
// grid (`fadeno-<archetype>-<effort>.md`) and removes the legacy per-dial
// managed agents it replaces (`<archetype>.md`, which pin whatever model was
// dialed the moment they were written). Nothing detected a repo that never
// ran apply, or one whose legacy files survived from before the grid
// existed — this repo's own dogfooded `.claude/agents/` was exactly that
// (see the `fadeno-loadouts-dispatch` memory note), with a `judge.md`
// pinning `model: fable` silently overriding a `current-host` dial. These
// tests exercise the doctor findings that now surface it.

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

  // Nothing about the hand-authored file anywhere in the report.
  assert.ok(
    result.findings.every((f) => !f.detail.includes('worker.md') && !(f.remediation ?? '').includes('worker.md')),
    JSON.stringify(result.findings),
  );
});

test('doctor flags a managed Claude agent stamped older than the running CLI, reusing the runtime-skew vocabulary', (t) => {
  const root = tempRepo(t);
  const dir = claudeAgentsDir(root);
  // A validly-named GRID cell (not a legacy filename) can still be stale
  // after an upgrade — the version check is independent of the legacy-name
  // check, so this must not also produce a claude-agents-legacy finding.
  writeFileSync(join(dir, 'fadeno-worker-medium.md'), gridAgentBody('worker', 'medium', '0.0.1-rc.1'));

  const result = runDoctor({ repoRoot: root, target: 'claude' });

  const stale = result.findings.find((f) => f.check === 'claude-agents-stale');
  assert.ok(stale, `expected a claude-agents-stale finding; got ${JSON.stringify(result.findings)}`);
  assert.equal(stale!.severity, 'warning');
  assert.match(stale!.detail, /fadeno-worker-medium\.md/);
  assert.match(stale!.detail, /0\.0\.1-rc\.1/);
  // Same directional word `runtime-version` uses for this exact relationship
  // (managed artifact older than the invoking CLI) rather than new severity
  // vocabulary invented just for this check.
  assert.match(stale!.detail, /managed-older/);

  assert.equal(result.findings.some((f) => f.check === 'claude-agents-legacy'), false);
});

test('doctor is silent about the Claude identity grid when a cell is current and correctly named', (t) => {
  const root = tempRepo(t);
  const dir = claudeAgentsDir(root);
  writeFileSync(join(dir, 'fadeno-worker-medium.md'), gridAgentBody('worker', 'medium', '999.0.0'));

  const result = runDoctor({ repoRoot: root, target: 'claude' });

  assert.equal(result.findings.some((f) => f.check === 'claude-agents-legacy'), false);
  assert.equal(result.findings.some((f) => f.check === 'claude-agents-stale'), false);
});

test('doctor warns when dials are in use under the Claude harness but no identity grid cell is registered', (t) => {
  const root = tempRepo(t);
  writeLocalDialState(root, { dials: { worker: { model: 'echo-worker' } }, shadows: {}, legacyNote: null });

  const result = runDoctor({ repoRoot: root, target: 'claude' });
  const gridFinding = result.findings.find((f) => f.check === 'claude-agents-grid');
  assert.ok(gridFinding, `expected a claude-agents-grid finding; got ${JSON.stringify(result.findings)}`);
  assert.equal(gridFinding!.severity, 'warning');

  // Registering even one grid cell is enough to clear the warning.
  const dir = claudeAgentsDir(root);
  writeFileSync(join(dir, 'fadeno-worker-medium.md'), gridAgentBody('worker', 'medium', '999.0.0'));
  const after = runDoctor({ repoRoot: root, target: 'claude' });
  assert.equal(after.findings.some((f) => f.check === 'claude-agents-grid'), false);
});
