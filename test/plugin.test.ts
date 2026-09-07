import assert from 'node:assert/strict';
import { templatesDir } from '../src/lib/paths.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { roleAgentDefinition, runPlugin, stampSurfaceVersion } from '../src/commands/plugin.ts';
import { BUILTIN_ARCHETYPE_DESCRIPTIONS } from '../src/lib/contracts.ts';
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

  // skills use short dir names → /fadeno:host, /fadeno:setup
  assert.ok(exists(outDir, 'skills/host/SKILL.md'));
  assert.ok(exists(outDir, 'skills/setup/SKILL.md'));
  assert.ok(!exists(outDir, 'skills/judge/SKILL.md'), 'no skill may collide with the judge subagent');
  for (const skill of ['host', 'setup']) {
    const launcher = join(outDir, 'skills', skill, 'scripts', 'fadeno.cjs');
    assert.ok(existsSync(launcher), `${skill} must carry its private CLI launcher`);
    assert.notEqual(statSync(launcher).mode & 0o111, 0, `${skill} CLI launcher must be executable`);
  }

  const host = readFileSync(join(outDir, 'skills/host/SKILL.md'), 'utf8');
  assert.match(host, /^name: host$/m);
  assert.match(host, /Operate as the\nhost: decompose the task/);

  // slash-command entry points → /fadeno:host, /fadeno:setup
  assert.ok(exists(outDir, 'commands/host.md'));
  assert.ok(exists(outDir, 'commands/setup.md'));

  // The hook family: the spawn wrapper, the Bash guard, the stop hook, host
  // mode, and the library they share — every one registered in hooks.json.
  for (const hook of ['hook-lib.mjs', 'spawn-claude.mjs', 'bash-guard.mjs', 'agent-stop.mjs', 'host-mode.mjs']) {
    assert.ok(exists(outDir, `hooks/${hook}`), hook);
    assert.equal(read(outDir, `hooks/${hook}`), readFileSync(join(templatesDir(), 'hooks', hook), 'utf8'), `${hook} is the template, byte for byte`);
  }
  const hooks = JSON.parse(read(outDir, 'hooks/hooks.json'));
  assert.equal(hooks.hooks.UserPromptExpansion[0].matcher, '(^|:)host$');
  assert.equal(hooks.hooks.PreToolUse[0].matcher, 'Agent');
  assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/spawn-claude\.mjs/);
  assert.equal(hooks.hooks.PreToolUse[1].matcher, 'Bash');
  assert.match(hooks.hooks.PreToolUse[1].hooks[0].command, /bash-guard\.mjs/);
  assert.match(hooks.hooks.SubagentStop[0].hooks[0].command, /agent-stop\.mjs/);
  assert.ok(!exists(outDir, 'hooks/dispatch-steering.mjs'));

  // Agents: one per canonical archetype, generated from the vocabulary's
  // descriptions, plus the single dispatch proxy on the catalog's relay model.
  for (const archetype of ['director', 'judge', 'reviewer', 'scout', 'worker']) {
    const md = read(outDir, `agents/${archetype}.md`);
    assert.match(md, new RegExp(`^name: ${archetype}$`, 'm'));
    assert.ok(md.includes(BUILTIN_ARCHETYPE_DESCRIPTIONS[archetype]!), `${archetype} carries the vocabulary's description`);
    assert.match(md, new RegExp(`Spawn it as fadeno:${archetype};`));
    assert.match(md, /\[fadeno \d+\.\d+\.\d+[^\]]*\]$/m, 'surface-version stamped');
    assert.doesNotMatch(md, /^model: /m, 'role agents never pin a model; the dial owns it');
    assert.equal(md, stampSurfaceVersion(roleAgentDefinition(archetype, 'claude')));
  }
  const proxy = read(outDir, 'agents/dispatch.md');
  assert.match(proxy, /^name: dispatch$/m);
  assert.match(proxy, /^tools: Bash$/m);
  assert.match(proxy, /^model: sonnet$/m, 'the relay from the shipped catalog');
  assert.ok(!exists(outDir, 'agents/dispatch-worker.md'), 'one proxy, not one per archetype');

  // the plugin carries no per-repo definitions
  assert.ok(!exists(outDir, 'skills/host/playbooks'));
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
  assert.ok(existsSync(join(binDir, 'templates', 'common', 'fadeno', 'executors.yaml')));
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
  assert.ok(dirs.length >= 2, 'expected the shipped skill set');
  for (const dir of dirs) {
    const md = readFileSync(join(skillsDir, dir, 'SKILL.md'), 'utf8');
    assert.match(md, new RegExp(`^name: ${dir}$`, 'm'), `${dir}/SKILL.md must declare name: ${dir}`);
  }
});
