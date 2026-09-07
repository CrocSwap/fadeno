// Fadeno's spawn wrapper on omp (spec §04). omp calls this extension's
// `tool_call` hook before running the native `task` tool, and a replacement
// input is honoured; that is the whole channel, and it is enough:
//
//   - a task whose agent names an archetype is opened through `fadeno
//     dispatch-open`, which resolves the dial, cuts the worktree, writes the
//     opened row and returns the contract-bearing prompt — the task's text is
//     replaced with that prompt;
//   - when the archetype resolves to a model that runs as a process, the task
//     is retargeted to the `dispatch` proxy, whose prompt is the one `fadeno
//     dispatch` command that runs the staged task;
//   - when Fadeno refuses (the unclosed limit, a resolver error), the task's
//     text becomes the refusal and nothing else, so the agent reports it and
//     stops rather than doing unrecorded work.
//
// omp's host lane delivers the session's own identity and nothing else
// (`identity: session` in the catalog), so no model is ever set here. The
// extension writes nothing; the CLI writes the ledger.

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const CANON_ARCHETYPES = new Set(['director', 'judge', 'reviewer', 'scout', 'worker']);
const PROXY_AGENT = 'dispatch';
const CLI_TIMEOUT_MS = 20_000;
const REPORT_REFUSAL = 'Report this refusal to the user instead of routing around it.';
const BUNDLED_CLI = join(import.meta.dirname, '..', 'bin', 'fadeno');

// Task agents' bash calls inherit the omp process environment. Export the
// plugin's bundled CLI once so the proxy runs the same build this extension
// resolved through, without relying on PATH.
if (!process.env.FADENO_CLI?.trim() && existsSync(BUNDLED_CLI)) process.env.FADENO_CLI = BUNDLED_CLI;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

type Run = { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> | null; failure: string | null };

function runFadeno(args: string[], cwd: string, input: string): Promise<Run> {
  const cli = process.env.FADENO_CLI?.trim() || 'fadeno';
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const done = (run: Run) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, args, { cwd, env: { ...process.env, FADENO_HARNESS: 'omp' }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      done({ status: null, stdout: '', stderr: String(err), json: null, failure: 'error' });
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (err: NodeJS.ErrnoException) => done({ status: null, stdout, stderr: stderr || err.message, json: null, failure: err.code === 'ENOENT' ? 'missing' : 'error' }));
    child.on('close', (status) => {
      let json: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(stdout) as unknown;
        if (parsed != null && typeof parsed === 'object') json = parsed as Record<string, unknown>;
      } catch {
        // not JSON
      }
      done({ status, stdout, stderr: stderr.trim(), json, failure: null });
    });
    const timer = setTimeout(() => {
      child.kill();
      done({ status: null, stdout, stderr, json: null, failure: 'timeout' });
    }, CLI_TIMEOUT_MS);
    child.stdin?.on('error', () => { /* the exit says why */ });
    child.stdin?.end(input);
  });
}

function refusal(reason: string): string {
  const trimmed = reason.trimEnd();
  return `# Fadeno refused this spawn\n\n${trimmed}${/[.!?…]$/.test(trimmed) ? '' : '.'} ${REPORT_REFUSAL}\n\nDo not perform the task; report the refusal above verbatim and stop.`;
}

function failureText(run: Run): string {
  if (run.failure === 'timeout') return `fadeno dispatch-open did not answer within ${CLI_TIMEOUT_MS}ms.`;
  if (run.failure === 'missing') return 'fadeno dispatch-open could not be started: the fadeno CLI was not found.';
  if (run.failure != null) return `fadeno dispatch-open could not be started: ${run.stderr}`;
  return run.stderr || `fadeno dispatch-open exited ${run.status} with no explanation.`;
}

function proxyPrompt(relay: { command: string }, detail: string): string {
  const command = relay.command.replace(/^fadeno /, 'FADENO_HARNESS=omp "${FADENO_CLI:-fadeno}" ');
  return [
    'Run this command exactly once, with a 600-second bash timeout, and relay its stdout verbatim as your final message:',
    '',
    '```bash',
    command,
    '```',
    '',
    `It dispatches ${detail}. The prompt is already in the file the command names; do not read it, describe it, or write any file.`,
    'If the command exits non-zero, relay its stdout and stderr and say the dispatch failed; do not attempt the task yourself.',
    'If the bash call is killed or times out, the executor may still be running: report that, and recover the report with `FADENO_CLI... dispatches --output <name>` using the `--name` above.',
    'Report only what the command printed. Nothing else is yours to claim.',
  ].join('\n');
}

/** The agent name the task should land on: a project-local agent of that name shadows the plugin's. */
function agentName(bare: string, cwd: string): string {
  return existsSync(join(cwd, '.omp', 'agents', `${bare}.md`)) ? bare : bare;
}

async function wrapOne(item: Record<string, unknown>, cwd: string): Promise<Record<string, unknown> | null> {
  const agent = text(item.agent);
  const bare = agent?.split(':').at(-1) ?? null;
  if (bare == null || !CANON_ARCHETYPES.has(bare)) return null;
  const task = typeof item.task === 'string' ? item.task : '';
  const args = ['dispatch-open', '--archetype', bare, '--json', '--harness', 'omp'];
  const name = text(item.name)?.trim();
  if (name) args.push('--name', name.slice(0, 60));
  const run = await runFadeno(args, cwd, task);
  if (run.failure != null || run.status !== 0) {
    const reason = run.status === 3 ? text(run.json?.refused) ?? run.stderr : failureText(run);
    return { ...item, task: refusal(reason ?? 'fadeno refused the spawn') };
  }
  const answer = run.json;
  if (answer == null || answer.ok !== true) return { ...item, task: refusal(`fadeno dispatch-open exited 0 without a readable answer (${run.stdout.trim().slice(0, 200) || 'empty stdout'}).`) };
  if (answer.opened === true) return { ...item, agent: agentName(bare, cwd), task: String(answer.prompt) };
  const relay = answer.relay as { command: string };
  const identity = `${String(answer.model)}${answer.effort ? `@${String(answer.effort)}` : ''} on ${String(answer.harness ?? '?')}`;
  return { ...item, agent: agentName(PROXY_AGENT, cwd), task: proxyPrompt(relay, `the ${bare} task as ${identity}`) };
}

async function wrap(input: Record<string, unknown>, cwd: string): Promise<Record<string, unknown> | null> {
  if (typeof input.agent === 'string') {
    const wrapped = await wrapOne(input, cwd);
    return wrapped == null ? null : { ...input, ...wrapped };
  }
  if (!Array.isArray(input.tasks)) return null;
  let changed = false;
  const tasks: unknown[] = [];
  for (const raw of input.tasks) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      tasks.push(raw);
      continue;
    }
    const wrapped = await wrapOne(raw as Record<string, unknown>, cwd);
    if (wrapped == null) {
      tasks.push(raw);
      continue;
    }
    changed = true;
    tasks.push(wrapped);
  }
  return changed ? { ...input, tasks } : null;
}

export default function fadeno(pi: { on: (event: string, handler: (event: any, ctx: any) => any) => void }) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'task' || event.input == null || typeof event.input !== 'object') return;
    const input = await wrap(event.input, ctx?.cwd ?? process.cwd());
    return input == null ? undefined : { input };
  });
}
