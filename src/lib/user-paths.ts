import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
// One-directional at runtime: `executors.ts` imports only TYPES from this
// module, so there is no cycle to break. The dial-ref grammar lives there, and
// a second copy here is exactly how a user dial would start reading
// differently from a catalog dial.
import { formatDialRef, legacyDriverHarness, parseDialRef, type DialRef } from './executors.ts';

/** Inputs used to resolve Fadeno's user-level configuration locations. */
export interface UserPathOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface FadenoUserPaths {
  configHome: string;
  stateHome: string;
  dataHome: string;
  configDir: string;
  stateDir: string;
  dataDir: string;
  executorsFile: string;
  configFile: string;
  /** Directory `fadeno setup` links the CLI into; expected to be on PATH. */
  binDir: string;
  /** The link itself: `<binDir>/fadeno`. */
  linkPath: string;
  dialsFile: string;
  modelVerificationsFile: string;
}

/**
 * Resolve platform-aware user paths without creating anything. The injectable
 * inputs keep commands hermetic and make the precedence rules testable.
 */
export function userPaths(options: UserPathOptions = {}): FadenoUserPaths {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const os = options.platform ?? platform();
  const windows = os === 'win32';
  const configHome = env.FADENO_CONFIG_HOME ??
    (windows ? env.APPDATA : env.XDG_CONFIG_HOME) ??
    join(home, windows ? 'AppData' : '.config');
  const stateHome = env.FADENO_STATE_HOME ??
    (windows ? env.LOCALAPPDATA : env.XDG_STATE_HOME) ??
    (windows ? join(home, 'AppData', 'Local') : join(home, '.local', 'state'));
  const dataHome = env.FADENO_DATA_HOME ??
    (windows ? env.LOCALAPPDATA : env.XDG_DATA_HOME) ??
    (windows ? join(home, 'AppData', 'Local') : join(home, '.local', 'share'));
  const configDir = join(configHome, 'fadeno');
  const stateDir = join(stateHome, 'fadeno');
  const dataDir = join(dataHome, 'fadeno');
  // `~/.local/bin` is where a user-scoped executable belongs on macOS and
  // Linux, and is on PATH in most shells; `setup` says so when it is not.
  // Windows has no such convention, so Fadeno keeps its own directory and
  // tells the user to add it.
  const binDir = env.FADENO_BIN_DIR?.trim() || (windows ? join(dataDir, 'bin') : join(home, '.local', 'bin'));
  return {
    configHome,
    stateHome,
    dataHome,
    configDir,
    stateDir,
    dataDir,
    executorsFile: join(configDir, 'executors.yaml'),
    configFile: join(configDir, 'config.yaml'),
    binDir,
    linkPath: join(binDir, windows ? 'fadeno.cmd' : 'fadeno'),
    dialsFile: join(stateDir, 'dials.json'),
    modelVerificationsFile: join(stateDir, 'model-verifications.json'),
  };
}

/** The harnesses Fadeno *installs into* — the ones `setup`/`uninstall` manage. */
export type FadenoHarness = 'codex' | 'claude';

/**
 * State files Fadeno used to write and no longer reads, listed here only so
 * `setup` and `uninstall` can delete a leftover.
 *
 * `harness` recorded "the harness you last set up" and `activeHarness` used to
 * consult it. It is gone on purpose: people swap harnesses constantly, so a
 * remembered one is a guess dressed as a fact — a bare shell is `standalone`,
 * and a host is only a host when the session is actually inside it (see
 * `activeHarness` in `src/lib/executors.ts`). `loadout` is older still: named
 * loadouts retired in 0.6 and nothing has read it since.
 *
 * A file nothing consults is a lie on disk waiting to be believed, so removing
 * the readers is only half the change — the bytes have to go too.
 */
export function retiredStateFiles(paths: FadenoUserPaths): string[] {
  return [
    join(paths.stateDir, 'harness'),
    join(paths.stateDir, 'loadout'),
    // The installation manifest: it recorded which files a managed-runtime
    // COPY had installed and at what version. `setup` links now, so there is
    // no copy to reconcile and nothing left to record.
    join(paths.stateDir, 'installations.json'),
  ];
}

/**
 * Directories in the same category — swept whole, for the same reason.
 *
 * `<data>/fadeno/runtime` held a byte-for-byte copy of the CLI that a version
 * comparison kept in step with the plugin's. The copy is gone; a stale one
 * left on disk is a second Fadeno someone's PATH could still find.
 */
export function retiredStateDirs(paths: FadenoUserPaths): string[] {
  return [join(paths.dataDir, 'runtime')];
}

// --- atomic writes ---

/**
 * Write `text` to `path` by rename.
 *
 * Every file under here is read by a concurrent process — a spawn hook
 * resolving dials while `fadeno dial` writes them is the normal case, not the
 * exception. A plain `writeFileSync` truncates in place, so a reader can
 * observe an empty prefix and conclude "no dials", which is a wrong answer
 * that looks exactly like a right one.
 */
function writeUserFileAtomic(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

// --- dials file ---

/**
 * Schema version `writeUserDials` stamps. v1 is `{schema_version, dials}`;
 * v0 — the unstamped flat `{archetype: ref}` map every Fadeno up to 0.6.1
 * wrote — stays readable forever. `PERSISTED_SURFACES` in
 * `src/lib/persisted-state.ts` reads this constant rather than restating it.
 */
export const DIALS_SCHEMA_VERSION = 1;

/** Thrown when a user dial file carries a key the dial vocabulary no longer
 * has. Its own class so a caller can tell a stale personal config from an
 * unreadable one — an unreadable dials file degrades to `{}` on purpose, and a
 * removed-key file must NOT. */
export class UserDialsError extends Error {}

/**
 * The dial map inside a dials document, whichever version wrote it.
 *
 * Version 0 IS the document: the flat map. Version 1 nests it under `dials`.
 * A stamp is only believed when it is a number, so a v0 file that happens to
 * hold an archetype literally named `schema_version` (a legal bare identifier,
 * whose value would be a dial-ref STRING) still reads as v0.
 */
function unwrapUserDials(doc: Record<string, unknown>, path: string): { map: Record<string, unknown>; problem: string | null } {
  const stamp = doc.schema_version;
  if (typeof stamp !== 'number') return { map: doc, problem: null };
  if (stamp > DIALS_SCHEMA_VERSION) {
    // Knowable and actionable, so it is said out loud. Degrading to `{}` here
    // would silently drop every dial the user set with a newer Fadeno.
    throw new UserDialsError(
      `user dials at ${path} are schema_version ${stamp}; this fadeno reads ${DIALS_SCHEMA_VERSION}. ` +
        'Upgrade fadeno, or move the file aside and re-set your dials with `fadeno dial`.',
    );
  }
  const nested = doc.dials;
  if (nested == null || typeof nested !== 'object' || Array.isArray(nested)) {
    return {
      map: {},
      problem: `carries schema_version ${stamp} but no \`dials\` mapping, so it yields no dials at all`,
    };
  }
  return { map: nested as Record<string, unknown>, problem: null };
}

/**
 * Everything one dials document says, INCLUDING what the reader had to
 * discard.
 *
 * `readUserDials` returns only `dials` — degrading a malformed entry to
 * "absent" is the right runtime behaviour, because a personal config must not
 * be able to take out every command. But "the reader silently discarded this"
 * is exactly what `fadeno doctor` has to be able to say, so the two live in
 * ONE function and differ only in which half of its result they use. A second
 * copy of the shape rules, written for the audit, would drift the same day
 * someone changed the reader.
 */
interface UserDialsReading {
  dials: Record<string, { model: string; effort?: string; harness?: string }>;
  /** What the reader could not use, in document order. */
  problems: string[];
  /** The first problem the reader must THROW on rather than skip past. */
  fatal: string | null;
}

function interpretUserDials(doc: Record<string, unknown>, path: string): UserDialsReading {
  const unwrapped = unwrapUserDials(doc, path);
  const problems: string[] = unwrapped.problem != null ? [unwrapped.problem] : [];
  let fatal: string | null = null;
  const out: Record<string, { model: string; effort?: string; harness?: string }> = {};
  for (const [k, v] of Object.entries(unwrapped.map)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length === 0) {
        problems.push(`dial "${k}" is an empty string`);
        continue;
      }
      // One parser for the grammar, so a user dial and a catalog dial cannot
      // read differently — including the legacy ` via <driver>` form, which
      // `parseDialRef` translates to a harness on read and never writes back.
      let ref: DialRef;
      try { ref = parseDialRef(trimmed, `user dial "${k}"`); } catch (err) {
        problems.push(`dial "${k}" is not a dial ref (${(err as Error).message})`);
        continue;
      }
      out[k] = ref;
    } else if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      const map = v as Record<string, unknown>;
      const model = typeof map.model === 'string' ? map.model.trim() : '';
      if (model.length === 0) {
        problems.push(`dial "${k}" is a mapping with no \`model\``);
        continue;
      }
      // Refused, not dropped, and refused HERE rather than left to the profile
      // parser. `parseExecutorProfile` rejects this key with the same pointer,
      // but a user dial never reaches it — every reader casts this map straight
      // to `DialRef`, so the flag used to ride along invisibly and mean nothing.
      // Silently ignoring a key someone wrote in order to override a guard is
      // the failure the permissions cut exists to end — and the guard it named
      // does not exist any more, so the file is stating something untrue.
      if (map.force_write_posture !== undefined) {
        const message =
          `user dial "${k}" in ${path} carries "force_write_posture", which is no longer supported — there ` +
          'is no write-posture guard left to override. Remove the key (the dial\'s model/effort/harness are ' +
          'still valid) or re-set the dial with `fadeno dial`. ' +
          'See docs/experimental/permissions-and-isolation.md.';
        problems.push(message);
        fatal ??= message;
        continue;
      }
      const entry: { model: string; effort?: string; harness?: string } = { model };
      if (typeof map.effort === 'string' && map.effort.trim().length > 0) entry.effort = map.effort.trim();
      if (typeof map.harness === 'string' && map.harness.trim().length > 0) entry.harness = map.harness.trim();
      // Legacy mapping form, read only.
      else if (typeof map.via === 'string' && map.via.trim().length > 0) entry.harness = legacyDriverHarness(map.via.trim());
      out[k] = entry;
    } else {
      problems.push(`dial "${k}" is ${v === null ? 'null' : Array.isArray(v) ? 'an array' : `a ${typeof v}`}, not a dial ref`);
    }
  }
  return { dials: out, problems, fatal };
}

export function readUserDials(options: UserPathOptions = {}): Record<string, { model: string; effort?: string; harness?: string }> {
  const path = userPaths(options).dialsFile;
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  if (text.length === 0) return {};
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return {}; }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const reading = interpretUserDials(doc as Record<string, unknown>, path);
  if (reading.fatal != null) throw new UserDialsError(reading.fatal);
  return reading.dials;
}

export function writeUserDials(options: UserPathOptions, dials: Record<string, { model: string; effort?: string; harness?: string }>): string {
  const path = userPaths(options).dialsFile;
  const keys = Object.keys(dials).sort();
  if (keys.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return path;
  }
  const sorted: Record<string, unknown> = {};
  for (const k of keys) {
    // One shape now. The object form existed only to carry
    // `force_write_posture`, and with that gone every dial is expressible as
    // the `model[@effort][ on <harness>]` string that `formatDialRef` emits.
    sorted[k] = formatDialRef(dials[k]!);
  }
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(sorted).sort()) ordered[k] = sorted[k];
  // Stamped literally rather than through `stampSchemaVersion`: that helper
  // lives in `persisted-state.ts`, which imports THIS module, and a cycle to
  // save one object literal is a bad trade.
  writeUserFileAtomic(path, `${JSON.stringify({ schema_version: DIALS_SCHEMA_VERSION, dials: ordered })}\n`);
  return path;
}

// --- verification cache ---

export interface ModelVerification {
  /** The executor harness whose `models_command` listed the model. */
  harness: string;
  model: string;
  verified_at: string;
}

/**
 * Schema version `recordVerifiedModel` stamps. v1 is
 * `{schema_version, verifications}`; v0 — the bare array — stays readable
 * forever. `PERSISTED_SURFACES` reads this constant rather than restating it.
 */
export const MODEL_VERIFICATIONS_SCHEMA_VERSION = 1;

/**
 * The verification rows, plus whether the document was understood at all.
 *
 * `understood: false` is what stops `recordVerifiedModel` from overwriting a
 * file it could not parse — including one written by a NEWER Fadeno. Losing a
 * cache entry costs one re-probe; clobbering the file costs every entry in it.
 * The condition is not swallowed: `auditPersistedState` reports the same file
 * as a `persisted-state:model-verifications` error.
 */
/** The document half of the reader, split out so the audit can ask it too. */
function interpretVerificationDocument(parsed: unknown): { rows: unknown[]; understood: boolean; problem: string | null } {
  // v0 IS the bare array, and stays readable forever.
  if (Array.isArray(parsed)) return { rows: parsed, understood: true, problem: null };
  if (parsed == null || typeof parsed !== 'object') {
    return { rows: [], understood: false, problem: 'is not a JSON array or object' };
  }
  const doc = parsed as Record<string, unknown>;
  const stamp = doc.schema_version;
  if (typeof stamp !== 'number') {
    return { rows: [], understood: false, problem: `is an object with schema_version ${JSON.stringify(stamp)}, which is not a number` };
  }
  if (stamp > MODEL_VERIFICATIONS_SCHEMA_VERSION) {
    return { rows: [], understood: false, problem: `has schema_version ${stamp}; this fadeno reads ${MODEL_VERIFICATIONS_SCHEMA_VERSION}` };
  }
  const rows = doc.verifications;
  if (!Array.isArray(rows)) {
    return { rows: [], understood: false, problem: `carries schema_version ${stamp} but no \`verifications\` array, so it yields no cached rows at all` };
  }
  return { rows, understood: true, problem: null };
}

/** One cache row, or null when it is not one the reader can use. */
function verificationRow(entry: unknown): ModelVerification | null {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const map = entry as Record<string, unknown>;
  // A cache written before catalog v4 keys on `driver`; the value was
  // always a harness wearing a driver's name, so it reads back as one.
  const harness = typeof map.harness === 'string'
    ? map.harness
    : typeof map.driver === 'string' ? legacyDriverHarness(map.driver) : null;
  if (harness == null || typeof map.model !== 'string' || typeof map.verified_at !== 'string') return null;
  return { harness, model: map.model, verified_at: map.verified_at };
}

function readVerificationDocument(path: string): { rows: unknown[]; understood: boolean } {
  if (!existsSync(path)) return { rows: [], understood: true };
  const text = readFileSync(path, 'utf8').trim();
  if (text.length === 0) return { rows: [], understood: true };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { rows: [], understood: false }; }
  const read = interpretVerificationDocument(parsed);
  return { rows: read.rows, understood: read.understood };
}

export function readVerifiedModels(options: UserPathOptions = {}): ModelVerification[] {
  const path = userPaths(options).modelVerificationsFile;
  const out: ModelVerification[] = [];
  for (const entry of readVerificationDocument(path).rows) {
    const row = verificationRow(entry);
    if (row == null) continue;
    out.push(row);
  }
  out.sort((a, b) => {
    if (a.harness !== b.harness) return a.harness.localeCompare(b.harness);
    return a.model.localeCompare(b.model);
  });
  return out;
}

export function isModelVerified(options: UserPathOptions, harness: string, model: string): boolean {
  const list = readVerifiedModels(options);
  return list.some((e) => e.harness === harness && e.model === model);
}

export function recordVerifiedModel(options: UserPathOptions, entry: ModelVerification): void {
  const path = userPaths(options).modelVerificationsFile;
  // Refuse to rewrite a document this Fadeno did not understand — see
  // `readVerificationDocument`. Doctor is what tells the user about it.
  if (!readVerificationDocument(path).understood) return;
  const existing = readVerifiedModels(options);
  if (existing.some((e) => e.harness === entry.harness && e.model === entry.model)) return;
  const next = [...existing, entry];
  next.sort((a, b) => {
    if (a.harness !== b.harness) return a.harness.localeCompare(b.harness);
    return a.model.localeCompare(b.model);
  });
  writeUserFileAtomic(
    path,
    `${JSON.stringify({ schema_version: MODEL_VERIFICATIONS_SCHEMA_VERSION, verifications: next })}\n`,
  );
}

/**
 * Drop every cached row the predicate selects, returning how many went.
 *
 * The cache only ever grew: `recordVerifiedModel` adds and `probeModel` reads,
 * so a row that stopped being true stayed on disk vouching for a model the
 * backend no longer lists. Removal is the other half — `models verify` deletes
 * a pair's rows when the listing definitively does not name it, and `model
 * remove` deletes them for an alias that is going away.
 *
 * Writes through the same stamped, atomic path `recordVerifiedModel` uses, so
 * a cache that is only ever *pruned* still ends up at the current
 * `schema_version` instead of silently reverting the file to the v0 bare
 * array. A document this build could not understand yields no rows, so
 * `removed` is 0 and nothing is rewritten — the same refusal
 * `recordVerifiedModel` makes explicitly.
 */
export function removeVerifiedModels(
  options: UserPathOptions,
  predicate: (entry: ModelVerification) => boolean,
): number {
  const path = userPaths(options).modelVerificationsFile;
  const existing = readVerifiedModels(options);
  const kept = existing.filter((entry) => !predicate(entry));
  const removed = existing.length - kept.length;
  if (removed === 0) return 0;
  writeUserFileAtomic(
    path,
    `${JSON.stringify({ schema_version: MODEL_VERIFICATIONS_SCHEMA_VERSION, verifications: kept })}\n`,
  );
  return removed;
}

/**
 * `$CODEX_HOME/agents`, else `<home>/.codex/agents` — where Codex looks for
 * user-scope agents, and so where `status` looks for a hand-written one whose
 * name Fadeno also routes. Fadeno materializes none of them itself.
 *
 * This lived as four hand-copied expressions, and one of them disagreed.
 * Three read `options?.env?.CODEX_HOME ?? process.env.CODEX_HOME`; the fourth
 * bound `env = options?.env ?? process.env` first. In production the two are
 * identical, because nothing in `src/` ever builds a partial `env` — only
 * tests inject one. In a test they are not: under the fall-through spelling an
 * injected env WITHOUT `CODEX_HOME` still picks up the developer's real one,
 * so a suite could read (or claim to remove) agents under a real `~/.codex`.
 *
 * This takes the hermetic spelling, which is also `userPaths`' own convention
 * directly above: an injected env replaces the process env rather than layering
 * over it. Injecting an env means declaring the whole environment.
 */
export function codexUserAgentDir(options: UserPathOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  return join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'agents');
}
