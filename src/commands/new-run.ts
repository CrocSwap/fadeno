import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildArtifactManifest } from '../lib/artifact-manifest.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { RUN_LEDGER_SCHEMA_VERSION } from '../lib/run-ledger.ts';
import { LedgerWriter } from '../lib/run-ledger-write.ts';

export interface NewRunOptions {
  /** Playbook name (with or without `.yaml`/`.yml`). */
  playbook: string;
  task: string;
  host?: string;
  /** Repeated `Name=path` declarations supplied for the playbook's inputs. */
  inputs?: string[];
  /** Singular alias for argv-like callers. */
  input?: string[];
  cwd?: string;
  repoRoot?: string;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface NewRunResult {
  runId: string;
  runDir: string;
  playbook: string;
  inputs: string[];
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

interface DeclaredInput { mediaType: string }

function readDeclaredInputs(playbookPath: string): Record<string, DeclaredInput> {
  const parsed = parseYaml(readFileSync(playbookPath, 'utf8')) as { inputs?: unknown };
  if (parsed?.inputs == null) return {};
  if (typeof parsed.inputs !== 'object' || Array.isArray(parsed.inputs)) {
    throw new NewRunError('playbook inputs must be a mapping of logical name to media_type.');
  }
  const result: Record<string, DeclaredInput> = {};
  for (const [name, raw] of Object.entries(parsed.inputs as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      throw new NewRunError(`declared input "${name}" is not a safe logical name.`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new NewRunError(`declared input "${name}" must be a mapping with media_type.`);
    }
    const mediaType = (raw as Record<string, unknown>).media_type;
    if (typeof mediaType !== 'string' || mediaType.length === 0) {
      throw new NewRunError(`declared input "${name}" needs a non-empty media_type.`);
    }
    result[name] = { mediaType };
  }
  return result;
}

function parseInputArgs(values: string[] | undefined): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const value of values ?? []) {
    const eq = value.indexOf('=');
    if (eq <= 0 || eq === value.length - 1) {
      throw new NewRunError(`Invalid --input "${value}"; expected Name=path.`);
    }
    const name = value.slice(0, eq).trim();
    const path = value.slice(eq + 1).trim();
    if (!name || !path) throw new NewRunError(`Invalid --input "${value}"; expected Name=path.`);
    if (parsed.has(name)) throw new NewRunError(`duplicate run input "${name}".`);
    parsed.set(name, path);
  }
  return parsed;
}

function validateInputSources(repoRoot: string, declared: Record<string, DeclaredInput>, supplied: Map<string, string>): void {
  const realRepoRoot = realpathSync(repoRoot);
  for (const name of supplied.keys()) {
    if (!(name in declared)) throw new NewRunError(`run input "${name}" is not declared by the playbook.`);
  }
  const missing = Object.keys(declared).filter((name) => !supplied.has(name));
  if (missing.length > 0) throw new NewRunError(`missing required run input(s): ${missing.join(', ')}.`);
  for (const [name, sourceArg] of supplied) {
    const sourceAbs = isAbsolute(sourceArg) ? resolve(sourceArg) : resolve(repoRoot, sourceArg);
    const sourceRel = relative(repoRoot, sourceAbs).split('\\').join('/');
    if (sourceRel === '..' || sourceRel.startsWith('../') || isAbsolute(sourceRel)) {
      throw new NewRunError(`input "${name}" path escapes the repository: ${sourceArg}`);
    }
    if (!existsSync(sourceAbs)) throw new NewRunError(`input "${name}" source does not exist: ${sourceArg}`);
    if (!statSync(sourceAbs).isFile()) throw new NewRunError(`input "${name}" source is not a file: ${sourceArg}`);
    const realSource = realpathSync(sourceAbs);
    const realRel = relative(realRepoRoot, realSource).split('\\').join('/');
    if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) {
      throw new NewRunError(`input "${name}" path escapes the repository through a symlink: ${sourceArg}`);
    }
  }
}

function recordDeclaredInputs(
  runDir: string,
  repoRoot: string,
  declared: Record<string, DeclaredInput>,
  supplied: Map<string, string>,
  now: Date,
): string[] {
  const realRepoRoot = realpathSync(repoRoot);
  const writer = new LedgerWriter(runDir);
  const recorded: string[] = [];
  for (const name of Object.keys(declared)) {
    const sourceArg = supplied.get(name)!;
    const sourceAbs = isAbsolute(sourceArg) ? resolve(sourceArg) : resolve(repoRoot, sourceArg);
    const sourceRel = relative(repoRoot, sourceAbs).split('\\').join('/');
    if (sourceRel === '..' || sourceRel.startsWith('../') || isAbsolute(sourceRel)) {
      throw new NewRunError(`input "${name}" path escapes the repository: ${sourceArg}`);
    }
    if (!existsSync(sourceAbs)) throw new NewRunError(`input "${name}" source does not exist: ${sourceArg}`);
    if (!statSync(sourceAbs).isFile()) throw new NewRunError(`input "${name}" source is not a file: ${sourceArg}`);
    const realSource = realpathSync(sourceAbs);
    const realRel = relative(realRepoRoot, realSource).split('\\').join('/');
    if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) {
      throw new NewRunError(`input "${name}" path escapes the repository through a symlink: ${sourceArg}`);
    }
    const bytes = readFileSync(sourceAbs);
    const destination = `artifacts/inputs/${name}${extname(sourceAbs)}`;
    mkdirSync(join(runDir, 'artifacts', 'inputs'), { recursive: true });
    writeFileSync(join(runDir, destination), bytes);
    const manifest = buildArtifactManifest(runDir, destination, `input-${name}`, null);
    writer.append(
      {
        type: 'artifact_created',
        step: null,
        ...manifest,
        logical_name: name,
        input: name,
        input_name: name,
        source_filename: basename(sourceAbs),
        source_path: sourceRel,
        declared_media_type: declared[name]!.mediaType,
        media_type: declared[name]!.mediaType,
      },
      now,
    );
    recorded.push(name);
  }
  return recorded;
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

  const playbooksDir = join(fadenoDir, 'playbooks');
  const playbook = resolvePlaybook(playbooksDir, opts.playbook);
  const playbookPath = existsSync(join(playbooksDir, `${playbook}.yaml`))
    ? join(playbooksDir, `${playbook}.yaml`)
    : join(playbooksDir, `${playbook}.yml`);
  const declared = readDeclaredInputs(playbookPath);
  const supplied = parseInputArgs(opts.inputs ?? opts.input);
  validateInputSources(repoRoot, declared, supplied);

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
  const recordedInputs = recordDeclaredInputs(runDir, repoRoot, declared, supplied, now);

  return { runId, runDir, playbook, inputs: recordedInputs };
}
