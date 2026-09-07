import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { CATALOG_V4_DEFAULT_HARNESSES, catalogV4Doc, git, gitRepo, tempRepo } from './helpers.ts';

/**
 * The hooks, run the way a harness runs them: the template scripts copied
 * into a plugin-shaped directory (`<plugin>/hooks/*.mjs` beside
 * `<plugin>/bin/fadeno`), an event on stdin, a decision (or nothing) on
 * stdout. The bundled `fadeno` is the REAL CLI by default — a shell wrapper
 * around `src/cli.ts` — so a test exercises the hook↔CLI contract end to
 * end; a canned script replaces it where a failure mode is the point.
 */

const REPO = join(import.meta.dirname, '..');
const HOOKS_TEMPLATES = join(REPO, 'templates', 'hooks');
const CLI = join(REPO, 'src', 'cli.ts');

/** An executor that echoes its prompt back as the report. */
export const ECHO: string[] = [process.execPath, '-e', "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write('REPORT:'+d))"];

export interface HookPlugin {
  root: string;
  hooksDir: string;
  bin: string;
  data: string;
  /** Replace the bundled `fadeno` with a canned shell script body. */
  fakeCli(script: string): void;
  /** Remove the bundled `fadeno` so the hook falls back to PATH. */
  removeCli(): void;
  hostMode(sessionId: string, on: boolean): void;
  run(hook: string, event: unknown, options?: { cwd?: string; env?: Record<string, string | undefined> }): HookRun;
}

export interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Parsed stdout, or null when the hook said nothing. */
  out: Record<string, any> | null;
}

export function hookPlugin(t: TestContext): HookPlugin {
  const root = tempRepo(t);
  const hooksDir = join(root, 'hooks');
  const bin = join(root, 'bin');
  const data = join(root, 'data');
  mkdirSync(hooksDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(data, { recursive: true });
  for (const file of readdirSync(HOOKS_TEMPLATES)) copyFileSync(join(HOOKS_TEMPLATES, file), join(hooksDir, file));
  const cliPath = join(bin, 'fadeno');
  const install = (script: string) => {
    writeFileSync(cliPath, script);
    chmodSync(cliPath, 0o755);
  };
  install(`#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
  return {
    root,
    hooksDir,
    bin,
    data,
    fakeCli: install,
    removeCli: () => rmSync(cliPath, { force: true }),
    hostMode(sessionId, on) {
      const marker = join(data, 'host-mode', `${createHash('sha256').update(sessionId).digest('hex')}.enabled`);
      mkdirSync(join(data, 'host-mode'), { recursive: true });
      if (on) writeFileSync(marker, 'enabled\n');
      else rmSync(marker, { force: true });
    },
    run(hook, event, options = {}) {
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
        PLUGIN_DATA: data,
        FADENO_HOOK_TIMEOUT_MS: '8000',
        ...options.env,
      };
      delete env.FADENO_HARNESS;
      delete env.FADENO_DISPATCH_ID;
      const result = spawnSync(process.execPath, [join(hooksDir, hook)], {
        cwd: options.cwd ?? root,
        env,
        input: JSON.stringify(event),
        encoding: 'utf8',
      });
      const stdout = result.stdout ?? '';
      let out: Record<string, any> | null = null;
      if (stdout.trim() !== '') out = JSON.parse(stdout) as Record<string, any>;
      return { status: result.status, stdout, stderr: result.stderr ?? '', out };
    },
  };
}

/**
 * A repository whose catalog gives every lane something to resolve: `worker`
 * dials to `sol` on codex (a command lane from any host), `reviewer` to
 * `opus` on claude (the host lane from a Claude session), `judge` is undialed
 * (the session's own model). The codex command is the echo executor.
 */
export function hookRepo(t: TestContext, options: { command?: string[]; dials?: Record<string, string> } = {}): string {
  const root = gitRepo(t);
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const harnesses = { ...CATALOG_V4_DEFAULT_HARNESSES, codex: { provider: 'openai', host: { effort_channel: 'agent-file' }, command: options.command ?? ECHO } };
  writeFileSync(
    join(root, '.fadeno', 'executors.yaml'),
    stringifyYaml(catalogV4Doc({ harnesses, archetypes: { worker: {}, reviewer: {}, judge: {}, director: {} }, dials: options.dials ?? { worker: 'sol', reviewer: 'opus' } })),
  );
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'catalog']);
  return root;
}

/** Run the real CLI in a repo, the way a proxy or a test does. */
export function cli(root: string, args: string[], stdin = '', env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', input: stdin, env: { ...process.env, FADENO_HARNESS: 'standalone', ...env } });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

export function denial(run: HookRun): string | null {
  const out = run.out?.hookSpecificOutput;
  return out?.permissionDecision === 'deny' ? String(out.permissionDecisionReason ?? '') : null;
}
