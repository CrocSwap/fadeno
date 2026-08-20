import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDoctor } from '../src/commands/doctor.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
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

// --- Project-scope Codex brokers shadowing the user-scope ones ---
//
// Codex resolves a role agent from `<repo>/.codex/agents/<archetype>.toml`
// before `$CODEX_HOME/agents/fadeno-<archetype>.toml`, so a project-scope file
// silently outranks whatever `fadeno setup --codex` maintains at user scope.
// Older `fadeno init` runs copied frozen brokers into project scope with no
// managed header — which is also what stops `steering apply` from refreshing
// them, since project-scope emit only ever refreshes a file that carries the
// marker. (Fresh inits now stamp one, so they are refreshable and read as
// healthy; an unmanaged file here is a genuinely frozen legacy copy.) A broker
// frozen before
// `--prompt-file`/`--host-executor` calls `steering resolve` without them, the
// resolver never sees the prompt bytes it hashes, and the repo drops out of
// shadow pairing with nothing on disk looking wrong. These tests pin the four
// distinguishable states.

/**
 * A user scope that lives entirely inside the throwaway repo. `home` and `env`
 * are both explicit so `userPaths()` never falls through to the developer's
 * real configuration (per the note in helpers.ts, an `env` object REPLACES the
 * environment rather than merging into it). `CODEX_HOME` is additionally
 * cleared from the process environment for the test's lifetime: the user-scope
 * agent-directory rule consults `process.env.CODEX_HOME` before falling back
 * to `home`, so a developer who exports it would otherwise aim these tests at
 * their real `~/.codex`.
 */
function isolatedUser(t: TestContext, root: string, extraEnv: Record<string, string> = {}): UserPathOptions {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  return {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_HARNESS: 'standalone',
      ...extraEnv,
    },
  };
}

function codexProjectAgents(root: string): string {
  const dir = join(root, '.codex', 'agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function codexUserAgents(root: string, codexHome?: string): string {
  const dir = join(codexHome ?? join(root, 'home', '.codex'), 'agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Shape of a real broker body, minus any managed header. */
function brokerBody(archetype: string, resolveFlags: string): string {
  return [
    `name = "${archetype}"`,
    `description = "Fadeno command broker ${archetype}."`,
    'model = "gpt-5.6-luna"',
    'model_reasoning_effort = "low"',
    'sandbox_mode = "workspace-write"',
    '',
    'developer_instructions = """',
    `Run \`fadeno steering resolve --archetype ${archetype}${resolveFlags}\`.`,
    '"""',
    '',
  ].join('\n');
}

/** How `steering apply --codex --scope user` stamps a body it writes. */
function managedBroker(version: string, body: string): string {
  return `# fadeno:managed version=${version} digest=deadbeefcafe\n${body}`;
}

const CODEX_SHADOW_CHECKS = ['codex-agents-project', 'codex-agents-shadow', 'codex-agents-shadow-stale'];

function codexShadowFindings(findings: ReadonlyArray<{ check: string }>): string[] {
  return findings.filter((f) => CODEX_SHADOW_CHECKS.includes(f.check)).map((f) => f.check);
}

test('doctor calls a project-scope Codex broker with no user-scope counterpart informational, not a shadow', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const projectDir = codexProjectAgents(root);
  writeFileSync(join(projectDir, 'worker.toml'), brokerBody('worker', ''));
  codexUserAgents(root); // the user-scope directory exists but is empty

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  assert.deepEqual(codexShadowFindings(result.findings), ['codex-agents-project']);
  const sole = result.findings.find((f) => f.check === 'codex-agents-project')!;
  // Informational: there is exactly one broker, so nothing is being overridden.
  assert.equal(sole.severity, 'ok');
  assert.match(sole.detail, /worker\.toml/);
  assert.match(sole.detail, /no user-scope counterpart/);
  assert.match(sole.detail, /nothing is being shadowed/);
  // A warning-free report: an unshadowed project broker is not a defect.
  assert.equal(result.ok, true);
});

test('doctor reports an unmanaged project-scope Codex broker shadowing a managed user-scope one, and names the file to delete', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const projectDir = codexProjectAgents(root);
  const userDir = codexUserAgents(root);
  // The production shape: a frozen `init`-era broker whose `steering resolve`
  // predates `--prompt-file`/`--host-executor`, over a current managed one.
  writeFileSync(join(projectDir, 'worker.toml'), brokerBody('worker', ''));
  writeFileSync(
    join(userDir, 'fadeno-worker.toml'),
    managedBroker('0.6.0-rc.34', brokerBody('worker', ' --host-executor sol --prompt-file <path>')),
  );

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  assert.deepEqual(codexShadowFindings(result.findings), ['codex-agents-shadow']);
  const shadow = result.findings.find((f) => f.check === 'codex-agents-shadow')!;
  assert.equal(shadow.severity, 'warning');
  assert.match(shadow.detail, /worker\.toml/);
  assert.match(shadow.detail, /no managed header/);
  // Both directories are named, so the reader can see which file wins over which.
  assert.ok(shadow.detail.includes(projectDir), shadow.detail);
  assert.ok(shadow.detail.includes(userDir), shadow.detail);
  // The consequence, not a generic "stale file" scold.
  assert.match(shadow.detail, /--prompt-file/);
  assert.match(shadow.detail, /shadow pairing/);
  // The remedy is a concrete absolute path to delete.
  assert.ok(shadow.remediation!.includes(join(projectDir, 'worker.toml')), shadow.remediation);
  assert.match(shadow.remediation!, /^Delete /);
  // Doctor reports; it never mutates. The file is still there afterwards.
  assert.equal(existsSync(join(projectDir, 'worker.toml')), true);
  // Warnings never fail the exit status.
  assert.equal(result.ok, true);
});

test('doctor reports a managed-but-older project-scope Codex broker as a stale shadow, naming both generations', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const projectDir = codexProjectAgents(root);
  const userDir = codexUserAgents(root);
  writeFileSync(join(projectDir, 'judge.toml'), managedBroker('0.6.0-rc.10', brokerBody('judge', '')));
  writeFileSync(
    join(userDir, 'fadeno-judge.toml'),
    managedBroker('0.6.0-rc.34', brokerBody('judge', ' --prompt-file <path>')),
  );

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  assert.deepEqual(codexShadowFindings(result.findings), ['codex-agents-shadow-stale']);
  const stale = result.findings.find((f) => f.check === 'codex-agents-shadow-stale')!;
  assert.equal(stale.severity, 'warning');
  assert.match(stale.detail, /judge\.toml \(0\.6\.0-rc\.10 < 0\.6\.0-rc\.34\)/);
  assert.ok(stale.detail.includes(userDir), stale.detail);
  assert.ok(stale.remediation!.includes(join(projectDir, 'judge.toml')), stale.remediation);
  // A managed project file is not the unmanaged case: `steering apply` still
  // cannot refresh it in place, and the remedy says so rather than promising
  // a refresh that never happens.
  // A managed project file IS refreshed in place now that project scope is
  // stamped, so the remedy offers that alongside deletion.
  assert.match(stale.remediation!, /refreshed in place/);
  assert.equal(result.ok, true);
});

test('doctor says nothing about Codex brokers of the same generation, or a project copy newer than user scope', (t) => {
  const root = tempRepo(t);
  const user = isolatedUser(t, root);
  const projectDir = codexProjectAgents(root);
  const userDir = codexUserAgents(root);
  // Same stamp: the healthy steady state for a repo that pins project scope.
  writeFileSync(join(projectDir, 'worker.toml'), managedBroker('0.6.0-rc.34', brokerBody('worker', '')));
  writeFileSync(join(userDir, 'fadeno-worker.toml'), managedBroker('0.6.0-rc.34', brokerBody('worker', '')));
  // Newer at project scope shadows nothing current, so it is not a finding
  // either — only an OLDER project copy is the reported failure.
  writeFileSync(join(projectDir, 'judge.toml'), managedBroker('0.6.0-rc.40', brokerBody('judge', '')));
  writeFileSync(join(userDir, 'fadeno-judge.toml'), managedBroker('0.6.0-rc.34', brokerBody('judge', '')));

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  assert.deepEqual(codexShadowFindings(result.findings), []);
});

test('doctor resolves the user-scope Codex directory through CODEX_HOME when it is set', (t) => {
  const root = tempRepo(t);
  const codexHome = join(root, 'elsewhere', 'codex');
  const user = isolatedUser(t, root, { CODEX_HOME: codexHome });
  const projectDir = codexProjectAgents(root);
  const userDir = codexUserAgents(root, codexHome);
  // A decoy at the `home`-derived default: if CODEX_HOME were ignored, the
  // check would find nothing here and mis-report the project file as sole.
  const defaultDir = codexUserAgents(root);
  writeFileSync(join(projectDir, 'reviewer.toml'), brokerBody('reviewer', ''));
  writeFileSync(
    join(userDir, 'fadeno-reviewer.toml'),
    managedBroker('0.6.0-rc.34', brokerBody('reviewer', ' --prompt-file <path>')),
  );

  const result = runDoctor({ repoRoot: root, target: 'codex', userPathOptions: user });

  assert.deepEqual(codexShadowFindings(result.findings), ['codex-agents-shadow']);
  const shadow = result.findings.find((f) => f.check === 'codex-agents-shadow')!;
  assert.ok(shadow.detail.includes(userDir), shadow.detail);
  assert.equal(shadow.detail.includes(defaultDir), false, shadow.detail);
});
