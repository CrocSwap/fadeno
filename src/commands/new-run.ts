import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { findRepoRoot } from '../lib/paths.ts';
import { RUN_LEDGER_SCHEMA_VERSION } from '../lib/run-ledger.ts';
import { LedgerWriter } from '../lib/run-ledger-write.ts';

export interface NewRunOptions {
  /** Playbook name (with or without `.yaml`/`.yml`). */
  playbook: string;
  task: string;
  host?: string;
  cwd?: string;
  repoRoot?: string;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface NewRunResult {
  runId: string;
  runDir: string;
  playbook: string;
}

export class NewRunError extends Error {}

/**
 * Turn arbitrary task text into a short, filesystem-safe slug, cut at a word
 * boundary so it never ends mid-word (e.g. not `…-conver`).
 */
export function slugify(text: string, maxLen = 40): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > maxLen) break;
    slug = next;
  }
  // A single leading word longer than maxLen still has to be hard-cut.
  if (!slug && words.length) slug = words[0]!.slice(0, maxLen);
  return slug || 'run';
}

function resolvePlaybook(playbooksDir: string, name: string): string {
  const stripped = name.replace(/\.(ya?ml)$/i, '');
  for (const candidate of [`${stripped}.yaml`, `${stripped}.yml`]) {
    if (existsSync(join(playbooksDir, candidate))) return stripped;
  }
  throw new NewRunError(`Playbook "${stripped}" not found in ${playbooksDir}.`);
}

/**
 * Create a new run ledger directory under `.fadeno/runs/` with a `run.yaml`,
 * an initial `run_started` event in `events.jsonl`, and an `artifacts/` dir.
 * This is the file-backed "degraded runtime" the runner skill writes into.
 */
export function runNewRun(opts: NewRunOptions): NewRunResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const fadenoDir = join(repoRoot, '.fadeno');
  if (!existsSync(fadenoDir)) {
    throw new NewRunError(
      `No .fadeno directory at ${repoRoot}. Run \`fadeno init\` first.`,
    );
  }

  const playbook = resolvePlaybook(join(fadenoDir, 'playbooks'), opts.playbook);

  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  // The run id uses LOCAL date/time so "today's run" is findable under today's
  // date; started_at below keeps the unambiguous UTC ISO timestamp.
  const pad = (n: number): string => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  const slug = slugify(opts.task);

  const runsDir = join(fadenoDir, 'runs');
  let runId = `${datePart}-${timePart}-${slug}`;
  let runDir = join(runsDir, runId);
  for (let n = 2; existsSync(runDir); n += 1) {
    runId = `${datePart}-${timePart}-${slug}-${n}`;
    runDir = join(runsDir, runId);
  }

  mkdirSync(join(runDir, 'artifacts'), { recursive: true });

  const runYaml = stringifyYaml({
    run_id: runId,
    schema_version: RUN_LEDGER_SCHEMA_VERSION,
    playbook,
    status: 'running',
    task: opts.task,
    started_at: iso,
    host: opts.host ?? 'cli',
    artifacts_dir: 'artifacts',
    current_step: null,
  });
  const modeline = '# yaml-language-server: $schema=../../schemas/run.schema.json';
  writeFileSync(join(runDir, 'run.yaml'), `${modeline}\n${runYaml}`, 'utf8');

  new LedgerWriter(runDir).append({ type: 'run_started', step: null }, now);
  writeFileSync(join(runDir, 'artifacts', '.gitkeep'), '', 'utf8');

  return { runId, runDir, playbook };
}
