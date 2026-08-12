import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { buildArtifactManifest, sha256Hex } from '../lib/artifact-manifest.ts';
import {
  ExecutorProfileError,
  applicableOverrides,
  loadExecutorProfile,
  readLocalLoadoutState,
  readUserLoadout,
  resolveActiveLoadout,
  resolveRole,
  roleResolutionEchoLabel,
  type ActiveLoadout,
  type ExecutorProfile,
  type RoleResolutionSource,
} from '../lib/executors.ts';
import { resolveDefinition, resolvePlaybookFile } from '../lib/definitions.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { roleArchetype } from '../lib/playbook-validate.ts';
import { RUN_LEDGER_SCHEMA_VERSION } from '../lib/run-ledger.ts';
import { LedgerWriter } from '../lib/run-ledger-write.ts';
import { ensureFadenoIgnore } from '../lib/source-control.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';

export interface NewRunOptions {
  /** Playbook name (with or without `.yaml`/`.yml`). */
  playbook: string;
  task: string;
  host?: string;
  /** Repeated `Name=path` declarations supplied for the playbook's inputs. */
  inputs?: string[];
  /** Singular alias for argv-like callers. */
  input?: string[];
  /** `--loadout` override for the resolution preview. */
  loadout?: string;
  /**
   * `FADENO_LOADOUT` value; injectable for hermetic tests. `undefined` reads
   * the real environment; `null` means explicitly absent.
   */
  env?: string | null;
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export interface NewRunRoleResolution {
  role: string;
  archetype: string | null;
  executor: string | null;
  model: string | null;
  source: RoleResolutionSource | null;
  /** The kernel's actionable message when nothing serves the role. */
  error: string | null;
}

export interface NewRunResolution {
  loadout: ActiveLoadout | null;
  roles: NewRunRoleResolution[];
  /** Rendering-ready echo lines (`role → executor (model) [source]`). */
  echo: string[];
}

export interface NewRunResult {
  runId: string;
  runDir: string;
  playbook: string;
  inputs: string[];
  /**
   * Dispatch-resolution preview for the run-start echo, or null when the repo
   * has no usable executor profile. Advisory: `fadeno drive` recomputes and
   * records the authoritative resolution at dispatch time.
   */
  resolution: NewRunResolution | null;
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
 * Best-effort dispatch-resolution preview for the run-start echo. Run creation
 * never dispatches, so executor-profile problems (missing/invalid profile, an
 * unknown loadout name in the environment) yield null here instead of failing
 * the run — `fadeno drive` raises them loudly at dispatch time. Read-only: no
 * ledger event is written; the durable `resolution_snapshot` belongs to the
 * engine, which computes resolution at dispatch time.
 */
function computeResolution(
  repoRoot: string,
  playbookPath: string,
  flagValue: string | null,
  envRaw: string | null | undefined,
  userPathOptions?: UserPathOptions,
): NewRunResolution | null {
  let profile: ExecutorProfile;
  try {
    profile = loadExecutorProfile(repoRoot, userPathOptions).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) return null;
    throw err;
  }
  let active: ActiveLoadout | null;
  // Name-matched overlay only: the preview shows what `fadeno drive` will
  // resolve, and drive scopes overrides to the loadout that actually won. An
  // unreadable pin stays best-effort here, like every other profile problem.
  let overrides: Record<string, string>;
  try {
    const pin = readLocalLoadoutState(repoRoot);
    active = resolveActiveLoadout({
      flagValue,
      envValue: envRaw !== undefined ? envRaw : process.env.FADENO_LOADOUT ?? null,
      localFileValue: pin.loadout,
      userFileValue: readUserLoadout(userPathOptions),
      profile,
    });
    overrides = applicableOverrides(pin, active);
  } catch (err) {
    if (err instanceof ExecutorProfileError) return null;
    throw err;
  }
  let playbookDoc: unknown;
  try {
    playbookDoc = parseYaml(readFileSync(playbookPath, 'utf8'));
  } catch {
    return null;
  }
  const rolesRaw =
    playbookDoc != null && typeof playbookDoc === 'object' && !Array.isArray(playbookDoc)
      ? (playbookDoc as Record<string, unknown>).roles
      : null;
  const roleNames =
    rolesRaw != null && typeof rolesRaw === 'object' && !Array.isArray(rolesRaw)
      ? Object.keys(rolesRaw)
      : [];

  const roles: NewRunRoleResolution[] = [];
  const echo: string[] = [];
  for (const role of roleNames) {
    const archetype = roleArchetype(playbookDoc, role);
    try {
      const resolved = resolveRole(role, archetype, profile, active?.name ?? null, overrides);
      const model = resolved.executor.model;
      roles.push({ role, archetype, executor: resolved.executorName, model, source: resolved.source, error: null });
      const label = roleResolutionEchoLabel(resolved.source, active?.name ?? null);
      echo.push(`${role} → ${resolved.executorName}${model != null ? ` (${model})` : ''} [${label}]`);
    } catch (err) {
      if (!(err instanceof ExecutorProfileError)) throw err;
      roles.push({ role, archetype, executor: null, model: null, source: null, error: err.message });
      echo.push(`${role} → (unresolved)`);
    }
  }
  return { loadout: active, roles, echo };
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
  ensureFadenoIgnore(repoRoot);
  const resolved = resolvePlaybookFile(repoRoot, opts.playbook);
  if (resolved == null) {
    throw new NewRunError(`Playbook "${opts.playbook.replace(/\.ya?ml$/i, '')}" not found in bundled or project definitions.`);
  }
  const playbook = opts.playbook.replace(/\.ya?ml$/i, '');
  const playbookPath = resolved.path;
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
  const definitionsDir = join(runDir, 'definitions');
  const snapshotPlaybook = join(definitionsDir, 'playbook.yaml');
  mkdirSync(join(definitionsDir, 'schemas'), { recursive: true });
  copyFileSync(playbookPath, snapshotPlaybook);
  for (const schemaName of ['playbook.schema.json', 'run.schema.json', 'review-report.schema.json', 'test-result.schema.json']) {
    const schema = resolveDefinition(repoRoot, 'schema', schemaName);
    if (schema != null) copyFileSync(schema.path, join(definitionsDir, 'schemas', schemaName));
  }
  const playbookSha256 = sha256Hex(readFileSync(snapshotPlaybook));

  const runDocument: Record<string, unknown> = {
    run_id: runId,
    schema_version: RUN_LEDGER_SCHEMA_VERSION,
    playbook,
    playbook_snapshot: 'definitions/playbook.yaml',
    playbook_sha256: playbookSha256,
    status: 'running',
    task: opts.task,
    started_at: iso,
    host: opts.host ?? 'cli',
    artifacts_dir: 'artifacts',
    current_step: null,
  };
  // Persist only an explicit creation-time selection. Ambient state remains
  // ambient for old scripts; drive gives this intent precedence when present.
  if (opts.loadout != null && opts.loadout.trim() !== '') runDocument.requested_loadout = opts.loadout.trim();
  const runYaml = stringifyYaml(runDocument);
  const modeline = '# yaml-language-server: $schema=definitions/schemas/run.schema.json';
  writeFileSync(join(runDir, 'run.yaml'), `${modeline}\n${runYaml}`, 'utf8');

  new LedgerWriter(runDir).append({ type: 'run_started', step: null }, now);
  writeFileSync(join(runDir, 'artifacts', '.gitkeep'), '', 'utf8');
  const recordedInputs = recordDeclaredInputs(runDir, repoRoot, declared, supplied, now);
  const resolution = computeResolution(repoRoot, playbookPath, opts.loadout ?? null, opts.env, opts.userPathOptions);

  return { runId, runDir, playbook, inputs: recordedInputs, resolution };
}
