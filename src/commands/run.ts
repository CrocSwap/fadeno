import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  buildArtifactManifest,
  ManifestError,
  type ArtifactManifestFields,
} from '../lib/artifact-manifest.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { SchemaSet } from '../lib/playbook-validate.ts';
import { readEvents } from '../lib/run-ledger.ts';
import { LedgerWriteError, LedgerWriter } from '../lib/run-ledger-write.ts';

export class RunError extends Error {}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'aborted']);
const VALID_STATUSES = new Set(['running', ...TERMINAL_STATUSES]);
const RUN_YAML_MODELINE = '# yaml-language-server: $schema=../../schemas/run.schema.json';

export interface RunOptions {
  /** Run id (under .fadeno/runs) or a path to a run directory / run.yaml. */
  run: string;
  /** Set current_step and append a `step_started` event. */
  step?: string;
  /** Set status; terminal statuses also set ended_at and append a `run_<status>` event. */
  status?: string;
  /** Append a custom event of this type. */
  event?: string;
  /** Artifact path to attach (with --event, or alone as an `artifact_created` event). */
  artifact?: string;
  /**
   * Attribute an artifact/event to a map member (role). Written as the event's
   * `member` field — the same key `fadeno prompt` uses for per-member attribution.
   */
  member?: string;
  /**
   * Extra `k=v` pairs merged onto the appended event (e.g. `branch=approve` on
   * a `human_decision`). Values that parse as JSON (numbers, booleans, null,
   * objects/arrays) are stored decoded; everything else stays a string.
   */
  fields?: string[];
  cwd?: string;
  repoRoot?: string;
  now?: Date;
}

export interface RunResult {
  runDir: string;
  appendedEvents: string[];
  updatedFields: string[];
  /** Present when this call recorded an `artifact_created` manifest. */
  manifest?: ArtifactManifestFields;
}

/** Normalize an artifact path to run-dir-relative form; reject escapes. */
function normalizeArtifactPath(runDir: string, artifactArg: string): string {
  const rel = isAbsolute(artifactArg) ? relative(runDir, artifactArg) : artifactArg;
  const normalized = rel.split('\\').join('/');
  if (normalized.startsWith('..')) {
    throw new RunError(
      `artifact path ${artifactArg} escapes the run directory; record paths under the run (e.g. artifacts/...).`,
    );
  }
  return normalized;
}

function resolveRunDir(repoRoot: string, cwd: string, run: string): string {
  const candidates = isAbsolute(run)
    ? [run]
    : [join(repoRoot, '.fadeno', 'runs', run), resolve(cwd, run)];
  for (const candidate of candidates) {
    const dir = candidate.endsWith('run.yaml') ? candidate.slice(0, -'run.yaml'.length) : candidate;
    if (existsSync(join(dir, 'run.yaml'))) return dir;
  }
  throw new RunError(`No run found for "${run}" (looked for run.yaml under .fadeno/runs).`);
}

/** Parse a `--field k=v` value; JSON-decode when unambiguous, else keep string. */
function parseFieldValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function parseFields(fields: string[] | undefined): Record<string, unknown> {
  if (!fields || fields.length === 0) return {};
  const out: Record<string, unknown> = {};
  for (const entry of fields) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new RunError(`Invalid --field "${entry}"; expected k=v (e.g. branch=approve).`);
    }
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1);
    if (!key) {
      throw new RunError(`Invalid --field "${entry}"; expected k=v (e.g. branch=approve).`);
    }
    out[key] = parseFieldValue(value);
  }
  return out;
}

/**
 * Update a run ledger: set `current_step`/`status` in run.yaml and append
 * lifecycle events to events.jsonl. This keeps the agent (or a script) from
 * hand-editing JSONL.
 */
export function runRun(opts: RunOptions): RunResult {
  const extraFields = parseFields(opts.fields);
  const hasAttribution = opts.member != null || Object.keys(extraFields).length > 0;
  if (!opts.step && !opts.status && !opts.event && !opts.artifact && !hasAttribution) {
    throw new RunError('Nothing to do: pass --step, --status, --event, and/or --artifact.');
  }
  if (hasAttribution && !opts.event && !opts.artifact && !opts.step && !opts.status) {
    throw new RunError('--member / --field require an event to attach to (--event and/or --artifact).');
  }

  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const runDir = resolveRunDir(repoRoot, cwd, opts.run);
  const runYamlPath = join(runDir, 'run.yaml');

  // The version gate: refuses legacy or unknown-format ledgers before any
  // mutation, so a pre-0.2 ledger can never become mixed-format.
  let writer: LedgerWriter;
  try {
    writer = new LedgerWriter(runDir);
  } catch (err) {
    if (err instanceof LedgerWriteError) throw new RunError(err.message);
    throw err;
  }

  const run = parseYaml(readFileSync(runYamlPath, 'utf8')) as Record<string, unknown>;
  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  const appendedEvents: string[] = [];
  const updatedFields: string[] = [];

  const appendEvent = (event: Record<string, unknown>): void => {
    writer.append(event, now);
    appendedEvents.push(event.type as string);
  };

  const buildManifestFor = (artifactArg: string): ArtifactManifestFields => {
    const rel = normalizeArtifactPath(runDir, artifactArg);
    const schemasDir = join(repoRoot, '.fadeno', 'schemas');
    const schemas = existsSync(schemasDir) ? new SchemaSet(schemasDir) : null;
    let fields: ArtifactManifestFields;
    try {
      fields = buildArtifactManifest(runDir, rel, `artifact-${writer.nextSeq}`, schemas);
    } catch (err) {
      if (err instanceof ManifestError) throw new RunError(err.message);
      throw err;
    }
    // Artifacts are immutable: re-recording a path must carry the same bytes.
    const { events: priorEvents } = readEvents(runDir);
    for (const prior of priorEvents) {
      if (prior.type !== 'artifact_created' || prior.extra.artifact !== fields.artifact) continue;
      if (typeof prior.extra.sha256 === 'string' && prior.extra.sha256 !== fields.sha256) {
        throw new RunError(
          `${fields.artifact} was already recorded with a different sha256; artifacts are ` +
            'immutable — write a new generation (.v<G>) instead.',
        );
      }
    }
    return fields;
  };

  if (opts.step) {
    run.current_step = opts.step;
    updatedFields.push('current_step');
    appendEvent({ type: 'step_started', step: opts.step });
  }

  // Attribute the event to the step in progress: an explicit --step wins,
  // otherwise fall back to the run's current_step so artifacts/events aren't
  // logged with a null step. (Run-level events like run_completed stay null.)
  const eventStep = opts.step ?? ((run.current_step as string | null | undefined) ?? null);

  const attachAttribution = (event: Record<string, unknown>): void => {
    if (opts.member != null) event.member = opts.member;
    for (const [key, value] of Object.entries(extraFields)) {
      event[key] = value;
    }
  };

  let manifest: ArtifactManifestFields | undefined;

  if (opts.event) {
    const event: Record<string, unknown> = { type: opts.event, step: eventStep };
    if (opts.event === 'artifact_created') {
      if (!opts.artifact) {
        throw new RunError('An artifact_created event requires --artifact <path>.');
      }
      manifest = buildManifestFor(opts.artifact);
      // Attribution first, manifest last: measured fields (sha256, bytes, …)
      // are authoritative and must never be overridden by a --field value.
      attachAttribution(event);
      Object.assign(event, manifest);
    } else {
      if (opts.artifact) {
        // A non-manifest event merely references an artifact; no existence
        // requirement and no digest, by design.
        event.artifact = opts.artifact;
      }
      attachAttribution(event);
    }
    appendEvent(event);
  } else if (opts.artifact) {
    manifest = buildManifestFor(opts.artifact);
    const event: Record<string, unknown> = { type: 'artifact_created', step: eventStep };
    attachAttribution(event);
    Object.assign(event, manifest);
    appendEvent(event);
  } else if (hasAttribution) {
    // Attribution alone is invalid (caught above); status-only with fields is also invalid.
    throw new RunError('--member / --field require an event to attach to (--event and/or --artifact).');
  }

  if (opts.status) {
    if (!VALID_STATUSES.has(opts.status)) {
      throw new RunError(
        `Invalid status "${opts.status}". Use one of: ${[...VALID_STATUSES].join(', ')}.`,
      );
    }
    run.status = opts.status;
    updatedFields.push('status');
    if (TERMINAL_STATUSES.has(opts.status)) {
      run.ended_at = iso;
      updatedFields.push('ended_at');
      run.current_step = null;
      appendEvent({ type: `run_${opts.status}`, step: null });
    }
  }

  writeFileSync(runYamlPath, `${RUN_YAML_MODELINE}\n${stringifyYaml(run)}`, 'utf8');
  return { runDir, appendedEvents, updatedFields, manifest };
}
