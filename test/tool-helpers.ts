import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { TestContext } from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { INFLIGHT_DIR } from '../src/lib/supervisor.ts';
import { tempRepo } from './helpers.ts';

/**
 * Shared fixtures for the tool-execution suites.
 *
 * `SOURCE_CLI` is the CLI under test: `npm test` has no build step, so pointing
 * a behavioural test at `dist/` would let a stale build silently green it. The
 * bundled binary is exercised on purpose, and only where CJS/ESM parity is the
 * thing being proven.
 */
export const SOURCE_CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
export const BUNDLED_CLI = join(import.meta.dirname, '..', 'plugin', 'bin', 'fadeno');

export interface ToolRepo {
  root: string;
  runId: string;
  runDir: string;
}

/** A registered `tool_call` step producing the planned TestResult. */
export const TOOL_STEP = { id: 'test', kind: 'tool_call', tool: 'test_runner', output: 'TestResult' };

/** Tool step → deterministic gate → terminal branches. */
export function gatedFlow(): unknown[] {
  return [
    TOOL_STEP,
    { id: 'gate', kind: 'gate', condition: 'tests_pass', input: ['TestResult'], on_pass: 'done', on_fail: 'fail' },
    { id: 'done', kind: 'human_gate', prompt: 'done', terminal_status: 'completed' },
    { id: 'fail', kind: 'human_gate', prompt: 'fail', terminal_status: 'failed' },
  ];
}

/** Loop whose body is the tool step, bounded at `maxIterations`. */
export function loopFlow(maxIterations: number): unknown[] {
  return [
    { id: 'loop', kind: 'loop', body: ['test'], max_iterations: maxIterations, until: 'tests_pass', input: ['TestResult'], on_success: 'done', on_exhausted: 'done' },
    TOOL_STEP,
    { id: 'done', kind: 'human_gate', prompt: 'done', terminal_status: 'completed' },
  ];
}

/** A throwaway repo with a tool registry, a playbook, and a fresh run. */
export function seedToolRepo(t: TestContext, tools: Record<string, unknown>, flow: unknown[] = [TOOL_STEP]): ToolRepo {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const executorsPath = join(root, '.fadeno', 'executors.yaml');
  const executors = parseYaml(readFileSync(executorsPath, 'utf8')) as Record<string, unknown>;
  executors.tools = tools;
  writeFileSync(executorsPath, stringifyYaml(executors));
  const playbook = {
    kind: 'AgentPlaybook',
    schema_version: '0.1',
    name: 'tool-test',
    description: 'tool test',
    roles: { worker: { purpose: 'test worker' } },
    flow,
  };
  writeFileSync(join(root, '.fadeno', 'playbooks', 'tool-test.yaml'), stringifyYaml(playbook));
  const { runId, runDir } = runNewRun({ repoRoot: root, playbook: 'tool-test', task: 'test' });
  return { root, runId, runDir };
}

/** A command that always exits with `code`. */
export function exitsWith(code: number): string[] {
  return ['node', '-e', `process.exit(${code})`];
}

export function readJson(dir: string, rel: string): any {
  return JSON.parse(readFileSync(join(dir, rel), 'utf8'));
}

export function inflightClaimPath(repoRoot: string, runId: string, toolCallId: string, attempt: number): string {
  return join(repoRoot, ...INFLIGHT_DIR.split('/'), `tool-${runId}-${toolCallId}-a${attempt}.json`);
}

export function runSourceCli(args: string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [SOURCE_CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function startSourceCli(args: string[], cwd?: string): ChildProcess {
  return spawn('node', [SOURCE_CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function collect(child: ChildProcess): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Poll until `predicate` holds, or throw naming what never happened. */
export async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** True when a pid (or, negated, a process group) no longer exists. */
export function isEsrch(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function readClaim(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
