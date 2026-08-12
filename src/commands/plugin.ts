import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { copyTree, emitFile, type EmitResult } from '../lib/fsutil.ts';
import { packageVersion, templatesDir } from '../lib/paths.ts';

export interface PluginOptions {
  /** Output directory for the generated plugin (default ./plugin). */
  outDir?: string;
  force?: boolean;
  cwd?: string;
}

export interface PluginResult {
  outDir: string;
  results: EmitResult[];
}

// Plugin skill dirs are short (namespaced as fadeno:runner, fadeno:builder,
// fadeno:driver) and are generated from the same shared SKILL.md bodies used by
// `fadeno init`. They stay model-invocable; the matching commands/ entries give
// explicit /fadeno:runner, /fadeno:builder, /fadeno:driver slash handles (plugin
// skills are not reliably slash-invocable on their own).
const SKILLS = [
  { src: 'fadeno-runner', dst: 'runner' },
  { src: 'fadeno-builder', dst: 'builder' },
  { src: 'fadeno-driver', dst: 'driver' },
  { src: 'fadeno-setup', dst: 'setup' },
] as const;

/**
 * Emit a Claude Code plugin (the "capability" layer) from the shared templates,
 * so the skills/subagents stay in sync with `fadeno init` rather than being a
 * hand-maintained copy. The plugin also carries the bundled CLI and immutable
 * built-in definitions, so a repo-local data-only init is optional.
 */
export function runPlugin(opts: PluginOptions = {}): PluginResult {
  const cwd = opts.cwd ?? process.cwd();
  const tpl = templatesDir();
  const ref = opts.outDir ?? 'plugin';
  const outDir = isAbsolute(ref) ? ref : resolve(cwd, ref);
  const force = opts.force ?? false;
  const results: EmitResult[] = [];

  const manifest =
    JSON.stringify(
      {
        name: 'fadeno',
        description:
          'Run and author Fadeno playbooks — repeatable plan/implement/review/test workflows with file-backed run traces. Seed a repo with `fadeno init --claude --data-only`.',
        version: packageVersion(),
        author: { name: 'Fadeno' },
        keywords: ['ai', 'agents', 'playbook', 'workflow', 'skills'],
      },
      null,
      2,
    ) + '\n';
  const manifestPath = join(outDir, '.claude-plugin', 'plugin.json');
  results.push({ path: manifestPath, status: emitFile(manifestPath, manifest, force) });

  for (const { src, dst } of SKILLS) {
    let md = readFileSync(join(tpl, 'common', 'skills', src, 'SKILL.md'), 'utf8');
    // Use the short, namespaced skill name (fadeno:runner, fadeno:builder).
    md = md.replace(`name: ${src}`, `name: ${dst}`);
    const skillPath = join(outDir, 'skills', dst, 'SKILL.md');
    results.push({ path: skillPath, status: emitFile(skillPath, md, force) });
    const references = join(tpl, 'common', 'skills', src, 'references');
    if (existsSync(references)) copyTree(references, join(outDir, 'skills', dst, 'references'), force, results);
    const launcherPath = join(outDir, 'skills', dst, 'scripts', 'fadeno.cjs');
    results.push({
      path: launcherPath,
      status: emitFile(
        launcherPath,
        readFileSync(join(tpl, 'common', 'plugin', 'fadeno.cjs'), 'utf8')
          .replace('__FADENO_HARNESS__', 'claude'),
        force,
      ),
    });
    chmodSync(launcherPath, 0o755);
  }

  // Slash-command entry points (/fadeno:runner, /fadeno:builder). Plugin skills
  // are not reliably slash-invocable, so these commands are the explicit handles;
  // each one drives the matching model-invocable skill.
  copyTree(join(tpl, 'common', 'commands'), join(outDir, 'commands'), force, results);

  // Subagents: reuse the Claude markdown agent definitions (no hooks/mcp/perms,
  // which plugin agents disallow). They namespace as fadeno:worker / :reviewer /
  // :judge, plus the fadeno:dispatch-* proxies that relay archetype-shaped
  // subtasks to `fadeno dispatch` (loadouts-and-dispatch.md, plugin surface).
  copyTree(join(tpl, 'claude', 'claude-agents'), join(outDir, 'agents'), force, results);
  // Claude plugin hook surface: use the plugin-local bundled `fadeno` and keep
  // the hook selective/inert for the native loadout.
  const hookPath = join(outDir, 'hooks', 'dispatch-steering.mjs');
  results.push({
    path: hookPath,
    status: emitFile(hookPath, readFileSync(join(tpl, 'claude', 'hooks', 'dispatch-steering.mjs'), 'utf8'), force),
  });
  const hookManifestPath = join(outDir, 'hooks', 'hooks.json');
  results.push({
    path: hookManifestPath,
    status: emitFile(hookManifestPath, readFileSync(join(tpl, 'claude', 'hooks', 'hooks.json'), 'utf8'), force),
  });

  return { outDir, results };
}

// Codex plugin skills keep their full `fadeno-` names — Codex invokes them as
// `$fadeno-runner` / `$fadeno-builder` / `$fadeno-driver` (the openai.yaml
// policies reference those handles), unlike the Claude plugin which shortens to
// the `fadeno:runner` namespace form.
const CODEX_SKILLS = ['fadeno-runner', 'fadeno-builder', 'fadeno-driver', 'fadeno-setup'] as const;

/**
 * Emit a Codex CLI plugin (`.codex-plugin/plugin.json` + `skills/`) from the
 * SAME shared skill templates as the Claude plugin and `fadeno init`. Codex
 * role subagents remain user-scoped host materialization, while the plugin
 * carries its own CLI and immutable built-in definitions. Project init remains
 * available for explicit overrides and vendoring.
 */
export function runCodexPlugin(opts: PluginOptions = {}): PluginResult {
  const cwd = opts.cwd ?? process.cwd();
  const tpl = templatesDir();
  // Payload lives in a visible top-level dir (parallel to the Claude `plugin/`);
  // only the required marketplace pointer sits in `.agents/plugins/marketplace.json`.
  const ref = opts.outDir ?? 'plugin-codex';
  const outDir = isAbsolute(ref) ? ref : resolve(cwd, ref);
  const force = opts.force ?? false;
  const results: EmitResult[] = [];

  // `.codex-plugin/plugin.json` — only documented fields (the manifest validator
  // rejects unknown keys). Version is single-sourced from package.json, exactly
  // like the Claude manifest, so the no-drift guard keeps them in lockstep.
  const manifest =
    JSON.stringify(
      {
        name: 'fadeno',
        version: packageVersion(),
        description:
          'Run and author Fadeno playbooks — repeatable plan/implement/review/test workflows with file-backed run traces. Seed a repo with `fadeno init --codex --data-only`.',
        author: { name: 'Fadeno' },
        repository: 'https://github.com/CrocSwap/fadeno',
        license: 'MIT',
        keywords: ['ai', 'agents', 'codex', 'playbook', 'workflow', 'skills'],
        skills: './skills/',
        interface: {
          displayName: 'Fadeno',
          shortDescription:
            'Plan/implement/review/test workflows with file-backed run traces.',
          category: 'Engineering',
        },
      },
      null,
      2,
    ) + '\n';
  const manifestPath = join(outDir, '.codex-plugin', 'plugin.json');
  results.push({ path: manifestPath, status: emitFile(manifestPath, manifest, force) });

  for (const skill of CODEX_SKILLS) {
    // Full-named, unmodified SKILL.md — byte-identical to the Claude plugin's
    // body and `fadeno init`'s (the shared single source).
    const skillMd = readFileSync(join(tpl, 'common', 'skills', skill, 'SKILL.md'), 'utf8');
    const skillMdPath = join(outDir, 'skills', skill, 'SKILL.md');
    results.push({ path: skillMdPath, status: emitFile(skillMdPath, skillMd, force) });
    const references = join(tpl, 'common', 'skills', skill, 'references');
    if (existsSync(references)) copyTree(references, join(outDir, 'skills', skill, 'references'), force, results);
    // Per-skill invocation policy (runner implicit; builder/driver explicit-only)
    // — the same openai.yaml `fadeno init --codex` installs, honored in-plugin.
    const policy = readFileSync(join(tpl, 'codex', 'openai', `${skill}.yaml`), 'utf8');
    const policyPath = join(outDir, 'skills', skill, 'agents', 'openai.yaml');
    results.push({ path: policyPath, status: emitFile(policyPath, policy, force) });
    const launcherPath = join(outDir, 'skills', skill, 'scripts', 'fadeno.cjs');
    results.push({
      path: launcherPath,
      status: emitFile(
        launcherPath,
        readFileSync(join(tpl, 'common', 'plugin', 'fadeno.cjs'), 'utf8')
          .replace('__FADENO_HARNESS__', 'codex'),
        force,
      ),
    });
    chmodSync(launcherPath, 0o755);
  }

  // The committed standalone bundle is copied during generation and rebuilt by
  // scripts/build-bin.mjs. Keeping it in the generator's result means a fresh
  // Codex plugin has the same self-contained runtime surface as Claude.
  const repoBundle = join(tpl, '..', 'plugin-codex', 'bin');
  const adjacentBundle = dirname(tpl);
  const bundledBin = existsSync(join(repoBundle, 'fadeno'))
    ? repoBundle
    : existsSync(join(adjacentBundle, 'fadeno'))
      ? adjacentBundle
      : null;
  const destinationBin = join(outDir, 'bin');
  if (bundledBin != null && resolve(bundledBin) !== resolve(destinationBin)) {
    copyTree(bundledBin, destinationBin, force, results);
  }
  const destinationCli = join(destinationBin, 'fadeno');
  if (existsSync(destinationCli)) chmodSync(destinationCli, 0o755);

  return { outDir, results };
}
