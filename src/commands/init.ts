import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const SKILLS = ['fadeno-runner', 'fadeno-builder'] as const;

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

  return { target: opts.target, repoRoot, results };
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
  if (target === 'claude') {
    hookFile(
      join('claude', 'hooks', 'settings.example.json'),
      join('.fadeno', 'hooks', 'claude-settings.example.json'),
    );
  }
}
