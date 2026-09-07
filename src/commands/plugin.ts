import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BUILTIN_ARCHETYPE_DESCRIPTIONS } from '../lib/contracts.ts';
import { ARCHETYPE_DISPLAY_ORDER, parseExecutorProfile, resolveRelay } from '../lib/executors.ts';
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

const DESCRIPTION =
  'A meta-harness for subagent workflows: route archetypes to models, spawn subagents in scaffolded worktrees, and keep a ledger of every dispatch.';

// Plugin skill dirs are short (namespaced as fadeno:host, fadeno:setup) and
// are generated from the shared SKILL.md bodies. They stay model-invocable;
// the matching commands/ entries give explicit /fadeno:host, /fadeno:setup
// slash handles (plugin skills are not reliably slash-invocable on their own).
const SKILLS = [
  { src: 'fadeno-host', dst: 'host' },
  { src: 'fadeno-setup', dst: 'setup' },
] as const;

/** The hooks every plugin ships, and the harness-specific spawn hook each adds. */
const COMMON_HOOKS = ['hook-lib.mjs', 'bash-guard.mjs', 'agent-stop.mjs', 'host-mode.mjs'] as const;

/**
 * Append `[fadeno <version>]` to a definition's frontmatter description. The
 * agent/skill listing is the only view of the plugin surface a live session
 * has, and it loads at session start — the stamp makes a stale surface
 * *detectable* (ask the session what version its fadeno surface reports and
 * compare against `claude plugin list`).
 */
export function stampSurfaceVersion(md: string): string {
  return md.replace(/^(description:.*?)\s*$/m, `$1 [fadeno ${packageVersion()}]`);
}

/**
 * The Claude relay identity declared by one executor catalog, or null when
 * that catalog states no opinion (or cannot be read at all).
 *
 * Deliberately ONE file rather than the layered profile. An emitted artifact
 * has to be a function of what it is emitted from: `plugin/` is committed and
 * checked for drift, so folding in a developer's user-scope catalog would make
 * the build machine-dependent.
 *
 * Failure is silent by design: the alternative to the catalog's value here is
 * the template's own literal, which is valid and servable.
 */
export function relayModelForClaude(catalogPath: string): string | null {
  if (!existsSync(catalogPath)) return null;
  try {
    const profile = parseExecutorProfile(readFileSync(catalogPath, 'utf8'), catalogPath, 'claude');
    return resolveRelay(profile, 'claude')?.modelId ?? null;
  } catch {
    return null;
  }
}

/**
 * Rewrite the dispatch proxy's frontmatter `model:` to the catalog's relay.
 *
 * A post-copy rewrite rather than a placeholder in the template, so the
 * template stays a valid, readable, directly-runnable agent definition. `null`
 * (the catalog states no opinion) leaves the template untouched — the built-in
 * default, never an invented relay. Only the proxy is touched: the role agents
 * declare no model on purpose, and if one ever did it would be a ROLE
 * identity, which the dial owns and the relay must never overwrite.
 */
export function stampRelayModel(md: string, relayModelId: string | null): string {
  if (relayModelId == null || !md.startsWith('---\n')) return md;
  const end = md.indexOf('\n---\n', 4);
  if (end < 0) return md;
  const frontmatter = md.slice(0, end);
  if (!/^name: dispatch$/m.test(frontmatter) || !/^model: .*$/m.test(frontmatter)) return md;
  return frontmatter.replace(/^model: .*$/m, `model: ${relayModelId}`) + md.slice(end);
}

/**
 * A role agent definition for one canonical archetype, in the markdown
 * frontmatter shape Claude Code and omp both read. Generated, not templated:
 * the description is the one `fadeno context` prints (contracts.ts), so the
 * agent list a director reads and the vocabulary it is told cannot drift.
 * The body is deliberately thin — the task and the dispatch contract arrive
 * in the prompt, put there by the spawn wrapper.
 */
export function roleAgentDefinition(archetype: string, harness: 'claude' | 'omp'): string {
  const description = BUILTIN_ARCHETYPE_DESCRIPTIONS[archetype];
  if (description == null) throw new Error(`no builtin description for archetype ${archetype}`);
  const spawnAs = harness === 'claude' ? `fadeno:${archetype}` : archetype;
  return [
    '---',
    `name: ${archetype}`,
    `description: ${description} Spawn it as ${spawnAs}; Fadeno routes it to the dialed model, cuts its worktree, and appends the dispatch contract to your prompt.`,
    '---',
    '',
    `You are the \`${archetype}\` archetype of a Fadeno dispatch. Your task and the`,
    'dispatch contract are in your prompt: the contract says where to work, what',
    'you own, and what your final message must contain. Follow both. If your prompt',
    'carries no `## Fadeno dispatch` contract, you were spawned outside Fadeno; do',
    'the task as asked and say so in your report.',
    '',
  ].join('\n');
}

function emit(results: EmitResult[], path: string, content: string, force: boolean): void {
  results.push({ path, status: emitFile(path, content, force) });
}

function emitHooks(results: EmitResult[], outDir: string, tpl: string, spawnHook: string, manifest: string, force: boolean): void {
  for (const file of [...COMMON_HOOKS, spawnHook]) {
    emit(results, join(outDir, 'hooks', file), readFileSync(join(tpl, 'hooks', file), 'utf8'), force);
  }
  emit(results, join(outDir, 'hooks', 'hooks.json'), readFileSync(join(tpl, 'hooks', manifest), 'utf8'), force);
}

function emitBundledBin(results: EmitResult[], outDir: string, tpl: string, committedDirName: string, force: boolean): void {
  // The committed standalone bundle is copied during generation and rebuilt by
  // scripts/build-bin.mjs, so a fresh plugin has the same self-contained
  // runtime surface as the committed one.
  const repoBundle = join(tpl, '..', committedDirName, 'bin');
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
}

function emitLauncher(results: EmitResult[], skillDir: string, tpl: string, harness: string, force: boolean): void {
  const launcherPath = join(skillDir, 'scripts', 'fadeno.cjs');
  emit(results, launcherPath, readFileSync(join(tpl, 'common', 'plugin', 'fadeno.cjs'), 'utf8').replace('__FADENO_HARNESS__', harness), force);
  chmodSync(launcherPath, 0o755);
}

/**
 * Emit a Claude Code plugin from the shared templates: the host and setup
 * skills with their slash commands, one role agent per canonical archetype
 * plus the dispatch proxy, the hook family (spawn wrapper, Bash guard, stop
 * hook, host mode), and the bundled CLI.
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
        description: DESCRIPTION,
        version: packageVersion(),
        author: { name: 'Fadeno' },
        keywords: ['ai', 'agents', 'subagents', 'workflow', 'skills'],
      },
      null,
      2,
    ) + '\n';
  emit(results, join(outDir, '.claude-plugin', 'plugin.json'), manifest, force);

  for (const { src, dst } of SKILLS) {
    let md = readFileSync(join(tpl, 'common', 'skills', src, 'SKILL.md'), 'utf8');
    // Assert before replacing: `String.replace` with a needle that does not
    // occur is a SILENT no-op, so a template whose frontmatter name disagrees
    // with its directory would ship the WRONG name and nothing would say so.
    if (!md.includes(`name: ${src}`)) {
      throw new Error(
        `templates/common/skills/${src}/SKILL.md must declare \`name: ${src}\` in its frontmatter — ` +
          'the emitted skill name is derived from it, so a mismatch renames nothing and ships silently.',
      );
    }
    md = stampSurfaceVersion(md.replace(`name: ${src}`, `name: ${dst}`));
    emit(results, join(outDir, 'skills', dst, 'SKILL.md'), md, force);
    const references = join(tpl, 'common', 'skills', src, 'references');
    if (existsSync(references)) copyTree(references, join(outDir, 'skills', dst, 'references'), force, results);
    emitLauncher(results, join(outDir, 'skills', dst), tpl, 'claude', force);
  }

  // Slash-command entry points (/fadeno:host, /fadeno:setup).
  copyTree(join(tpl, 'common', 'commands'), join(outDir, 'commands'), force, results);

  // Agents: one per canonical archetype, generated from the descriptions the
  // vocabulary prints, plus the dispatch proxy. The proxy's `model:` is the
  // RELAY, taken from the catalog this plugin ships (`relay` under the claude
  // harness) rather than a frozen literal.
  for (const archetype of ARCHETYPE_DISPLAY_ORDER) {
    emit(results, join(outDir, 'agents', `${archetype}.md`), stampSurfaceVersion(roleAgentDefinition(archetype, 'claude')), force);
  }
  const relayModel = relayModelForClaude(join(tpl, 'common', 'fadeno', 'executors.yaml'));
  emit(
    results,
    join(outDir, 'agents', 'dispatch.md'),
    stampRelayModel(stampSurfaceVersion(readFileSync(join(tpl, 'claude', 'claude-agents', 'dispatch.md'), 'utf8')), relayModel),
    force,
  );

  emitHooks(results, outDir, tpl, 'spawn-claude.mjs', 'hooks-claude.json', force);
  return { outDir, results };
}

// Codex plugin skills keep their full `fadeno-` names — Codex invokes them as
// `$fadeno-host` / `$fadeno-setup` (the openai.yaml policies reference those
// handles), unlike the Claude plugin which shortens to the `fadeno:` namespace.
const CODEX_SKILLS = ['fadeno-host', 'fadeno-setup'] as const;

/**
 * Emit a Codex CLI plugin (`.codex-plugin/plugin.json` + `skills/` + `hooks/`
 * + `bin/`) from the same shared templates. No agents: Codex custom agents are
 * user-scoped TOML files outside a plugin, and a Codex hook can refuse a spawn
 * but not rewrite one, so delegated work there goes through the command lane
 * (see `templates/hooks/spawn-codex.mjs`).
 */
export function runCodexPlugin(opts: PluginOptions = {}): PluginResult {
  const cwd = opts.cwd ?? process.cwd();
  const tpl = templatesDir();
  const ref = opts.outDir ?? 'plugin-codex';
  const outDir = isAbsolute(ref) ? ref : resolve(cwd, ref);
  const force = opts.force ?? false;
  const results: EmitResult[] = [];

  // Only documented fields: the manifest validator rejects unknown keys.
  const manifest =
    JSON.stringify(
      {
        name: 'fadeno',
        version: packageVersion(),
        description: DESCRIPTION,
        author: { name: 'Fadeno' },
        repository: 'https://github.com/CrocSwap/fadeno',
        license: 'MIT',
        keywords: ['ai', 'agents', 'codex', 'subagents', 'workflow', 'skills'],
        skills: './skills/',
        interface: {
          displayName: 'Fadeno',
          shortDescription: 'Route delegated work by archetype, in worktrees, with a ledger.',
          category: 'Engineering',
        },
      },
      null,
      2,
    ) + '\n';
  emit(results, join(outDir, '.codex-plugin', 'plugin.json'), manifest, force);

  for (const skill of CODEX_SKILLS) {
    // Full-named, unmodified SKILL.md — byte-identical to the shared source.
    emit(results, join(outDir, 'skills', skill, 'SKILL.md'), readFileSync(join(tpl, 'common', 'skills', skill, 'SKILL.md'), 'utf8'), force);
    const references = join(tpl, 'common', 'skills', skill, 'references');
    if (existsSync(references)) copyTree(references, join(outDir, 'skills', skill, 'references'), force, results);
    // Per-skill invocation policy: the openai.yaml that says host mode is explicit-only.
    emit(results, join(outDir, 'skills', skill, 'agents', 'openai.yaml'), readFileSync(join(tpl, 'codex', 'openai', `${skill}.yaml`), 'utf8'), force);
    emitLauncher(results, join(outDir, 'skills', skill), tpl, 'codex', force);
  }

  emitBundledBin(results, outDir, tpl, 'plugin-codex', force);
  // Codex keys hook trust per matcher group by index, so the manifest's group
  // ORDER is part of the contract: the spawn hook first, the Bash guard second.
  emitHooks(results, outDir, tpl, 'spawn-codex.mjs', 'hooks-codex.json', force);
  return { outDir, results };
}

// omp plugin skills keep their full `fadeno-` names (the Codex convention):
// omp deduplicates skills by name across providers and hands every skill a
// native `/skill:<name>` command. `fadeno-setup` is absent: `<cli> setup`
// supports only --codex/--claude.
const OMP_SKILLS = ['fadeno-host'] as const;

/**
 * Emit an omp plugin (`package.json` manifest + `skills/` + `agents/` +
 * `extensions/`). The spawn wrapper is an extension module, loaded from the
 * manifest's `omp.extensions` entry; there is no hooks directory. No
 * `commands/` either: omp registers `/skill:<name>` for every skill.
 */
export function runOmpPlugin(opts: PluginOptions = {}): PluginResult {
  const cwd = opts.cwd ?? process.cwd();
  const tpl = templatesDir();
  const ref = opts.outDir ?? 'plugin-omp';
  const outDir = isAbsolute(ref) ? ref : resolve(cwd, ref);
  const force = opts.force ?? false;
  const results: EmitResult[] = [];

  // `package.json` IS the omp plugin manifest: the `omp` key is what runtime
  // plugin discovery requires before a package counts as loadable.
  const manifest =
    JSON.stringify(
      {
        name: 'fadeno',
        version: packageVersion(),
        description: DESCRIPTION,
        license: 'MIT',
        repository: 'https://github.com/CrocSwap/fadeno',
        keywords: ['ai', 'agents', 'omp', 'subagents', 'workflow', 'skills'],
        omp: { extensions: ['./extensions/fadeno.ts'] },
      },
      null,
      2,
    ) + '\n';
  emit(results, join(outDir, 'package.json'), manifest, force);

  for (const skill of OMP_SKILLS) {
    emit(results, join(outDir, 'skills', skill, 'SKILL.md'), readFileSync(join(tpl, 'common', 'skills', skill, 'SKILL.md'), 'utf8'), force);
    const references = join(tpl, 'common', 'skills', skill, 'references');
    if (existsSync(references)) copyTree(references, join(outDir, 'skills', skill, 'references'), force, results);
    emitLauncher(results, join(outDir, 'skills', skill), tpl, 'omp', force);
  }

  emit(results, join(outDir, 'extensions', 'fadeno.ts'), readFileSync(join(tpl, 'omp', 'extensions', 'fadeno.ts'), 'utf8'), force);

  // Task agents: one per canonical archetype plus the dispatch proxy, in omp's
  // format (name + description frontmatter required; the proxy is bash-only).
  for (const archetype of ARCHETYPE_DISPLAY_ORDER) {
    emit(results, join(outDir, 'agents', `${archetype}.md`), roleAgentDefinition(archetype, 'omp'), force);
  }
  emit(results, join(outDir, 'agents', 'dispatch.md'), readFileSync(join(tpl, 'omp', 'omp-agents', 'dispatch.md'), 'utf8'), force);

  emitBundledBin(results, outDir, tpl, 'plugin-omp', force);
  return { outDir, results };
}
