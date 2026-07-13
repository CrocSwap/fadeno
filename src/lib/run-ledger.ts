import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

export class RunLedgerError extends Error {}

export interface RunSummary {
  runId: string;
  dir: string;
  playbook: string | null;
  status: string | null;
  task: string | null;
  host: string | null;
  startedAt: string | null;
  endedAt: string | null;
  problems: string[];
}

export interface RunEvent {
  type: string;
  step: string | null;
  timestamp: string | null;
  extra: Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function summarizeRunDir(runId: string, dir: string): RunSummary {
  const yamlPath = join(dir, 'run.yaml');
  const base: RunSummary = {
    runId,
    dir,
    playbook: null,
    status: null,
    task: null,
    host: null,
    startedAt: null,
    endedAt: null,
    problems: [],
  };

  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf8');
  } catch (err) {
    base.problems.push(`unreadable run.yaml: ${(err as Error).message}`);
    return base;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    base.problems.push(`unparseable run.yaml: ${(err as Error).message}`);
    return base;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    base.problems.push('unparseable run.yaml: not an object');
    return base;
  }

  const doc = parsed as Record<string, unknown>;
  base.playbook = stringOrNull(doc.playbook);
  base.status = stringOrNull(doc.status);
  base.task = stringOrNull(doc.task);
  base.host = stringOrNull(doc.host);
  base.startedAt = stringOrNull(doc.started_at);
  base.endedAt = stringOrNull(doc.ended_at);
  return base;
}

/** List run ledgers under `.fadeno/runs/`, newest first. */
export function listRuns(repoRoot: string): RunSummary[] {
  const runsDir = join(repoRoot, '.fadeno', 'runs');
  if (!existsSync(runsDir)) return [];

  const entries = readdirSync(runsDir, { withFileTypes: true });
  const runs: RunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(runsDir, entry.name);
    if (!existsSync(join(dir, 'run.yaml'))) continue;
    runs.push(summarizeRunDir(entry.name, dir));
  }

  runs.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
  return runs;
}

/** Parse `events.jsonl` without throwing on bad lines. */
export function readEvents(runDir: string): { events: RunEvent[]; badLines: number[] } {
  const path = join(runDir, 'events.jsonl');
  if (!existsSync(path)) return { events: [], badLines: [] };

  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const events: RunEvent[] = [];
  const badLines: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLines.push(lineNo);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      badLines.push(lineNo);
      continue;
    }
    const obj = parsed as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : 'unknown';
    const step = stringOrNull(obj.step);
    const timestamp = stringOrNull(obj.timestamp);
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'type' || key === 'step' || key === 'timestamp') continue;
      extra[key] = value;
    }
    events.push({ type, step, timestamp, extra });
  }

  return { events, badLines };
}

/**
 * Parse `events.jsonl`, throwing on any malformed line. Unlike `readEvents`
 * (which collects bad lines for a tolerant `show`), a prompt assembly must refuse
 * to build on a corrupt ledger so a pipeline never feeds a partial prompt onward.
 */
export function readEventsStrict(runDir: string): RunEvent[] {
  const { events, badLines } = readEvents(runDir);
  if (badLines.length > 0) {
    throw new RunLedgerError(`events.jsonl has malformed lines: ${badLines.join(', ')}`);
  }
  return events;
}

/** Resolve a run id or unique prefix under `.fadeno/runs/`. */
export function resolveRun(repoRoot: string, query: string): RunSummary {
  const runs = listRuns(repoRoot);
  const exact = runs.find((r) => r.runId === query);
  if (exact) return exact;

  const matches = runs.filter((r) => r.runId.startsWith(query));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new RunLedgerError(`No run matching "${query}" under .fadeno/runs.`);
  }

  const listed = matches
    .slice(0, 5)
    .map((r) => r.runId)
    .join(', ');
  const more = matches.length > 5 ? `, …(+${matches.length - 5} more)` : '';
  throw new RunLedgerError(`Multiple runs match "${query}": ${listed}${more}.`);
}

/** Recursive file listing under `artifacts/`, paths relative to the run dir. */
export function listArtifacts(runDir: string): { path: string; bytes: number }[] {
  const artifactsDir = join(runDir, 'artifacts');
  if (!existsSync(artifactsDir)) return [];

  const out: { path: string; bytes: number }[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push({
          path: relative(runDir, full).split('\\').join('/'),
          bytes: statSync(full).size,
        });
      }
    }
  }

  walk(artifactsDir);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
