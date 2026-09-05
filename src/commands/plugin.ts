import { chmodSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { copyTree, emitFile, type EmitResult } from '../lib/fsutil.ts';
import { parseExecutorProfile, resolveRelay } from '../lib/executors.ts';
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
  { src: 'fadeno-host', dst: 'host' },
  { src: 'fadeno-setup', dst: 'setup' },
  // Named `compare`, never `judge`: the plugin already ships a SUBAGENT
  // named `judge` (`fadeno:judge`, the evaluator role this skill spawns), and
  // a skill answering to the same identifier would put two different things
  // behind one name across two tool surfaces. Named for the command it drives,
  // like the four above are named for their workflow rather than a role — so
  // the rule stays "strip the prefix", with no entry needing an exception.
  { src: 'fadeno-bakeoff', dst: 'bakeoff' },
] as const;

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

/** The template's placeholder declaration — the anchor both emitters replace. */
const HOOK_VERSION_DECL = "const HOOK_VERSION = 'dev';";

/**
 * Stamp an emitted hook copy with the package version, so every evidence row it
 * writes names the generation that wrote it. Plugin hooks load once at session
 * start from a version-keyed cache: a session keeps running the previous build's
 * hook after an upgrade, and without the stamp there is no way to tell which
 * generation produced a row written across that transition. The template keeps
 * `'dev'`, so a `dev` row means the template ran directly.
 */
export function stampHookVersion(js: string): string {
  return js.replace(HOOK_VERSION_DECL, `const HOOK_VERSION = '${packageVersion()}';`);
}

/**
 * The Claude relay identity declared by one executor catalog, or null when
 * that catalog states no opinion (or cannot be read at all).
 *
 * Deliberately ONE file rather than the layered profile. An emitted artifact
 * has to be a function of what it is emitted from: `plugin/` is committed and
 * checked for drift, so folding in a developer's user-scope catalog would make
 * the build machine-dependent, and `.claude/agents/` is scaffolding for one
 * repo, so it should follow that repo's catalog and nothing else.
 *
 * Failure is silent by design, and it is the one place that is right: the
 * alternative to the catalog's value here is the template's own literal, which
 * is valid and servable. (At *resolve* time there is no such alternative, so
 * `dial resolve` raises an unservable relay instead of swallowing it.)
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
 * Rewrite a dispatch proxy's frontmatter `model:` to the catalog's relay.
 *
 * A post-copy rewrite rather than a placeholder in the template, for the same
 * reason `stampHookVersion` is one: the template stays a valid, readable,
 * directly-runnable artifact — `templates/claude/claude-agents/*.md` is a real
 * agent definition a developer can read and a test can assert against, and a
 * `__FADENO_RELAY__` token would make it neither. It also keeps the literal
 * that the hook falls back to and the literal the frontmatter ships as the
 * same visible value in the same place.
 *
 * `null` (the catalog states no opinion) leaves the template untouched — the
 * built-in default, never an invented relay. Only a `dispatch-*` proxy's
 * frontmatter is touched: the role agents (`worker.md` and friends) declare no
 * model on purpose, and if one ever did it would be a ROLE identity, which the
 * dial owns and the relay must never overwrite.
 */
export function stampRelayModel(md: string, relayModelId: string | null): string {
  if (relayModelId == null || !md.startsWith('---\n')) return md;
  const end = md.indexOf('\n---\n', 4);
  if (end < 0) return md;
  const frontmatter = md.slice(0, end);
  if (!/^name: dispatch-/m.test(frontmatter) || !/^model: .*$/m.test(frontmatter)) return md;
  return frontmatter.replace(/^model: .*$/m, `model: ${relayModelId}`) + md.slice(end);
}

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
    //
    // Assert before replacing: `String.replace` with a needle that does not
    // occur is a SILENT no-op, so a template whose frontmatter name disagrees
    // with its directory ships the WRONG name and nothing says so. Observed
    // when `fadeno-judge/` was renamed to `fadeno-bakeoff/` and the
    // frontmatter inside was not — the generator emitted `name: fadeno-judge`
    // into a directory called `compare`, and only a test asserting the
    // rendered name caught it.
    if (!md.includes(`name: ${src}`)) {
      throw new Error(
        `templates/common/skills/${src}/SKILL.md must declare \`name: ${src}\` in its frontmatter — ` +
          'the emitted skill name is derived from it, so a mismatch renames nothing and ships silently.',
      );
    }
    md = stampSurfaceVersion(md.replace(`name: ${src}`, `name: ${dst}`));
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
  // Descriptions get the version stamp for surface-staleness detection.
  // The proxies' `model:` is the RELAY, and it comes from the catalog this
  // plugin ships (`relay.claude`) rather than a frozen literal. Frontmatter is
  // read once at session start, so this is the only moment it can be refreshed
  // — the steering hook re-reads the same key per spawn and wins where the two
  // disagree.
  const relayModel = relayModelForClaude(join(tpl, 'common', 'fadeno', 'executors.yaml'));
  for (const file of readdirSync(join(tpl, 'claude', 'claude-agents')).sort()) {
    const agentPath = join(outDir, 'agents', file);
    results.push({
      path: agentPath,
      status: emitFile(
        agentPath,
        stampRelayModel(
          stampSurfaceVersion(readFileSync(join(tpl, 'claude', 'claude-agents', file), 'utf8')),
          relayModel,
        ),
        force,
      ),
    });
  }
  // Claude plugin hook surface: use the plugin-local bundled `fadeno` and keep
  // the hook selective/inert for the native loadout.
  const hookPath = join(outDir, 'hooks', 'dispatch-steering.mjs');
  results.push({
    path: hookPath,
    status: emitFile(
      hookPath,
      stampHookVersion(readFileSync(join(tpl, 'claude', 'hooks', 'dispatch-steering.mjs'), 'utf8')),
      force,
    ),
  });
  const guardPath = join(outDir, 'hooks', 'dispatch-proxy-guard.mjs');
  results.push({
    path: guardPath,
    status: emitFile(guardPath, readFileSync(join(tpl, 'claude', 'hooks', 'dispatch-proxy-guard.mjs'), 'utf8'), force),
  });
  const hostModePath = join(outDir, 'hooks', 'host-mode.mjs');
  results.push({
    path: hostModePath,
    status: emitFile(
      hostModePath,
      readFileSync(join(tpl, 'common', 'plugin', 'host-mode-hook.mjs'), 'utf8'),
      force,
    ),
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
const CODEX_SKILLS = ['fadeno-runner', 'fadeno-builder', 'fadeno-driver', 'fadeno-host', 'fadeno-setup', 'fadeno-bakeoff'] as const;

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

  // Codex plugins discover hooks/hooks.json by convention. Host mode is inert
  // until this plugin user's explicit $fadeno-host invocation, then stores its
  // marker in PLUGIN_DATA rather than the repository.
  const hostModePath = join(outDir, 'hooks', 'host-mode.mjs');
  results.push({
    path: hostModePath,
    status: emitFile(
      hostModePath,
      readFileSync(join(tpl, 'common', 'plugin', 'host-mode-hook.mjs'), 'utf8'),
      force,
    ),
  });
  // The `PreToolUse` spawn guard, stamped like the Claude steering hook so the
  // evidence rows it writes name the generation that wrote them. A NEW hook
  // entry in hooks.json goes through Codex's review-and-trust flow on the next
  // session start, so an upgraded plugin only starts guarding after the user
  // accepts it.
  const spawnGuardPath = join(outDir, 'hooks', 'spawn-guard.mjs');
  results.push({
    path: spawnGuardPath,
    status: emitFile(
      spawnGuardPath,
      stampHookVersion(readFileSync(join(tpl, 'codex', 'hooks', 'spawn-guard.mjs'), 'utf8')),
      force,
    ),
  });
  const hookManifestPath = join(outDir, 'hooks', 'hooks.json');
  results.push({
    path: hookManifestPath,
    status: emitFile(
      hookManifestPath,
      readFileSync(join(tpl, 'codex', 'hooks', 'hooks.json'), 'utf8'),
      force,
    ),
  });

  return { outDir, results };
}

// omp plugin skills keep their full `fadeno-` names (the Codex convention):
// omp deduplicates skills by name across providers and hands every skill a
// native `/skill:<name>` command, so the Claude plugin's shortened names would
// buy nothing here while risking collisions with unrelated plugins.
const OMP_SKILLS = ['fadeno-runner', 'fadeno-builder', 'fadeno-driver', 'fadeno-bakeoff'] as const;

/**
 * Emit an omp plugin (`package.json` manifest + `skills/` + `agents/`) from the
 * SAME shared skill templates as the Claude and Codex plugins. Bodies stay
 * byte-identical to `fadeno init`'s — no surface-version stamps — because omp
 * keys plugin upgrades off the manifest version, exactly like Codex.
 *
 * Deliberately absent, with reasons:
 * - `commands/`: omp registers `/skill:<name>` for every discovered skill, so
 *   slash entry points need no separate artifact.
 * - `hooks/`: steering is an omp extension module under `extensions/`, loaded
 *   from the manifest's `omp.extensions` entry.
 * - `fadeno-setup` skill: `<cli> setup` supports only --codex/--claude, and
 *   the skill's own text says to use only the current host's line — shipping
 *   it here would teach an invocation that refuses.
 */
export function runOmpPlugin(opts: PluginOptions = {}): PluginResult {
  const cwd = opts.cwd ?? process.cwd();
  const tpl = templatesDir();
  const ref = opts.outDir ?? 'plugin-omp';
  const outDir = isAbsolute(ref) ? ref : resolve(cwd, ref);
  const force = opts.force ?? false;
  const results: EmitResult[] = [];

  // `package.json` IS the omp plugin manifest: the `omp` key is what runtime
  // plugin discovery requires before a package counts as loadable, and the
  // version is single-sourced from package.json like both other manifests.
  const manifest =
    JSON.stringify(
      {
        name: 'fadeno',
        version: packageVersion(),
        description:
          'Run and author Fadeno playbooks — repeatable plan/implement/review/test workflows with file-backed run traces. Seed a repo with `fadeno init --omp --data-only`.',
        license: 'MIT',
        repository: 'https://github.com/CrocSwap/fadeno',
        keywords: ['ai', 'agents', 'omp', 'playbook', 'workflow', 'skills'],
        omp: { extensions: ['./extensions/fadeno-steering.ts'] },
      },
      null,
      2,
    ) + '\n';
  const manifestPath = join(outDir, 'package.json');
  results.push({ path: manifestPath, status: emitFile(manifestPath, manifest, force) });

  for (const skill of OMP_SKILLS) {
    // Full-named, unmodified SKILL.md — byte-identical to the other plugins'
    // bodies and `fadeno init`'s (the shared single source).
    const skillMd = readFileSync(join(tpl, 'common', 'skills', skill, 'SKILL.md'), 'utf8');
    const skillMdPath = join(outDir, 'skills', skill, 'SKILL.md');
    results.push({ path: skillMdPath, status: emitFile(skillMdPath, skillMd, force) });
    const references = join(tpl, 'common', 'skills', skill, 'references');
    if (existsSync(references)) copyTree(references, join(outDir, 'skills', skill, 'references'), force, results);
    const launcherPath = join(outDir, 'skills', skill, 'scripts', 'fadeno.cjs');
    results.push({
      path: launcherPath,
      status: emitFile(
        launcherPath,
        readFileSync(join(tpl, 'common', 'plugin', 'fadeno.cjs'), 'utf8')
          .replace('__FADENO_HARNESS__', 'omp'),
        force,
      ),
    });
    chmodSync(launcherPath, 0o755);
  }

  const extensionPath = join(outDir, 'extensions', 'fadeno-steering.ts');
  results.push({
    path: extensionPath,
    status: emitFile(
      extensionPath,
      stampHookVersion(readFileSync(join(tpl, 'omp', 'extensions', 'fadeno-steering.ts'), 'utf8')),
      force,
    ),
  });

  // Task agents: role agents plus dispatch proxies in omp's format (name +
  // description frontmatter required; proxies are bash-only relays). Discovered
  // from the installed plugin tree's `agents/` subdir by task-agent discovery.
  copyTree(join(tpl, 'omp', 'omp-agents'), join(outDir, 'agents'), force, results);
  // The extension may need an alias when a project owns the conventional
  // `worker`/`dispatch-worker` name. Carry both native and alias role surfaces
  // in the global plugin so a plugin-only setup remains routable.
  for (const archetype of ['worker', 'reviewer', 'judge']) {
    const roleSource = readFileSync(join(tpl, 'omp', 'omp-agents', `${archetype}.md`), 'utf8');
    const dispatchSource = readFileSync(join(tpl, 'omp', 'omp-agents', `dispatch-${archetype}.md`), 'utf8');
    const refusal = `---\nname: fadeno-steering-refused-${archetype}\ndescription: Reports why Fadeno refused a ${archetype} spawn, then stops.\ntools: read\n---\n\nRelay the Fadeno steering refusal verbatim, state that the requested work was not started, and stop.\n`;
    const refusalAlias = refusal.replace(`name: fadeno-steering-refused-${archetype}`, `name: fadeno-steering-refusal-${archetype}`);
    const hostAlias = roleSource.replace(`name: ${archetype}`, `name: fadeno-steering-host-${archetype}`);
    const dispatch = dispatchSource.replace(`name: dispatch-${archetype}`, `name: fadeno-dispatch-${archetype}`);
    const dispatchAlias = dispatch.replace(`name: fadeno-dispatch-${archetype}`, `name: fadeno-steering-command-${archetype}`);
    for (const [name, body] of [
      [`fadeno-steering-host-${archetype}.md`, hostAlias],
      [`fadeno-dispatch-${archetype}.md`, dispatch],
      [`fadeno-steering-command-${archetype}.md`, dispatchAlias],
      [`fadeno-steering-refused-${archetype}.md`, refusal],
      [`fadeno-steering-refusal-${archetype}.md`, refusalAlias],
    ] as const) {
      results.push({ path: join(outDir, 'agents', name), status: emitFile(join(outDir, 'agents', name), body, force) });
    }
  }

  // The committed standalone bundle is copied during generation and rebuilt by
  // scripts/build-bin.mjs, exactly like the Codex plugin's bin/.
  const repoBundle = join(tpl, '..', 'plugin-omp', 'bin');
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
