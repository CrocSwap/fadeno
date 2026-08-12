import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { copyTree, emitBootstrap, emitFile, type EmitResult } from '../lib/fsutil.ts';
import { findRepoRoot, templatesDir } from '../lib/paths.ts';
import { FADENO_IGNORE_PATTERNS } from '../lib/source-control.ts';
import { stampHookVersion } from './plugin.ts';

export type Target = 'codex' | 'claude' | 'grok';

export interface InitOptions {
  target: Target;
  force?: boolean;
  /** Also scaffold tier-2 enforcement hooks (pre-commit, CI workflow, examples). */
  withHooks?: boolean;
  /** Compatibility alias for the default loadout-aware steering. */
  withSteering?: boolean;
  /** Explicitly keep the legacy native-only project surface. */
  noSteering?: boolean;
  /** Seed only the per-repo `.fadeno/` definitions; skip skills/subagents/bootstrap. */
  dataOnly?: boolean;
  /** Working directory used to locate the repo root. Defaults to process.cwd(). */
  cwd?: string;
  /** Explicit repo root (mainly for tests); bypasses git-root detection. */
  repoRoot?: string;
}

export interface InitResult {
  target: Target;
  repoRoot: string;
  results: EmitResult[];
}

const SKILLS = ['fadeno-runner', 'fadeno-builder', 'fadeno-driver'] as const;

/**
 * Scaffold a Fadeno setup for the given target into the repository.
 * Shared content (`.fadeno/`, SKILL.md bodies, references) is identical across
 * targets; only the adapter surface (skill dir, bootstrap file + sigil,
 * invocation policy, subagent format) differs.
 */
export function runInit(opts: InitOptions): InitResult {
  const tpl = templatesDir();
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const force = opts.force ?? false;
  const withSteering = opts.noSteering === true
    ? false
    : opts.withSteering ?? opts.target !== 'grok';
  const results: EmitResult[] = [];

  if (withSteering && opts.target === 'grok') {
    throw new Error('Loadout steering is currently supported for Codex and Claude Code, not Grok Build.');
  }

  // 1. Shared `.fadeno/` tree (vocabulary, playbooks, schemas, runs, enforcement).
  //    This is the per-repo "definitions" layer — always written.
  copyTree(join(tpl, 'common', 'fadeno'), join(repoRoot, '.fadeno'), force, results);
  // `.fadeno/local/` is per-machine session state (sticky loadout, prompt
  // relays) and `.fadeno/dispatches.jsonl` is per-machine dispatch evidence
  // (auditable locally, never committed) — scaffolding adds the ignore entries.
  ensureGitignored(
    repoRoot,
    [...FADENO_IGNORE_PATTERNS],
    results,
  );

  // Steps 2–4 install the "capability" layer (skills, subagents, bootstrap).
  // --data-only skips them: a plugin user gets capability from the plugin, so
  // init only needs to seed the definitions above.
  if (!opts.dataOnly) {
    // 2. Skills — shared bodies, per-target install dir and invocation policy.
    let skillsBase: string;
    switch (opts.target) {
      case 'codex':
        skillsBase = join(repoRoot, '.agents', 'skills');
        break;
      case 'claude':
        skillsBase = join(repoRoot, '.claude', 'skills');
        break;
      case 'grok':
        skillsBase = join(repoRoot, '.grok', 'skills');
        break;
    }

    for (const skill of SKILLS) {
      const skillSrc = join(tpl, 'common', 'skills', skill);
      const skillDest = join(skillsBase, skill);

      // Runner and builder skills are invocable: the runner fires on a described task, the
      // builder on explicit "author a playbook" intent (its description is
      // scoped to that). Codex's narrower invocation policy lives in openai.yaml
      // (below); Claude and Grok rely on the scoped description, not a
      // frontmatter gate.
      const skillMd = readFileSync(join(skillSrc, 'SKILL.md'), 'utf8');
      const skillMdPath = join(skillDest, 'SKILL.md');
      results.push({ path: skillMdPath, status: emitFile(skillMdPath, skillMd, force) });

      copyTree(join(skillSrc, 'references'), join(skillDest, 'references'), force, results);

      if (opts.target === 'codex') {
        const policy = readFileSync(join(tpl, 'codex', 'openai', `${skill}.yaml`), 'utf8');
        const policyPath = join(skillDest, 'agents', 'openai.yaml');
        results.push({ path: policyPath, status: emitFile(policyPath, policy, force) });
      }
    }

    // 3. Subagent definitions (provisional path/format — runner degrades when
    //    native subagents are unavailable).
    switch (opts.target) {
      case 'codex':
        copyTree(
          join(tpl, 'codex', withSteering ? 'codex-steering-agents' : 'codex-agents'),
          join(repoRoot, '.codex', 'agents'),
          force,
          results,
        );
        break;
      case 'claude':
        copyTree(join(tpl, 'claude', 'claude-agents'), join(repoRoot, '.claude', 'agents'), force, results);
        break;
      case 'grok':
        copyTree(join(tpl, 'grok', 'grok-agents'), join(repoRoot, '.grok', 'agents'), force, results);
        break;
    }

    // 4. Bootstrap instruction file (append-or-create, never clobber).
    let bootstrapName: 'AGENTS.md' | 'CLAUDE.md';
    switch (opts.target) {
      case 'claude':
        bootstrapName = 'CLAUDE.md';
        break;
      case 'codex':
      case 'grok':
        bootstrapName = 'AGENTS.md';
        break;
    }
    const bootstrapBody = readFileSync(join(tpl, opts.target, bootstrapName), 'utf8');
    emitBootstrap(join(repoRoot, bootstrapName), bootstrapBody, force, results);
  }

  // Codex plugins intentionally do not carry project-scoped custom agents.
  // A data-only plugin setup that explicitly requests steering still needs the
  // three local role overrides, while continuing to skip skills/bootstrap.
  if (opts.dataOnly && withSteering && opts.target === 'codex') {
    copyTree(
      join(tpl, 'codex', 'codex-steering-agents'),
      join(repoRoot, '.codex', 'agents'),
      force,
      results,
    );
  }

  // 5. Optional tier-2 enforcement scaffold (per-repo policy — allowed with --data-only).
  if (opts.withHooks) emitHooks(tpl, repoRoot, opts.target, force, results);

  // 6. Optional host-native loadout steering. Claude's rewrite script and
  // settings are local, git-ignored session machinery. Codex steering is the
  // custom-agent layer selected above, so no extra config mutation is needed.
  if (withSteering && opts.target === 'claude') {
    const steeringPath = join(repoRoot, CLAUDE_STEERING_SCRIPT);
    // Stamped like the plugin copy: the hook's evidence rows name the generation
    // that wrote them, which a session-start hook cache otherwise hides.
    const steeringBody = stampHookVersion(
      readFileSync(join(tpl, 'claude', 'hooks', 'dispatch-steering.mjs'), 'utf8'),
    );
    results.push({ path: steeringPath, status: emitFile(steeringPath, steeringBody, force) });
    const guardPath = join(repoRoot, CLAUDE_GUARD_SCRIPT);
    const guardBody = readFileSync(
      join(tpl, 'claude', 'hooks', 'dispatch-proxy-guard.mjs'),
      'utf8',
    );
    results.push({ path: guardPath, status: emitFile(guardPath, guardBody, force) });
  }

  // 7. Pre-approve the fadeno CLI locally so it stops prompting on every call
  //    (Claude only; written to git-ignored settings — a per-user convenience,
  //    not a trust decision committed to the shared repo). Plugins can't grant
  //    Bash permissions to themselves, so `init` is the seam for this.
  if (opts.target === 'claude') emitClaudeSettings(repoRoot, withSteering, results);

  return { target: opts.target, repoRoot, results };
}

const FADENO_BASH_RULE = 'Bash(fadeno:*)';
const CLAUDE_STEERING_SCRIPT = join('.fadeno', 'local', 'claude-dispatch-steering.mjs');
const CLAUDE_STEERING_COMMAND = `node ${CLAUDE_STEERING_SCRIPT}`;
const CLAUDE_GUARD_SCRIPT = join('.fadeno', 'local', 'claude-dispatch-proxy-guard.mjs');
const CLAUDE_GUARD_COMMAND = `node ${CLAUDE_GUARD_SCRIPT}`;
/** PreToolUse entries steering installs: spawn rewrite + proxy relay guard. */
const CLAUDE_STEERING_HOOKS: ReadonlyArray<{ matcher: string; command: string }> = [
  { matcher: 'Agent', command: CLAUDE_STEERING_COMMAND },
  { matcher: 'Bash', command: CLAUDE_GUARD_COMMAND },
];

/**
 * Merge a `Bash(fadeno:*)` allow rule into the repo's *local* Claude settings so
 * the agent isn't prompted on every `fadeno <verb>` call. Non-destructive:
 * preserves any existing rules, is idempotent, and leaves a malformed or
 * unexpectedly-shaped settings file untouched rather than clobbering it.
 */
function emitClaudeSettings(
  repoRoot: string,
  withSteering: boolean,
  results: EmitResult[],
): void {
  const settingsPath = join(repoRoot, '.claude', 'settings.local.json');
  const existed = existsSync(settingsPath);

  let data: Record<string, unknown> = {};
  if (existed) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        results.push({ path: settingsPath, status: 'skipped' }); // not an object — don't clobber
        return;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      results.push({ path: settingsPath, status: 'skipped' }); // malformed JSON — never clobber
      return;
    }
  }

  const perms =
    data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions)
      ? (data.permissions as Record<string, unknown>)
      : {};
  const allow = Array.isArray(perms.allow) ? [...(perms.allow as unknown[])] : [];

  let changed = false;
  if (!allow.includes(FADENO_BASH_RULE)) {
    allow.push(FADENO_BASH_RULE);
    perms.allow = allow;
    data.permissions = perms;
    changed = true;
  }

  if (withSteering) {
    const hooks =
      data.hooks == null
        ? {}
        : data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)
          ? (data.hooks as Record<string, unknown>)
          : null;
    if (hooks == null) {
      results.push({ path: settingsPath, status: 'skipped' });
      return;
    }
    const rawPreToolUse = hooks.PreToolUse;
    if (rawPreToolUse != null && !Array.isArray(rawPreToolUse)) {
      results.push({ path: settingsPath, status: 'skipped' });
      return;
    }
    const preToolUse = Array.isArray(rawPreToolUse) ? [...rawPreToolUse] : [];
    const hasCommand = (command: string): boolean =>
      preToolUse.some((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const handlers = (entry as Record<string, unknown>).hooks;
        return (
          Array.isArray(handlers) &&
          handlers.some(
            (handler) =>
              handler != null &&
              typeof handler === 'object' &&
              !Array.isArray(handler) &&
              (handler as Record<string, unknown>).command === command,
          )
        );
      });
    let hooksChanged = false;
    for (const { matcher, command } of CLAUDE_STEERING_HOOKS) {
      if (hasCommand(command)) continue;
      preToolUse.push({ matcher, hooks: [{ type: 'command', command }] });
      hooksChanged = true;
    }
    if (hooksChanged) {
      hooks.PreToolUse = preToolUse;
      data.hooks = hooks;
      changed = true;
    }
  }

  if (!changed) {
    results.push({ path: settingsPath, status: 'skipped' });
    return;
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  results.push({ path: settingsPath, status: existed ? 'appended' : 'created' });

  ensureGitignored(repoRoot, [...FADENO_IGNORE_PATTERNS], results);
}

/**
 * Append the given patterns to `.gitignore` (creating it if needed), skipping
 * any that are already ignored. Missing patterns land as one commented block
 * in one write, so repeated `init` runs never duplicate entries.
 */
function ensureGitignored(repoRoot: string, patterns: string[], results: EmitResult[]): void {
  const gitignorePath = join(repoRoot, '.gitignore');
  const existed = existsSync(gitignorePath);
  const content = existed ? readFileSync(gitignorePath, 'utf8') : '';
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const missing = patterns.filter((pattern) => {
    if (lines.includes(pattern)) return false;
    if (pattern.startsWith('.fadeno/') && (lines.includes('.fadeno') || lines.includes('.fadeno/'))) return false;
    if (pattern.startsWith('.claude/') && (lines.includes('.claude') || lines.includes('.claude/'))) return false;
    return true;
  });
  if (missing.length === 0) return;

  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const comment =
    missing[0] === '.claude/settings.local.json'
      ? '# Fadeno: per-user local Claude settings (not committed)'
      : '# Fadeno: local generated files (not committed)';
  const block = `${sep}${comment}\n${missing.join('\n')}\n`;
  writeFileSync(gitignorePath, content + block, 'utf8');
  results.push({ path: gitignorePath, status: existed ? 'appended' : 'created' });
}

function emitHooks(
  tpl: string,
  repoRoot: string,
  target: Target,
  force: boolean,
  results: EmitResult[],
): void {
  const hookFile = (srcRel: string, destRel: string, executable = false): void => {
    const content = readFileSync(join(tpl, srcRel), 'utf8');
    const dest = join(repoRoot, destRel);
    const status = emitFile(dest, content, force);
    if (executable && (status === 'created' || status === 'overwritten')) chmodSync(dest, 0o755);
    results.push({ path: dest, status });
  };

  hookFile(join('common', 'hooks', 'pre-commit'), join('.fadeno', 'hooks', 'pre-commit'), true);
  hookFile(join('common', 'hooks', 'README.md'), join('.fadeno', 'hooks', 'README.md'));
  hookFile(
    join('common', 'hooks', 'fadeno-guard.yml'),
    join('.github', 'workflows', 'fadeno-guard.yml'),
  );
  hookFile(
    join('common', 'hooks', 'fadeno-verify.yml'),
    join('.github', 'workflows', 'fadeno-verify.yml'),
  );
  if (target === 'claude') {
    hookFile(
      join('claude', 'hooks', 'settings.example.json'),
      join('.fadeno', 'hooks', 'claude-settings.example.json'),
    );
  }
}
