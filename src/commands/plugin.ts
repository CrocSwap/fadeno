import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
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
] as const;

/**
 * Emit a Claude Code plugin (the "capability" layer) from the shared templates,
 * so the skills/subagents stay in sync with `fadeno init` rather than being a
 * hand-maintained copy. The per-repo "definitions" (playbooks/schemas) are NOT
 * part of the plugin — a user seeds those with `fadeno init --claude --data-only`.
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
    copyTree(
      join(tpl, 'common', 'skills', src, 'references'),
      join(outDir, 'skills', dst, 'references'),
      force,
      results,
    );
  }

  // Slash-command entry points (/fadeno:runner, /fadeno:builder). Plugin skills
  // are not reliably slash-invocable, so these commands are the explicit handles;
  // each one drives the matching model-invocable skill.
  copyTree(join(tpl, 'common', 'commands'), join(outDir, 'commands'), force, results);

  // Subagents: reuse the Claude markdown agent definitions (no hooks/mcp/perms,
  // which plugin agents disallow). They namespace as fadeno:worker / :reviewer / :judge.
  copyTree(join(tpl, 'claude', 'claude-agents'), join(outDir, 'agents'), force, results);

  return { outDir, results };
}

// Codex plugin skills keep their full `fadeno-` names — Codex invokes them as
// `$fadeno-runner` / `$fadeno-builder` / `$fadeno-driver` (the openai.yaml
// policies reference those handles), unlike the Claude plugin which shortens to
// the `fadeno:runner` namespace form.
const CODEX_SKILLS = ['fadeno-runner', 'fadeno-builder', 'fadeno-driver'] as const;

/**
 * Emit a Codex CLI plugin (`.codex-plugin/plugin.json` + `skills/`) from the
 * SAME shared skill templates as the Claude plugin and `fadeno init`. Two things
 * a Codex plugin does NOT carry — role subagents and a bundled CLI binary — stay
 * with `fadeno init --codex` (`.codex/agents/*.toml`) and npm (`npx fadeno`)
 * respectively; Codex plugins have no manifest slot for either. The per-repo
 * definitions (playbooks/schemas) are seeded with `fadeno init --codex --data-only`.
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
    copyTree(
      join(tpl, 'common', 'skills', skill, 'references'),
      join(outDir, 'skills', skill, 'references'),
      force,
      results,
    );
    // Per-skill invocation policy (runner implicit; builder/driver explicit-only)
    // — the same openai.yaml `fadeno init --codex` installs, honored in-plugin.
    const policy = readFileSync(join(tpl, 'codex', 'openai', `${skill}.yaml`), 'utf8');
    const policyPath = join(outDir, 'skills', skill, 'agents', 'openai.yaml');
    results.push({ path: policyPath, status: emitFile(policyPath, policy, force) });
  }

  return { outDir, results };
}
