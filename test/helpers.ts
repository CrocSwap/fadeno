import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';

// Hermetic user scope for the whole suite: a developer's real `fadeno setup`
// state (user executor catalog + sticky user loadout under XDG/state) must
// never leak into in-process command calls or spawned CLIs that default to
// `process.env`. Tests that exercise user-state behavior on purpose inject a
// fully explicit `userPathOptions` (home + env) and are unaffected. Every
// test file imports this module, so this runs before any test body.
process.env.FADENO_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'fadeno-test-user-config-'));
process.env.FADENO_STATE_HOME = mkdtempSync(join(tmpdir(), 'fadeno-test-user-state-'));

// `userPaths()` (src/lib/user-paths.ts) does `env = options.env ?? process.env`
// — passing an explicit `env` REPLACES the whole environment, not merges with
// it. So a test that does `{ env: { FADENO_HARNESS: 'claude' } }` bypasses the
// module-level `FADENO_STATE_HOME`/`FADENO_CONFIG_HOME` redirect above
// entirely (that small literal object has neither key) and falls through to
// `options.home ?? homedir()` — the developer's REAL home directory, since
// `home` was never passed either. There is no way to isolate that call site
// from within the small `env` object alone.
//
// The fix lives here, in `tempRepo()`, rather than in a wrapper around
// `process.env` at the top of the file: `os.homedir()` re-reads
// `process.env.HOME` live (verified — it is not cached at process start), so
// redirecting `HOME` itself is what protects every "env without home" call
// site in the suite, automatically, without editing each one. `tempRepo()` is
// also the right layer rather than `package.json`'s test script: a script
// only protects `npm test` and leaves `npm run focus` and a bare
// `node --test test/foo.test.ts` exposed, which is exactly how anyone
// iterating on one file runs it — isolation must follow the test, not the
// invocation.
const HOME_ENV_KEYS = ['HOME', 'FADENO_CONFIG_HOME', 'FADENO_STATE_HOME', 'FADENO_DATA_HOME'] as const;

/** Tests for which the home-env redirect below has already been installed. */
const homeRedirected = new WeakSet<TestContext>();

/**
 * Redirect `HOME` and the `FADENO_*_HOME` variables into a throwaway
 * directory for the life of test `t`, restoring the exact previous values
 * (deleting a variable that was previously unset, rather than setting it to
 * the string "undefined") once `t` finishes. Idempotent per test: a test that
 * calls `tempRepo()` more than once only snapshots/redirects on the first
 * call, so a later call cannot clobber the snapshot with an already-redirected
 * value.
 */
function ensureHomeRedirected(t: TestContext): void {
  if (homeRedirected.has(t)) return;
  homeRedirected.add(t);
  const previous: Partial<Record<(typeof HOME_ENV_KEYS)[number], string | undefined>> = {};
  for (const key of HOME_ENV_KEYS) previous[key] = process.env[key];
  const home = mkdtempSync(join(tmpdir(), 'fadeno-test-home-'));
  process.env.HOME = home;
  process.env.FADENO_CONFIG_HOME = join(home, 'config');
  process.env.FADENO_STATE_HOME = join(home, 'state');
  process.env.FADENO_DATA_HOME = join(home, 'data');
  t.after(() => {
    for (const key of HOME_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
}

/**
 * Create a throwaway repo directory that is removed when the test ends.
 *
 * Also makes the test hermetic against the developer's real user-scope state
 * (see `ensureHomeRedirected` above) by redirecting `HOME` and the
 * `FADENO_*_HOME` variables for the test's lifetime. Pass `{ realHome: true }`
 * to opt a specific test out of that redirect — only for a test that
 * genuinely needs the developer's real home directory.
 */
export function tempRepo(t: TestContext, options: { realHome?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'fadeno-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (!options.realHome) ensureHomeRedirected(t);
  return dir;
}

export function exists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

/**
 * A catalog v4 document from a compact object — the one fixture renderer.
 *
 * Every test that needs "a working catalog" used to inline a
 * `routes: { <host>: { <provider>: … } }` table, one copy per fixture, six
 * near-identical host families deep. That is exactly the shape catalog v4
 * collapsed, and 84 hand-written copies of it is exactly how a schema bump
 * becomes unaffordable. One renderer instead: a test states only what it is
 * actually about, and a future bump edits this function.
 *
 * Defaults are deliberately minimal and named after real harnesses, so a
 * fixture that says nothing still resolves `sol` (openai → codex) and
 * `opus` (anthropic → claude) the way the shipped catalog does. Pass
 * `harnesses` to replace the table wholesale when the argv is the point of
 * the test; pass `models` to replace the registry.
 *
 * Returns YAML text: the same value goes to `parseExecutorProfile` and to
 * `writeFileSync(.fadeno/executors.yaml)`, so a fixture cannot be right in one
 * place and wrong in the other.
 */
export interface CatalogV4Input {
  schema_version?: number;
  models?: Record<string, unknown>;
  harnesses?: Record<string, unknown>;
  dials?: Record<string, unknown>;
  bindings?: Record<string, unknown>;
  archetypes?: Record<string, unknown>;
  constraints?: unknown;
  tools?: Record<string, unknown>;
  unregistered_model_harness?: string;
  worktree_carry?: string[];
  surfaces?: string[];
  /** Extra top-level keys, for tests that exercise the unknown-key checks. */
  extra?: Record<string, unknown>;
}

/** The default registry: one model per default harness, at a stated effort. */
export const CATALOG_V4_DEFAULT_MODELS: Record<string, unknown> = {
  sol: { provider: 'openai', id: 'gpt-5.6-sol', effort: 'high' },
  opus: { provider: 'anthropic', id: 'opus', effort: 'xhigh' },
};

/**
 * The default harness table: a host-capable `codex` and `claude` plus a
 * command-only `opencode` for the unregistered fall-through. Small on purpose
 * — a fixture that needs `grok` or a variant says so.
 */
export const CATALOG_V4_DEFAULT_HARNESSES: Record<string, unknown> = {
  codex: {
    provider: 'openai',
    host: { effort_channel: 'agent-file' },
    command: ['codex', 'exec', '--model', '{model}', '-'],
  },
  claude: {
    provider: 'anthropic',
    host: { effort_channel: 'none' },
    command: ['claude', '-p', '--model', '{model}'],
  },
  opencode: {
    command: ['opencode', 'run', '-m', 'openrouter/{model}', '--variant', '{reasoning_effort}'],
  },
};

/** The catalog v4 document as a plain object, before serialization. */
export function catalogV4Doc(input: CatalogV4Input = {}): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    schema_version: input.schema_version ?? 4,
    models: input.models ?? CATALOG_V4_DEFAULT_MODELS,
    harnesses: input.harnesses ?? CATALOG_V4_DEFAULT_HARNESSES,
  };
  if (input.dials !== undefined) doc.dials = input.dials;
  if (input.bindings !== undefined) doc.bindings = input.bindings;
  if (input.archetypes !== undefined) doc.archetypes = input.archetypes;
  if (input.constraints !== undefined) doc.constraints = input.constraints;
  if (input.tools !== undefined) doc.tools = input.tools;
  if (input.unregistered_model_harness !== undefined) doc.unregistered_model_harness = input.unregistered_model_harness;
  if (input.worktree_carry !== undefined) doc.worktree_carry = input.worktree_carry;
  if (input.surfaces !== undefined) doc.surfaces = input.surfaces;
  for (const [key, value] of Object.entries(input.extra ?? {})) doc[key] = value;
  return doc;
}

export function catalogV4(input: CatalogV4Input = {}): string {
  return stringifyYaml(catalogV4Doc(input));
}

const STARTER_CATALOG = join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'executors.yaml');

/**
 * Seed `.fadeno/executors.yaml` in a temp repo from the shipped starter
 * catalog — what `fadeno init` used to do before the redesign removed it.
 */
export function seedStarterCatalog(root: string): void {
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  copyFileSync(STARTER_CATALOG, join(root, '.fadeno', 'executors.yaml'));
}

/** Run git in `root`, throwing on failure — for test setup only. */
export function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * A throwaway git repository with one commit on `main`, identity configured
 * locally so the developer's global git config is never consulted.
 */
export function gitRepo(t: TestContext): string {
  const root = tempRepo(t);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fadeno-test@example.invalid']);
  git(root, ['config', 'user.name', 'fadeno test']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}
