import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runPrompt } from '../src/commands/prompt.ts';
import { tempRepo } from './helpers.ts';
import { userPaths } from '../src/lib/user-paths.ts';
import { syncManagedRuntime, readInstallationManifest } from '../src/lib/installations.ts';
import { packageVersion } from '../src/lib/paths.ts';

const BIN = join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno');

function cli(root: string, args: string[]): { status: number; output: string } {
  try {
    return { status: 0, output: execFileSync(BIN, args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function cliSplit(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: execFileSync(BIN, args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const CROSS_REVIEW_EVENTS = [
  '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}',
  '{"type":"step_started","step":"draft_approaches","timestamp":"2026-07-12T21:21:10.416Z"}',
  '{"type":"artifact_created","step":"draft_approaches","artifact":"artifacts/approach-sol.md","timestamp":"2026-07-12T21:28:35.231Z"}',
  '{"type":"artifact_created","step":"draft_approaches","artifact":"artifacts/approach-fable.md","timestamp":"2026-07-12T21:31:15.350Z"}',
  '{"type":"step_started","step":"cross_review","timestamp":"2026-07-12T21:31:15.407Z"}',
  '',
].join('\n');

function seedCrossReview(root: string): string {
  runInit({ target: 'codex', repoRoot: root });
  const dogfood = join(import.meta.dirname, '..', 'docs', 'experimental', 'dual-architect-review.yaml');
  writeFileSync(join(root, '.fadeno', 'playbooks', 'dual-architect-review.yaml'), readFileSync(dogfood, 'utf8'));
  const runId = '2026-07-12-1718-design-and-build-fadeno-prompt';
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    join(dir, 'run.yaml'),
    [
      `run_id: ${runId}`,
      'schema_version: "0.3"',
      'playbook: dual-architect-review',
      'status: running',
      'task: "Design and build fadeno prompt"',
      'started_at: 2026-07-12T21:18:58.647Z',
      'host: cli',
      'artifacts_dir: artifacts',
      'current_step: cross_review',
      '',
    ].join('\n'),
  );
  writeFileSync(join(dir, 'artifacts', 'approach-fable.md'), '# Fable\n');
  writeFileSync(join(dir, 'artifacts', 'approach-sol.md'), '# Sol\n');
  writeFileSync(join(dir, 'events.jsonl'), CROSS_REVIEW_EVENTS);
  return runId;
}

function fresh(root: string): string {
  runInit({ target: 'codex', repoRoot: root });
  return runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'cli integration' }).runId;
}

test('built CLI gate exits 0 for pass and 1 for fail', (t) => {
  const root = tempRepo(t);
  const runId = fresh(root);
  const artifact = join(root, '.fadeno', 'runs', runId, 'artifacts', 'test-result.json');
  writeFileSync(artifact, JSON.stringify({ tool: 'test_runner', command: 'npm test', status: 'passed', exit_code: 0, summary: 'ok' }));
  assert.equal(cli(root, ['gate', runId, 'tests_pass', '--artifact', 'artifacts/test-result.json']).status, 0);
  writeFileSync(artifact, JSON.stringify({ tool: 'test_runner', command: 'npm test', status: 'failed', exit_code: 1, summary: 'failed' }));
  assert.equal(cli(root, ['gate', runId, 'tests_pass', '--artifact', 'artifacts/test-result.json']).status, 1);
});

test('committed bundled CLI supports Grok init and rejects mixed target flags', (t) => {
  const root = tempRepo(t);

  const help = cliSplit(root, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /fadeno init --codex\|--claude\|--grok/);
  assert.match(help.stdout, /fadeno init --grok/);

  const initialized = cliSplit(root, ['init', '--grok']);
  assert.equal(initialized.status, 0);
  assert.match(initialized.stdout, /Fadeno initialized for grok/);
  assert.ok(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes('/fadeno-runner'));
  assert.ok(readFileSync(join(root, '.grok', 'skills', 'fadeno-runner', 'SKILL.md'), 'utf8'));
  assert.ok(readFileSync(join(root, '.grok', 'agents', 'worker.md'), 'utf8'));

  const mixed = cliSplit(root, ['init', '--grok', '--codex']);
  assert.equal(mixed.status, 1);
  assert.match(`${mixed.stdout}${mixed.stderr}`, /choose exactly one target/i);
});

test('bundled CLI serves focused per-command help and falls back globally', (t) => {
  const root = tempRepo(t);

  const dial = cliSplit(root, ['dial', '--help']);
  assert.equal(dial.status, 0, dial.stderr);
  assert.match(dial.stdout, /per-archetype model selection/);
  assert.match(dial.stdout, /binding → session dial → repo pin → user dial/);
  assert.doesNotMatch(dial.stdout, /fadeno new-run <playbook>/);

  // Help is answered before the command body runs: dispatch must not wait on stdin.
  const dispatch = cliSplit(root, ['dispatch', '--help']);
  assert.equal(dispatch.status, 0, dispatch.stderr);
  assert.match(dispatch.stdout, /--prompt-file/);
  assert.match(dispatch.stdout, /dispatches --output tag:/);

  const verify = cliSplit(root, ['verify', '--help']);
  assert.equal(verify.status, 0);
  assert.match(verify.stdout, /--allow-failed/);

  // Later positionals keep the command's help; unknown commands fall back to global.
  const midArgs = cliSplit(root, ['dial', 'worker', '--help']);
  assert.equal(midArgs.status, 0);
  assert.match(midArgs.stdout, /per-archetype model selection/);
  const unknown = cliSplit(root, ['no-such-command', '--help']);
  assert.equal(unknown.status, 0);
  assert.match(unknown.stdout, /fadeno — the playbook layer for AI coding agents/);
});

test('bundled CLI dial shows effective table and resolves via dials', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: {
      sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
      grok: { provider: 'xai', id: 'grok-4.6', effort: 'high' },
    },
    routes: {
      standalone: {
        openai: { command: ['node', '-e', '0'], },
        xai: { command: ['node', '-e', '0'], },
        'current-host': { host: true },
      },
    },
    archetypes: {
      worker: { },
      reviewer: { },
      judge: { },
    },
  }));

  const show = cliSplit(root, ['dial'], { ...process.env, FADENO_HARNESS: 'standalone' });
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /archetype/);
  assert.match(show.stdout, /worker/);

  const set = cliSplit(root, ['dial', 'worker', 'sol'], { ...process.env, FADENO_HARNESS: 'standalone' });
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /worker → sol/);
  assert.match(set.stdout, /user default/);
});

test('committed bundled CLI emits Bash completion and preserves candidate flags after --', (t) => {
  const root = tempRepo(t);
  const script = cliSplit(root, ['completion', 'bash']);
  assert.equal(script.status, 0);
  assert.equal(script.stderr, '');
  assert.match(script.stdout, /complete -F _fadeno_complete fadeno/);
  execFileSync('bash', ['-n'], { input: script.stdout });

  const globalFlags = cliSplit(root, ['completion', 'candidates', '1', '--', 'fadeno', '-']);
  assert.equal(globalFlags.status, 0);
  assert.deepEqual(globalFlags.stdout.trim().split('\n'), ['--help', '--version', '-h', '-v']);

  const candidates = cliSplit(root, ['completion', 'candidates', '3', '--', 'fadeno', 'validate', '--schema', 'r']);
  assert.equal(candidates.status, 0);
  assert.equal(candidates.stderr, '');
  assert.match(candidates.stdout, /review-report/);
  assert.match(candidates.stdout, /run/);
});

test('built CLI rejects invalid artifacts and path-dependent playbooks', (t) => {
  const root = tempRepo(t);
  const runId = fresh(root);
  const artifact = join(root, '.fadeno', 'runs', runId, 'artifacts', 'test-result.json');
  writeFileSync(artifact, JSON.stringify({ tool: 'test_runner', command: 'npm test', status: 'passed', exit_code: 0 }));
  const invalid = cli(root, ['gate', runId, 'tests_pass']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.output, /invalid.*tests_pass/i);

  const playbook = [
    'kind: AgentPlaybook',
    'schema_version: "0.1"',
    'name: path-dependent',
    'description: path dependent',
    'roles:',
    '  c: {purpose: work}',
    'flow:',
    '  - id: start',
    '    kind: actor_call',
    '    actor: c',
    '    output: TestResult',
    '  - id: branch',
    '    kind: gate',
    '    input: [TestResult]',
    '    condition: tests_pass',
    '    on_pass: made',
    '    on_fail: skipped',
    '  - id: made',
    '    kind: actor_call',
    '    actor: c',
    '    output: Present',
    '    next: done',
    '  - id: skipped',
    '    kind: actor_call',
    '    actor: c',
    '    output: Other',
    '    next: done',
    '  - id: done',
    '    kind: actor_call',
    '    actor: c',
    '    input: [Present]',
    '    terminal_status: completed',
    '',
  ].join('\n');
  writeFileSync(join(root, '.fadeno', 'playbooks', 'path-dependent.yaml'), playbook);
  const validation = cli(root, ['validate', '.fadeno/playbooks/path-dependent.yaml']);
  assert.equal(validation.status, 1);
  assert.match(validation.output, /not definitely available|unreachable/i);
});

test('built CLI prompt renders to stdout, errors cleanly, and emits stable JSON', (t) => {
  const root = tempRepo(t);
  const runId = seedCrossReview(root);

  // text: stdout is exactly the assembled prompt (+ the trailing console newline),
  // stderr empty, exit 0 — safe to pipe into `codex exec -`.
  const expected = runPrompt({ repoRoot: root, run: runId, step: 'cross_review', actor: 'architect_fable', record: false }).prompt;
  const text = cliSplit(root, ['prompt', runId, 'cross_review', '--actor', 'architect_fable', '--no-record']);
  assert.equal(text.status, 0);
  assert.equal(text.stderr, '');
  assert.equal(text.stdout, `${expected}\n`);

  // a failure keeps stdout empty and exits 1 so a pipeline never gets a partial prompt.
  const failure = cliSplit(root, ['prompt', runId, 'cross_review', '--no-record']);
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /maps over roles; pass --actor/);

  // --format json: stable key order.
  const json = cliSplit(root, ['prompt', runId, 'cross_review', '--actor', 'architect_fable', '--no-record', '--format', 'json']);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(parsed), ['step', 'actor', 'iteration', 'invocation', 'recorded', 'prompt_path', 'sha256', 'prompt']);
  assert.equal(parsed.actor, 'architect_fable');
  assert.equal(parsed.recorded, 'preview');
});

test('dial resolve hook emits stable keys for agent', (t) => {
  const root = tempRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' } },
    routes: { standalone: { openai: { command: ['node', '-e', '0'], }, 'current-host': { host: true } } },
    archetypes: { worker: {} },
  }));
  // Clear any prior user dial that may have leaked from previous test's global state
  cliSplit(root, ['dial', 'clear', 'worker', '--user'], { ...process.env, FADENO_HARNESS: 'standalone' });
  const { status, stdout } = cliSplit(root, ['dial', 'resolve', '--archetype', 'worker'], { ...process.env, FADENO_HARNESS: 'standalone' });
  assert.equal(status, 0, stdout);
  const parsed = JSON.parse(stdout);
  assert.ok('executor' in parsed);
  assert.ok('model' in parsed);
  assert.ok('adapter' in parsed);
  assert.equal(parsed.model, 'current-host');
});

test('built CLI gate all_reviews_approved failure names reviewer and verdict for zero-blocking request_changes', (t) => {
  const root = tempRepo(t);
  const runId = fresh(root);
  const reportPath = join(root, '.fadeno', 'runs', runId, 'artifacts', 'review-report.json');
  // zero-blocking request_changes must pass legacy but fail approval gate
  writeFileSync(reportPath, JSON.stringify({ reviewer: 'alice', summary: 'needs work', issues: [{ severity: 'minor', title: 'nit' }], verdict: 'request_changes' }));
  const result = cliSplit(root, ['gate', runId, 'all_reviews_approved']);
  assert.equal(result.status, 1, 'gate should fail for request_changes');
  const combined = `${result.stdout}${result.stderr}`;
  assert.match(combined, /FAIL\s+all_reviews_approved/);
  assert.match(combined, /alice/);
  assert.match(combined, /request_changes/);
  // Should not be empty blocking-title list; must show reviewer verdict line
  assert.match(combined, /-\s*alice:\s*request_changes/);
  const legacy = cliSplit(root, ['gate', runId, 'no_blocking_issues']);
  assert.equal(legacy.status, 0, 'legacy no_blocking_issues should pass for zero-blocking');
});

test('CLI preflight refreshes older runtime without changing stdout/exit, never installs fresh, never downgrades, and skips unknown commands', (t) => {
  const runWithEnv = (repoRoot: string, args: string[], extraEnv: Record<string, string>) => {
    const env = { ...process.env, ...extraEnv };
    try {
      const stdout = execFileSync(BIN, args, { cwd: repoRoot, env, encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, stdout, stderr: '' };
    } catch (e: any) {
      return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };
  // Setup isolated homes
  const root = tempRepo(t);
  const homes = {
    FADENO_CONFIG_HOME: join(root, 'user-config'),
    FADENO_STATE_HOME: join(root, 'user-state'),
    FADENO_DATA_HOME: join(root, 'user-data'),
  };
  const pathsOpts = { home: join(root, 'home'), env: homes };
  const up = userPaths(pathsOpts);
  const makeSource = (name, version, content) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fadeno'), content);
    chmodSync(join(dir, 'fadeno'), 0o755);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fadeno-runtime', type: 'commonjs', version }, null, 2));
    mkdirSync(join(dir, 'templates'), { recursive: true });
    writeFileSync(join(dir, 'templates', 'x'), 'x');
    return dir;
  };
  // First install older
  const older = makeSource('older-preflight-cli', '0.6.0-rc.32', 'old-bytes-cli');
  let manifest = readInstallationManifest(pathsOpts);
  syncManagedRuntime(up, older, manifest, { allowInstall: true, trustSource: true });
  manifest = readInstallationManifest(pathsOpts);
  // Refresh test: newer bundled should refresh on operational command
  // Derived from the package, never a literal: preflight compares the managed
  // runtime against the INVOKING CLI's own version too, so a hardcoded
  // "newer" fixture stops being newer the moment the package is bumped and
  // the CLI silently refreshes past it. Pinning a version that must track the
  // package is the same trap as pinning prose a template must match.
  const newer = makeSource('newer-preflight-cli', packageVersion(), 'new-bytes-cli');
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  // operational command: `fadeno runs` should list no runs, exit 0, and preserve stdout
  const beforeRuns = runWithEnv(root, ['runs'], { ...homes, FADENO_BUNDLED_RUNTIME: newer });
  assert.equal(beforeRuns.status, 0);
  assert.match(beforeRuns.stdout, /No runs yet/);
  // After, runtime should be newer
  assert.equal(readFileSync(up.managedCli, 'utf8'), 'new-bytes-cli');
  // Check stdout preserved: direct run without preflight (via status which is excluded) should have same stdout?
  // For stdout preservation, compare that `runs` stdout is exactly same as without bundled env but with same repo
  const withoutBundled = runWithEnv(root, ['runs'], homes);
  assert.equal(withoutBundled.stdout, beforeRuns.stdout, 'preflight must not alter command stdout');
  // Never downgrades: set bundled to older, run operational, should stay newer
  const resultDowngrade = runWithEnv(root, ['runs'], { ...homes, FADENO_BUNDLED_RUNTIME: older });
  assert.equal(resultDowngrade.status, 0);
  const afterDowngradeManifest = readInstallationManifest(pathsOpts);
  assert.equal(afterDowngradeManifest.runtime?.version, packageVersion(), 'preflight must never downgrade version');
  assert.notEqual(readFileSync(up.managedCli, 'utf8'), 'old-bytes-cli', 'preflight must not downgrade to older bytes');
  // Never installs fresh: new isolated homes with no prior runtime
  const freshRoot = tempRepo(t);
  mkdirSync(join(freshRoot, '.fadeno'), { recursive: true });
  const freshHomes = {
    FADENO_CONFIG_HOME: join(freshRoot, 'user-config2'),
    FADENO_STATE_HOME: join(freshRoot, 'user-state2'),
    FADENO_DATA_HOME: join(freshRoot, 'user-data2'),
    FADENO_BUNDLED_RUNTIME: newer,
  };
  const freshUp = userPaths({ home: join(freshRoot, 'home2'), env: freshHomes });
  const freshResult = runWithEnv(freshRoot, ['runs'], freshHomes);
  assert.equal(freshResult.status, 0);
  assert.ok(!existsSync(freshUp.managedCli), 'preflight must never create first install on fresh machine');
  // Unknown command should not trigger refresh: install older again in freshRoot2
  const root2 = tempRepo(t);
  const homes2 = {
    FADENO_CONFIG_HOME: join(root2, 'user-config'),
    FADENO_STATE_HOME: join(root2, 'user-state'),
    FADENO_DATA_HOME: join(root2, 'user-data'),
  };
  const up2 = userPaths({ home: join(root2, 'home'), env: homes2 });
  const older2 = makeSource('older2-cli-unknown', '0.6.0-rc.32', 'old2');
  let man2 = readInstallationManifest({ home: join(root2, 'home'), env: homes2 });
  syncManagedRuntime(up2, older2, man2, { allowInstall: true, trustSource: true });
  const newer2 = makeSource('newer2-cli-unknown', '0.6.0-rc.33', 'new2');
  mkdirSync(join(root2, '.fadeno'), { recursive: true });
  const unknown = runWithEnv(root2, ['halp'], { ...homes2, FADENO_BUNDLED_RUNTIME: newer2 });
  // halp should fail (unknown command) and not refresh
  assert.notEqual(unknown.status, 0);
  assert.equal(readFileSync(up2.managedCli, 'utf8'), 'old2', 'unknown typo command must not trigger preflight refresh');
  assert.ok(!unknown.stderr.includes('refreshed') && !unknown.stdout.includes('refreshed'), 'unknown command should not emit refresh message');
});
