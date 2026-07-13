import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { copyTree, emitBootstrap, emitFile, type EmitResult } from '../lib/fsutil.ts';
import { findRepoRoot, templatesDir } from '../lib/paths.ts';

export type Target = 'codex' | 'claude';

export interface InitOptions {
  target: Target;
  force?: boolean;
  /** Also scaffold tier-2 enforcement hooks (pre-commit, CI workflow, examples). */
  withHooks?: boolean;
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
  const results: EmitResult[] = [];

  // 1. Shared `.fadeno/` tree (vocabulary, playbooks, schemas, runs, enforcement).
  //    This is the per-repo "definitions" layer — always written.
  copyTree(join(tpl, 'common', 'fadeno'), join(repoRoot, '.fadeno'), force, results);

  // Steps 2–4 install the "capability" layer (skills, subagents, bootstrap).
  // --data-only skips them: a plugin user gets capability from the plugin, so
  // init only needs to seed the definitions above.
  if (!opts.dataOnly) {
    // 2. Skills — shared bodies, per-target install dir and invocation policy.
    const skillsBase =
      opts.target === 'codex'
        ? join(repoRoot, '.agents', 'skills')
        : join(repoRoot, '.claude', 'skills');

    for (const skill of SKILLS) {
      const skillSrc = join(tpl, 'common', 'skills', skill);
      const skillDest = join(skillsBase, skill);

      // Both skills are invocable: the runner fires on a described task, the
      // builder on explicit "author a playbook" intent (its description is
      // scoped to that). Codex's narrower invocation policy lives in openai.yaml
      // (below); Claude relies on the scoped description, not a frontmatter gate.
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
    if (opts.target === 'codex') {
      copyTree(join(tpl, 'codex', 'codex-agents'), join(repoRoot, '.codex', 'agents'), force, results);
    } else {
      copyTree(join(tpl, 'claude', 'claude-agents'), join(repoRoot, '.claude', 'agents'), force, results);
    }

    // 4. Bootstrap instruction file (append-or-create, never clobber).
    const bootstrapName = opts.target === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
    const bootstrapBody = readFileSync(join(tpl, opts.target, bootstrapName), 'utf8');
    emitBootstrap(join(repoRoot, bootstrapName), bootstrapBody, force, results);
  }

  // 5. Optional tier-2 enforcement scaffold (per-repo policy — allowed with --data-only).
  if (opts.withHooks) emitHooks(tpl, repoRoot, opts.target, force, results);

  // 6. Pre-approve the fadeno CLI locally so it stops prompting on every call
  //    (Claude only; written to git-ignored settings — a per-user convenience,
  //    not a trust decision committed to the shared repo). Plugins can't grant
  //    Bash permissions to themselves, so `init` is the seam for this.
  if (opts.target === 'claude') emitClaudePermissions(repoRoot, results);

  return { target: opts.target, repoRoot, results };
}

const FADENO_BASH_RULE = 'Bash(fadeno:*)';

/**
 * Merge a `Bash(fadeno:*)` allow rule into the repo's *local* Claude settings so
 * the agent isn't prompted on every `fadeno <verb>` call. Non-destructive:
 * preserves any existing rules, is idempotent, and leaves a malformed or
 * unexpectedly-shaped settings file untouched rather than clobbering it.
 */
function emitClaudePermissions(repoRoot: string, results: EmitResult[]): void {
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

  if (allow.includes(FADENO_BASH_RULE)) {
    results.push({ path: settingsPath, status: 'skipped' });
    return;
  }

  allow.push(FADENO_BASH_RULE);
  perms.allow = allow;
  data.permissions = perms;

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  results.push({ path: settingsPath, status: existed ? 'appended' : 'created' });

  ensureGitignored(repoRoot, '.claude/settings.local.json', results);
}

/** Append `pattern` to `.gitignore` (creating it if needed) unless already ignored. */
function ensureGitignored(repoRoot: string, pattern: string, results: EmitResult[]): void {
  const gitignorePath = join(repoRoot, '.gitignore');
  const existed = existsSync(gitignorePath);
  const content = existed ? readFileSync(gitignorePath, 'utf8') : '';
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(pattern) || lines.includes('.claude') || lines.includes('.claude/')) return;

  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const block = `${sep}# Fadeno: per-user local Claude settings (not committed)\n${pattern}\n`;
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
