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
