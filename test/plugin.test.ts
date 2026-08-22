import assert from 'node:assert/strict';
import { templatesDir } from '../src/lib/paths.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { runPlugin } from '../src/commands/plugin.ts';
import { exists, read, tempRepo } from './helpers.ts';

// Escape hatch for parallel/work-in-progress edits: a template change makes the
// committed plugin stale until `npm run build:plugin` reruns, which otherwise
// blocks running the rest of the suite mid-flight. `FADENO_SKIP_DRIFT=1` skips
// only the committed-vs-fresh comparisons. Unset (or empty) → unchanged behavior.
const SKIP_DRIFT: string | false = process.env.FADENO_SKIP_DRIFT
  ? 'FADENO_SKIP_DRIFT set — drift unchecked, rebuild plugins and rerun before integration'
  : false;

/** Every file under `dir`, as paths relative to it (recursive). */
function listFilesRel(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRel(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

test('plugin generates manifest, namespaced skills, and subagents', (t) => {
  const root = tempRepo(t);
  const { outDir } = runPlugin({ cwd: root, outDir: join(root, 'plugin') });

  // manifest
  assert.ok(exists(outDir, '.claude-plugin/plugin.json'));
  const manifest = JSON.parse(readFileSync(join(outDir, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'fadeno');
  assert.equal(typeof manifest.version, 'string');

  // skills use short dir names → /fadeno:runner, /fadeno:builder, /fadeno:driver
  assert.ok(exists(outDir, 'skills/runner/SKILL.md'));
  assert.ok(exists(outDir, 'skills/runner/references/runtime.md'));
  assert.ok(exists(outDir, 'skills/builder/SKILL.md'));
  assert.ok(exists(outDir, 'skills/driver/SKILL.md'));
  assert.ok(exists(outDir, 'skills/setup/SKILL.md'));
  // `fadeno-bakeoff`'s template shortens to `bakeoff`, never `judge` — the plugin
  // already ships a SUBAGENT named `judge` (checked below), and a skill and a
  // subagent sharing one identifier across two different tool surfaces would
  // be ambiguous to a coordinator choosing between them.
  assert.ok(exists(outDir, 'skills/bakeoff/SKILL.md'));
  assert.ok(!exists(outDir, 'skills/judge/SKILL.md'), 'the judge skill must not collide with the judge subagent');
  for (const skill of ['runner', 'builder', 'driver', 'setup', 'bakeoff']) {
    const launcher = join(outDir, 'skills', skill, 'scripts', 'fadeno.cjs');
    assert.ok(existsSync(launcher), `${skill} must carry its private CLI launcher`);
    assert.notEqual(statSync(launcher).mode & 0o111, 0, `${skill} CLI launcher must be executable`);
  }

  const runner = readFileSync(join(outDir, 'skills/runner/SKILL.md'), 'utf8');
  const builder = readFileSync(join(outDir, 'skills/builder/SKILL.md'), 'utf8');
  const driver = readFileSync(join(outDir, 'skills/driver/SKILL.md'), 'utf8');
  const bakeoff = readFileSync(join(outDir, 'skills/bakeoff/SKILL.md'), 'utf8');
  assert.match(bakeoff, /^name: bakeoff$/m);
  assert.match(runner, /^name: runner$/m);
  assert.doesNotMatch(runner, /disable-model-invocation/);
  assert.match(builder, /^name: builder$/m);
  // Builder stays model-invocable — a builder gated with disable-model-invocation
  // was uninvocable (plugin skills aren't reliably slash-invocable).
  assert.doesNotMatch(builder, /disable-model-invocation/);
  assert.match(driver, /^name: driver$/m);
  assert.match(driver, /fadeno next/);

  // slash-command entry points → /fadeno:runner, /fadeno:builder, /fadeno:driver
  assert.ok(exists(outDir, 'commands/runner.md'));
  assert.ok(exists(outDir, 'commands/builder.md'));
  assert.ok(exists(outDir, 'commands/driver.md'));
  assert.ok(exists(outDir, 'commands/setup.md'));

  // Claude plugins register the inert-native steering hook explicitly.
  assert.ok(exists(outDir, 'hooks/dispatch-steering.mjs'));
  const hooks = JSON.parse(read(outDir, 'hooks/hooks.json'));
  assert.equal(hooks.hooks.PreToolUse[0].matcher, 'Agent');

  // subagents — namespaced as fadeno:worker / :reviewer / :judge
  assert.ok(exists(outDir, 'agents/worker.md'));
  assert.ok(exists(outDir, 'agents/reviewer.md'));
  assert.ok(exists(outDir, 'agents/judge.md'));

  // the plugin carries no per-repo definitions
  assert.ok(!exists(outDir, 'skills/runner/playbooks'));
});

test('the committed plugin/ matches a fresh generation (no drift)', { skip: SKIP_DRIFT }, (t) => {
  const root = tempRepo(t);
  const { outDir } = runPlugin({ cwd: root, outDir: join(root, 'plugin') });
  const committedDir = join(import.meta.dirname, '..', 'plugin');

  // `runPlugin` emits the whole plugin surface EXCEPT bin/ (the esbuild bundle +
  // its bundled templates), which `npm run build:bin` produces — so diff
  // everything else, in both directions, file by file.
  const generated = listFilesRel(outDir).sort();
  const committed = listFilesRel(committedDir)
    .filter((f) => !f.startsWith(`bin${sep}`))
    .sort();

  // Same file set: catches an added/removed/renamed template, not just edits.
  assert.deepEqual(
    committed,
    generated,
    'plugin/ file set differs from a fresh generation — run `npm run build:plugin`',
  );
  // Same contents.
  for (const rel of generated) {
    assert.equal(
      read(committedDir, rel),
      read(outDir, rel),
      `plugin/${rel} is stale — run \`npm run build:plugin\``,
    );
  }
});

test('the committed plugin ships a self-contained CJS binary + templates', () => {
  const binDir = join(import.meta.dirname, '..', 'plugin', 'bin');
  const bin = join(binDir, 'fadeno');
  assert.ok(existsSync(bin), 'plugin/bin/fadeno missing — run `npm run build:bin`');
  assert.ok(statSync(bin).mode & 0o111, 'plugin/bin/fadeno is not executable');
  assert.match(readFileSync(bin, 'utf8').split('\n', 1)[0]!, /^#!\/usr\/bin\/env node/);
  // Pinned to CommonJS so the extensionless bundle runs under a type:module ancestor.
  const pkg = JSON.parse(readFileSync(join(binDir, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'commonjs');
  assert.equal(pkg.name, 'fadeno-runtime', 'plugin/bin/package.json must carry runtime name marker');
  const version = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ).version;
  assert.equal(pkg.version, version, 'plugin/bin/package.json version must match package.json without executing binary');
  // The bundle bakes in the version (esbuild --define); executing it must report
  // the current package.json version — catches a forgotten `npm run build:bin`
  // after a bump (the marketplace cache is version-keyed, so a stale bin ships).
  const reported = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(reported, version, 'plugin/bin/fadeno is stale — run `npm run build:bin`');
  // Templates travel with the binary so `fadeno init` works with no node_modules.
  assert.ok(existsSync(join(binDir, 'templates', 'common', 'fadeno', 'vocabulary.md')));
});

test('the bundled CLI carries the Grok adapter templates', () => {
  const grokDir = join(import.meta.dirname, '..', 'plugin', 'bin', 'templates', 'grok');
  assert.ok(existsSync(join(grokDir, 'AGENTS.md')));
  for (const role of ['worker', 'reviewer', 'judge']) {
    const agent = join(grokDir, 'grok-agents', `${role}.md`);
    assert.ok(existsSync(agent), `bundled Grok ${role} agent template missing`);
    assert.match(readFileSync(agent, 'utf8'), new RegExp(`^name: ${role}$`, 'm'));
  }
  assert.match(readFileSync(join(grokDir, 'AGENTS.md'), 'utf8'), /\/fadeno-runner/);
});

test('the bundled CLI carries the OpenCode adapter templates', () => {
  const opencodeDir = join(import.meta.dirname, '..', 'plugin', 'bin', 'templates', 'opencode');
  assert.ok(existsSync(join(opencodeDir, 'AGENTS.md')), 'bundled OpenCode bootstrap template missing');
  for (const role of ['worker', 'reviewer', 'judge']) {
    const agent = join(opencodeDir, 'opencode-agents', `${role}.md`);
    assert.ok(existsSync(agent), `bundled OpenCode ${role} agent template missing`);
    const body = readFileSync(agent, 'utf8');
    assert.match(body, /^mode: subagent$/m, `bundled OpenCode ${role} agent must be a subagent`);
  }
  // OpenCode has no invocation sigil — its bootstrap names skills bare.
  const bootstrap = readFileSync(join(opencodeDir, 'AGENTS.md'), 'utf8');
  assert.match(bootstrap, /fadeno-runner/);
  assert.doesNotMatch(bootstrap, /\$fadeno-runner/);
});

test('every skill template declares the name of the directory it lives in', () => {
  // The generator renames a skill by replacing `name: <src>` with `name: <dst>`,
  // and `String.replace` with a needle that does not occur is a SILENT no-op —
  // so a template whose frontmatter disagrees with its directory ships the
  // WRONG name. That happened: `fadeno-judge/` was renamed to
  // `fadeno-bakeoff/` and the frontmatter inside it was not, emitting
  // `name: fadeno-judge` into a directory called `compare`.
  //
  // Asserted over the real templates rather than a fixture, because this is
  // the precondition the generator now throws on, and the drift starts here.
  const skillsDir = join(templatesDir(), 'common', 'skills');
  const dirs = readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory());
  assert.ok(dirs.length >= 5, 'expected the shipped skill set');
  for (const dir of dirs) {
    const md = readFileSync(join(skillsDir, dir, 'SKILL.md'), 'utf8');
    assert.match(md, new RegExp(`^name: ${dir}$`, 'm'), `${dir}/SKILL.md must declare name: ${dir}`);
  }
});
