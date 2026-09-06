import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { legacyDriverHarness } from './executors.ts';
import { codexUserAgentDir, type UserPathOptions } from './user-paths.ts';

/** The three Codex role slots that get a session-static agent file. */
export const CODEX_STEERING_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;

/**
 * The header that makes a Codex agent file provably Fadeno's — the first
 * line `steering apply` / `init` stamp on every file they write, at either
 * scope. The sole licence `doctor`, `steering resolve`, and `uninstall` have
 * to read, advise on, or remove a file: without it, the file might be
 * hand-authored and is never touched or trusted.
 */
export const CODEX_MANAGED_MARK = '# fadeno:managed';

const CODEX_MANAGED_VERSION_RE = /^# fadeno:managed\b[^\n]*?\bversion=(\S+)/;

/**
 * Flags a current role agent or command broker passes to `steering resolve`.
 * Their absence is the concrete damage a frozen file does, so it is read off
 * the text rather than inferred from the file being old:
 *
 * `--prompt-file` is how the resolver sees the prompt bytes it hashes to
 * decide whether a spawn is paired with a shadow challenger; without it that
 * repo silently stops participating in shadow pairing. `--host-executor` is
 * how a materialized host agent proves the executor (and so the model and
 * effort) it was cut for.
 */
export const CODEX_RESOLVE_FLAGS = ['--prompt-file', '--host-executor'] as const;

/**
 * The Codex settings every managed agent file this build renders carries, at
 * the exact value the renderer writes — the part of the file that is neither
 * per-install nor per-dial, and so can be judged off the text alone.
 *
 * Both renderers in `src/commands/steering.ts` emit this list through
 * `codexManagedSettingsBlock`, and `readCodexAgentFile` reads the same list
 * back off the file: one edit moves what `steering apply` bakes AND what an
 * already-cut file is judged against, so the two cannot drift. That is the
 * whole difference between this and `CODEX_RESOLVE_FLAGS`, which is a hand-kept
 * list nothing renders from.
 *
 * The list is ENUMERATED rather than hashed against a fresh render, which was
 * the obvious alternative and is not available here:
 *
 *  - A fresh render needs the dial cascade — `renderCodexHostAgent` bakes
 *    `spec.model`, `spec.reasoningEffort` and `formatDialRef(cascade.ref)` —
 *    so it could never be a STANDING verdict, and `codexStandingReason` (the
 *    dial-free question `doctor`'s project-shadow findings ask) would keep
 *    vouching for a file the identity row refuses. That is the exact
 *    contradiction d1302f5 removed.
 *  - It would churn on values that are legitimately per-install and that the
 *    identity comparison already owns: the baked `--host-executor <ref>`, the
 *    two identity lines, the broker's relay identity from the repo's catalog,
 *    and the CLI path — an absolute path under the user's state home that
 *    flips the moment the managed CLI is installed or removed. A digest cannot
 *    tell "the renderer changed" from "this machine's CLI path changed"; both
 *    come back as one bit, and the fix printed for the second is a lie.
 *
 * What it deliberately does not catch, stated so the gap is chosen rather than
 * discovered: a change to the `developer_instructions` PROSE that introduces no
 * new resolve flag and no new setting, a stale baked CLI path, and a broker
 * whose relay identity the catalog has since moved. Those need the fresh render
 * and its dial, and belong to a surface that has one.
 */
export const CODEX_MANAGED_SETTINGS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'sandbox_mode', value: 'danger-full-access' },
  { key: 'approval_policy', value: 'never' },
];

/**
 * `CODEX_MANAGED_SETTINGS` as the TOML block the renderers write, so the file
 * on disk is produced from the list the checker reads.
 */
export function codexManagedSettingsBlock(): string {
  return CODEX_MANAGED_SETTINGS.map(({ key, value }) => `${key} = ${JSON.stringify(value)}\n`).join('');
}

/**
 * Which of `CODEX_MANAGED_SETTINGS` this file does not carry at this build's
 * value, each as the phrase an advisory prints: what the file says (or that it
 * says nothing) and what this build renders instead.
 *
 * Read off the text, like `missingFlags`, because the damage is concrete: a
 * file cut before 3c785e0 carries `sandbox_mode = "workspace-write"` and no
 * `approval_policy`, so every worker it spawns runs under an OS sandbox and an
 * approval gate that nothing headless can answer — the exact failure that
 * commit shipped to remove.
 */
export function codexAgentSettingDrift(text: string): string[] {
  const out: string[] = [];
  for (const { key, value } of CODEX_MANAGED_SETTINGS) {
    const found = tomlStringValue(text, key);
    if (found === value) continue;
    out.push(
      `${found == null ? `no ${key}` : `${key} = ${JSON.stringify(found)}`} where this build renders ${JSON.stringify(value)}`,
    );
  }
  return out;
}

const NAME_RE = /^name\s*=\s*"((?:[^"\\]|\\.)*)"/m;
const MODEL_RE = /^model\s*=\s*"((?:[^"\\]|\\.)*)"/m;
const EFFORT_RE = /^model_reasoning_effort\s*=\s*"((?:[^"\\]|\\.)*)"/m;
// `renderCodexHostAgent` bakes `--host-executor <ref> --run ...` (or
// `--host-executor <ref> --prompt-file ...`) as plain prose inside
// `developer_instructions`; a command broker's resolve line never carries
// the flag at all. `<ref>` is `formatDialRef`'s output — `model[@effort][ via
// alias]` — so an optional `via` clause is reassembled from the two groups
// rather than captured as one greedy token, which would either swallow the
// following `--run`/`--prompt-file` flag or stop short of the alias.
// Both grammars: v4's ` on <harness>`, and the ` via <driver>` a file baked
// before the bump still carries. The legacy half is READ only — the renderer
// below always writes the v4 form — so an agent file materialized by an older
// fadeno still identifies itself instead of silently failing its ref match.
const HOST_EXECUTOR_RE = /--host-executor\s+(\S+)(?:\s+(on|via)\s+(\S+))?/;

function unquoteToml(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * One top-level `key = "value"` off an agent file, or null when the file states
 * the key nowhere. Anchored per line, so the `"""` developer-instructions block
 * cannot supply a value the renderer never wrote as a setting.
 */
function tomlStringValue(text: string, key: string): string | null {
  const match = new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(text);
  return match ? unquoteToml(match[1]!) : null;
}

/** Everything `doctor` and `steering resolve` read off one Codex agent file. */
export interface CodexAgentFileState {
  /** The file's first line carries the managed header `steering apply`/`init` write. */
  managed: boolean;
  /** `version=` off that header, when it carries one. */
  version: string | null;
  /**
   * Which of `CODEX_RESOLVE_FLAGS` this file's text never mentions. Empty
   * means it is current on the resolver contract, whatever stamped it.
   */
  missingFlags: string[];
  /**
   * Which of `CODEX_MANAGED_SETTINGS` this file does not carry at this build's
   * value, already phrased for an advisory. Empty means its settings are the
   * ones this build's renderers write.
   */
  settingDrift: string[];
  /** The file's `name` key — the archetype it materializes. */
  name: string | null;
  /** The file's `model` key. */
  model: string | null;
  /** The file's `model_reasoning_effort` key. */
  reasoningEffort: string | null;
  /**
   * The executor ref baked into this file's own `--host-executor <ref>`
   * invocation, when its text carries one. Only a materialized HOST role
   * agent bakes the flag into its own instructions — a command broker's
   * resolve line omits it, so this is null for a broker even when managed.
   */
  hostExecutor: string | null;
}

/**
 * Read one Codex agent file's provenance and identity. `null` means "no such
 * file" — as does an unreadable one, which is not provably Fadeno's and so is
 * never claimed (the same rule `listRetiredClaudeGridCells` applies to Claude
 * agents).
 *
 * The single parser `doctor`'s broker-drift checks and `steering resolve`'s
 * delegation advisory both read through — a second hand-rolled TOML scraper
 * here would be exactly the one-fact-two-readers drift this codebase keeps
 * getting bitten by.
 */
export function readCodexAgentFile(path: string): CodexAgentFileState | null {
  let text: string;
  try {
    if (!existsSync(path)) return null;
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const missingFlags = CODEX_RESOLVE_FLAGS.filter((flag) => !text.includes(flag));
  const managed = text.startsWith(CODEX_MANAGED_MARK);
  const versionMatch = managed ? CODEX_MANAGED_VERSION_RE.exec(text) : null;
  const nameMatch = NAME_RE.exec(text);
  const modelMatch = MODEL_RE.exec(text);
  const effortMatch = EFFORT_RE.exec(text);
  const hostExecutorMatch = HOST_EXECUTOR_RE.exec(text);
  return {
    managed,
    version: versionMatch ? versionMatch[1]! : null,
    missingFlags,
    settingDrift: codexAgentSettingDrift(text),
    name: nameMatch ? unquoteToml(nameMatch[1]!) : null,
    model: modelMatch ? unquoteToml(modelMatch[1]!) : null,
    reasoningEffort: effortMatch ? unquoteToml(effortMatch[1]!) : null,
    hostExecutor: hostExecutorMatch
      ? (hostExecutorMatch[3] != null
          // A legacy ` via <driver>` is normalized to the v4 spelling, through
          // the same map `parseDialRef` uses, so a ref-string comparison
          // against `formatDialRef(ref)` still matches.
          ? `${hostExecutorMatch[1]} on ${hostExecutorMatch[2] === 'via' ? legacyDriverHarness(hostExecutorMatch[3]!) : hostExecutorMatch[3]}`
          : hostExecutorMatch[1]!)
      : null,
  };
}

/** One archetype's Codex agent file path at a given scope. */
export function codexAgentFilePath(
  scope: 'project' | 'user',
  repoRoot: string,
  archetype: string,
  userPathOptions?: UserPathOptions,
): string {
  return scope === 'project'
    ? join(repoRoot, '.codex', 'agents', `${archetype}.toml`)
    : join(codexUserAgentDir(userPathOptions), `fadeno-${archetype}.toml`);
}

export interface CodexAgentCandidate {
  archetype: string;
  path: string;
  scope: 'project' | 'user';
  state: CodexAgentFileState;
}

/**
 * The file Codex would ACTUALLY load for each of the three role archetypes,
 * applying Codex's own project-over-user shadowing: when a project-scope file
 * exists for an archetype, it is the only file Codex ever resolves for that
 * name — the user-scope file underneath it is invisible, not merely lower
 * priority, whether or not the project one is managed or matches anything.
 * `doctor` already documents this precedence for its shadow-drift findings;
 * this is the same rule applied to delegation.
 */
export function effectiveCodexAgentCandidates(
  repoRoot: string,
  userPathOptions?: UserPathOptions,
): CodexAgentCandidate[] {
  const out: CodexAgentCandidate[] = [];
  for (const archetype of CODEX_STEERING_ARCHETYPES) {
    const projectPath = codexAgentFilePath('project', repoRoot, archetype, userPathOptions);
    const projectState = readCodexAgentFile(projectPath);
    if (projectState != null) {
      out.push({ archetype, path: projectPath, scope: 'project', state: projectState });
      continue;
    }
    const userPath = codexAgentFilePath('user', repoRoot, archetype, userPathOptions);
    const userState = readCodexAgentFile(userPath);
    if (userState != null) out.push({ archetype, path: userPath, scope: 'user', state: userState });
  }
  return out;
}

/** The identity a spawn must actually deliver: the run snapshot's model and effort. */
export interface CodexAgentIdentity {
  model: string;
  reasoningEffort: string;
}

/**
 * The managed Codex agent for `archetype` that a caller could spawn to deliver
 * a locked request in-host, or null when this repo has none.
 *
 * **A Codex agent file is a frozen identity, not a default.** Codex's subagent
 * doc: "If a custom agent file sets `model` or `model_reasoning_effort`, the
 * value in the file takes precedence. Before applying the file, Codex resolves
 * each setting from an explicit spawn value, then the corresponding `[agents]`
 * default, then the parent's value." That cascade decides only what the file
 * falls back FROM — the file itself is applied last and WINS. Measured
 * 2026-09-04 (basanos session `01a06ce8`): two `reviewer` spawns passing an
 * explicit `model: gpt-5.6-sol` ran every API call at the file's
 * `gpt-5.6-luna`. It is the same fact `templates/codex/hooks/spawn-guard.mjs`
 * is built on, and the reason that hook refuses a drifted spawn instead of
 * rewriting it: nothing a caller passes can correct the file.
 *
 * So `identity` — the run snapshot's model and effort — is matched against the
 * file when given. An agent whose file carries anything else would silently
 * deliver that other identity against a snapshot that froze one on purpose,
 * and no spawn value can stop it. Callers that only want "a managed agent for
 * this role and executor exists" (to NAME the drift) omit `identity`.
 *
 * The file's baked `--host-executor` is matched too, for a different reason:
 * it is behavioral rather than a Codex setting. Its developer instructions
 * pass that value back to `steering resolve`; a command broker passes no value
 * at all. Offering either kind for a different executor creates a recursive
 * delegate advisory instead of delivering the assignment, so the baked
 * executor must agree exactly.
 *
 * The ROLE still matters and is matched: an envelope can only be claimed as
 * the archetype it names, so the reviewer agent cannot take a worker's
 * dispatch however the models line up. `'*'` (or null) is the immutable
 * wildcard, where any declared role surface may claim it.
 *
 * `managed` is still required: an unmarked file is not provably Fadeno's, so
 * its instructions cannot be assumed to resolve the envelope at all.
 *
 * A `current-host` file carries neither key, so an `identity` clause never
 * matches it.
 */
export function findSpawnableCodexAgent(
  candidates: CodexAgentCandidate[],
  archetype: string | null,
  hostExecutor: string,
  identity?: CodexAgentIdentity,
): CodexAgentCandidate | null {
  return candidates.find((candidate) =>
    (archetype == null || archetype === '*' || candidate.archetype === archetype) &&
    candidate.state.managed &&
    candidate.state.hostExecutor === hostExecutor &&
    (identity == null ||
      (candidate.state.model === identity.model &&
        candidate.state.reasoningEffort === identity.reasoningEffort)),
  ) ?? null;
}

// --- Managed identity truth: what the file says vs what the dial says ---

/**
 * The identity a managed Codex agent file is EXPECTED to carry for one
 * archetype, as the dial resolves it.
 *
 * `model`/`effort` are the values `renderCodexHostAgent` would bake, so a
 * neutral `current-host` slot — whose file states no identity at all by
 * construction — is represented as two nulls rather than as the sentinel
 * string. The caller does that mapping because the sentinel's name lives in
 * `src/commands/steering.ts`, and this module sits underneath it.
 *
 * `lane` is the lane the FILE is cut for, not the lane a given call would
 * take: `host` means `steering apply` writes a host agent that bakes this
 * identity, `command` means it writes a command broker whose only identity is
 * the relay's. A broker's model is therefore never the dial's, which is why
 * the command lane is reported and not judged.
 */
export interface CodexDialIdentity {
  model: string | null;
  effort: string | null;
  lane: 'host' | 'command';
}

/**
 * One archetype's row: WHICH file Codex would load, what that file says, what
 * its dial says, and the verdict.
 *
 * `scope`/`path` are not decoration. Until 2026-09-06 both identity surfaces
 * read `$CODEX_HOME/agents/fadeno-<archetype>.toml` and nothing else, so a
 * project-scope `.codex/agents/<archetype>.toml` — which Codex resolves FIRST,
 * making the user file invisible — was judged by neither. A row that names its
 * file is also the only way a reader can pick the right fix: `--scope user`
 * rewrites a file that is being shadowed and changes nothing on disk that
 * Codex will read (see `codexIdentityRemediation`).
 */
export interface CodexAgentIdentityRow {
  archetype: string;
  /** Where the judged file lives, or null when no file exists at either scope. */
  scope: 'project' | 'user' | null;
  /** The judged file's absolute path, or null when there is none. */
  path: string | null;
  file: { model: string | null; effort: string | null } | null;
  dial: CodexDialIdentity | null;
  /**
   * The `version=` the managed header stamps, when the judged file carries one.
   *
   * Evidence, never the verdict. A build-stamp comparison was the other
   * candidate for detecting an outdated file and is rejected on noise: every
   * release bumps `packageVersion()`, so it would fire for every install after
   * every upgrade, including the files whose text did not change — and its
   * remediation ends in "start a fresh Codex session", which is disruptive
   * enough that firing it on a no-op teaches the reader to skip the row. What
   * the stamp is good for is telling a reader WHICH build wrote the file it is
   * being told to re-cut, so it is reported beside a verdict earned elsewhere.
   */
  version: string | null;
  /** `CodexAgentFileState.settingDrift` for the judged file; empty otherwise. */
  settingDrift: string[];
  status: 'current' | 'stale' | 'missing' | 'not_applicable' | 'unmanaged' | 'shadowed' | 'outdated';
}

/**
 * The one command that rewrites the user-scope managed agent files with the
 * dialed identity, frozen here so `status` and `dial` cannot drift apart.
 *
 * Chosen against the alternatives by running them (see
 * `test/status-codex-identity.test.ts`, which executes this exact argv against
 * a temp user dir and asserts the drift clears):
 *
 *  - `fadeno steering apply <loadout> --codex --force` is not a command. The
 *    CLI refuses any positional after `apply` (`src/cli.ts`, the `sub ===
 *    'apply'` branch), so the `<loadout>` word alone makes it exit non-zero —
 *    and without `--scope user` it would write `.codex/agents/` in the repo,
 *    which is not the directory `status` reads.
 *  - `fadeno setup --codex` does reach the same apply (`src/commands/setup.ts`
 *    calls `runSteeringApply` with `scope: 'user'`), but it also syncs the
 *    managed runtime, migrates persisted state, and rewrites the installation
 *    manifest — a much larger action than the drift calls for.
 *
 * `--force` is deliberately absent: at user scope it changes nothing (a file
 * carrying the managed header is refreshed on content difference, and a
 * foreign file at that path is preserved with or without it — see
 * `managedAgentEmit`), so including it would only teach a habit that matters
 * at project scope.
 */
export const CODEX_IDENTITY_REMEDIATION =
  'run `fadeno steering apply --codex --scope user`, then start a fresh Codex session';

/**
 * The fix when the file Codex actually loads is a PROJECT-scope one.
 *
 * `CODEX_IDENTITY_REMEDIATION` is not merely unhelpful here, it is wrong: a
 * user-scope apply rewrites `$CODEX_HOME/agents/fadeno-<archetype>.toml`,
 * which the project file makes invisible, so the drift survives the fix and
 * the next session loads the same wrong identity. Worse, `--scope user`
 * deliberately resolves the USER dial layer only (`dialLayersForApply`), so it
 * cannot even bake a session or repo dial that this row is being judged
 * against.
 *
 * `--scope project` reads the full cascade — the same layers `steering
 * resolve` answers `status` with — so it writes the file this row compared,
 * and a managed project file is refreshed in place. Deleting is offered as the
 * equal alternative because it is the right answer when the project copy was
 * never wanted: it hands the slot back to the managed user-scope set.
 */
export const CODEX_PROJECT_IDENTITY_REMEDIATION =
  'run `fadeno steering apply --codex --scope project` to re-cut the project-scope file(s) Codex ' +
  'loads instead, or delete them so the managed user-scope agents load again, then start a fresh ' +
  'Codex session';

/**
 * The fix for a file Fadeno did not write and will never overwrite.
 *
 * Neither apply spelling touches it on its own: `managedAgentEmit` refuses any
 * file whose first line is not `CODEX_MANAGED_MARK`, and at USER scope that
 * refusal is absolute — `--force` is scope-dependent and does not apply there,
 * because `fadeno-<archetype>.toml` is a name Fadeno owns by convention and a
 * foreign file at it is a deliberate takeover. So the only remediation that
 * always works is to move the file out of the way; the `--force` takeover is
 * named as the project-scope-only option it is.
 */
export const CODEX_UNMANAGED_IDENTITY_REMEDIATION =
  'move or delete the unmanaged file(s) so Fadeno\'s managed agent loads again — `fadeno steering ' +
  'apply` never overwrites a file it did not write, and only at project scope does `--force` take ' +
  'one over deliberately — then start a fresh Codex session';

/**
 * The one fix line for a set of rows, chosen per row and de-duplicated.
 *
 * `status`, `dial` and `doctor` all print this rather than picking a constant
 * themselves: the whole reason the remediation was frozen into a constant in
 * run 2002 was that three surfaces re-spelling it is how they drift, and
 * "which constant applies" is the same question wearing a hat.
 *
 * Order is row order, so the sentence is stable for a given report.
 */
export function codexIdentityRemediation(rows: CodexAgentIdentityRow[]): string | null {
  const needed: string[] = [];
  const add = (text: string): void => {
    if (!needed.includes(text)) needed.push(text);
  };
  for (const row of rows) {
    switch (row.status) {
      case 'current':
      case 'not_applicable':
        continue;
      case 'unmanaged':
        add(CODEX_UNMANAGED_IDENTITY_REMEDIATION);
        continue;
      default:
        // `missing` has no file at either scope, so the managed set is what is
        // wanted and user scope is where it lives. `outdated` needs no third
        // spelling and no `--force`: `managedAgentEmit` refreshes a file
        // carrying the managed header whenever its content differs, at either
        // scope, and an outdated file differs by definition. `--force` is
        // scope-dependent and only ever governs taking over a file Fadeno did
        // NOT write, which is the `unmanaged` arm above.
        add(row.scope === 'project' ? CODEX_PROJECT_IDENTITY_REMEDIATION : CODEX_IDENTITY_REMEDIATION);
    }
  }
  return needed.length === 0 ? null : needed.join('; and ');
}

/**
 * The verdict for one archetype, from the file's identity and the dial's.
 *
 * A missing file outranks everything: whatever lane the dial lands on, Codex
 * has no agent to load for that role. Beyond that, only a HOST slot's identity
 * is judged — a command broker carries the relay's model and effort on
 * purpose, so comparing it against the dial would report drift that is not
 * there. An unresolvable dial (`null`) is the same "reported, not judged"
 * case.
 */
export function codexAgentIdentityStatus(
  file: { model: string | null; effort: string | null } | null,
  dial: CodexDialIdentity | null,
): CodexAgentIdentityRow['status'] {
  if (file == null) return 'missing';
  if (dial == null || dial.lane === 'command') return 'not_applicable';
  return file.model === dial.model && file.effort === dial.effort ? 'current' : 'stale';
}

/**
 * One archetype's row, built from the file Codex would ACTUALLY load.
 *
 * The single builder `status` and `dial` both go through. They used to reach
 * for `join(codexUserAgentDir(...), \`fadeno-${archetype}.toml\`)` each, which
 * is the same one-fact-two-readers shape this codebase keeps paying for — and
 * both readers had the same fact wrong, because Codex resolves a project-scope
 * `.codex/agents/<archetype>.toml` first and never looks at the user file
 * underneath it (`effectiveCodexAgentCandidates`). `doctor` has applied that
 * precedence since it grew shadow-drift findings; the identity surfaces did
 * not, so both could print `current` for a file no session would ever load.
 *
 * `codexAgentIdentityStatus` is left exactly as run 2002 factored it — this
 * decides WHICH file is fed to it, plus the two verdicts that are about the
 * file's standing rather than its identity:
 *
 *  - `unmanaged`: Codex will load it, Fadeno did not write it, and Fadeno
 *    cannot vouch for it. Deliberately NOT judged on model/effort, because a
 *    hand-authored file that happens to name the dialed model would then be
 *    called `current` — a claim about the two TOML keys being read as a claim
 *    about the whole file. It is not: the instructions that make an agent
 *    resolve an envelope at all (`CODEX_RESOLVE_FLAGS`) are unverified here,
 *    and `steering apply` will never refresh it. `missing` outranks it only
 *    because there is nothing to load at all in that case.
 *  - `shadowed`: a PROJECT-scope command broker is what loads while the dial
 *    resolves to the host lane. Judging its identity would be a lie in the
 *    other direction — a broker carries the relay's model and effort by
 *    construction, so `stale` would accuse the file of an identity no apply
 *    would ever write there. What is actually wrong is structural: the host
 *    lane this dial asks for cannot be delivered in this repo at all, because
 *    the managed host agent underneath (if any) is invisible. Scoped to
 *    project scope on purpose — at USER scope a broker under a host dial IS
 *    ordinary drift that `--scope user` re-cuts, which is the `stale` verdict
 *    this surface has always given it.
 *  - `outdated`: Fadeno wrote it, and its settings are not the ones this build
 *    renders (`CODEX_MANAGED_SETTINGS`). Two verdicts about two different
 *    disagreements, and the names are worth keeping straight: `stale` is the
 *    file's IDENTITY disagreeing with the dial, `outdated` is the file's TEXT
 *    disagreeing with this build's renderer. It is checked BEFORE any dial is
 *    consulted, for three reasons — it holds when the dial is unresolvable
 *    (`null`), it holds for a command BROKER, whose identity is deliberately
 *    never judged and which is otherwise the one file shape that could never
 *    be reported outdated at all, and it is what makes the answer a standing
 *    one that `codexStandingReason` can ask for. It masks `stale` on a file
 *    that is both, which costs nothing: the remediation for a given scope is
 *    one command and it clears both.
 *
 *    The gap this closes: 3c785e0 moved every command lane to maximal
 *    permissions and changed what these files bake — `sandbox_mode =
 *    "danger-full-access"` and `approval_policy = "never"` in place of
 *    `sandbox_mode = "workspace-write"` — and nothing on any surface could see
 *    it. `readCodexAgentFile` parsed neither key, the identity comparison is
 *    model and effort only, and the managed header's digest covers the file's
 *    OWN body, so it is self-consistent by construction and agrees with a file
 *    no renderer in this build would produce. A BREAKING change was therefore
 *    inert for every existing install, under a `doctor` line reading "managed
 *    host-agent state is current".
 *
 * A host agent is told from a broker by its baked `--host-executor`, the same
 * discriminator `findSpawnableCodexAgent` uses: only `renderCodexHostAgent`
 * writes the flag into its own instructions, and it writes it for the neutral
 * `current-host` slot too (where both identity lines are omitted), so this
 * does not mistake the untouched default for a broker.
 */
export function codexAgentIdentityRow(
  archetype: string,
  candidate: CodexAgentCandidate | null,
  dial: CodexDialIdentity | null,
): CodexAgentIdentityRow {
  if (candidate == null) {
    return {
      archetype, scope: null, path: null, file: null, dial,
      version: null, settingDrift: [], status: 'missing',
    };
  }
  const file = { model: candidate.state.model, effort: candidate.state.reasoningEffort };
  const base = {
    archetype, scope: candidate.scope, path: candidate.path, file, dial,
    version: candidate.state.version, settingDrift: candidate.state.settingDrift,
  };
  if (!candidate.state.managed) return { ...base, status: 'unmanaged' };
  // Before the dial, and before the shadowing question: this one is about the
  // file's own text and is the only verdict a broker can earn.
  if (candidate.state.settingDrift.length > 0) return { ...base, status: 'outdated' };
  if (candidate.scope === 'project' && candidate.state.hostExecutor == null && dial?.lane === 'host') {
    return { ...base, status: 'shadowed' };
  }
  return { ...base, status: codexAgentIdentityStatus(file, dial) };
}

/**
 * The half of a row's verdict that needs no dial: can Fadeno vouch for the
 * file Codex would load at all, and if not, WHY? `null` means it can.
 *
 * `doctor`'s project-shadow findings ask a RELATIONAL question — does this
 * project-scope file override the managed user-scope set? — and answer it
 * without ever resolving a dial. That is a different question from the one
 * `codexAgentIdentityRow` answers, and it is legitimately `ok` for a project
 * file with no user counterpart: nothing is being overridden. But the two
 * answers print in the same report, so the relational check still has to know
 * whether the file it is calling unshadowed is one Fadeno wrote — otherwise
 * its `ok` reads as a clean bill of health for the exact file the identity row
 * refuses to vouch for. Until 2026-09-06 it did: the `soleProject` branch
 * called every project file a "broker" and never looked at the managed header,
 * so one file got `ok` from `doctor` and `unmanaged` from `status`/`dial` —
 * the same one-list-two-consumers drift that 6efe290 was itself the fix for.
 *
 * So the standing question has exactly one implementation, and it is
 * `codexAgentIdentityRow`, asked with a null dial. That is not a trick: `null`
 * is the builder's own "unresolvable dial" input, and under it only the
 * standing verdicts and `not_applicable` are reachable — no identity
 * comparison happens, because there is nothing to compare against.
 *
 * Asking for `not_applicable` rather than asking NOT-`unmanaged` is deliberate
 * and fails safe: a standing verdict added to the builder later stops `doctor`
 * vouching automatically, instead of slipping past a predicate that only knew
 * one verdict's name. That is not hypothetical any more — `outdated` is exactly
 * such a verdict, added 2026-09-06, and this said "no" for it on the day it
 * landed without being edited.
 *
 * It returns the REASON rather than a boolean, and that is the same argument
 * one step further. Its one consumer used to supply the reason itself, printing
 * "carries no managed header" for every unvouched file because `unmanaged` was
 * the only way to be one; a second standing verdict turns that hardcoded
 * half-sentence into a false statement about a file that DOES carry the header
 * — the bug this verdict exists to catch, committed inside its own fix. So the
 * clause comes from the same row as the verdict, and the `default` arm prints
 * something true-but-vague rather than something confident and wrong.
 *
 * Takes the ROW, not the candidate, because `doctor` needs the verdict AND the
 * clause for one file and must not build the row twice to get them — two
 * readings of one file is how they start disagreeing.
 */
export function codexStandingReason(row: CodexAgentIdentityRow): string | null {
  switch (row.status) {
    case 'not_applicable':
      return null;
    case 'unmanaged':
      return 'carries no managed header';
    case 'outdated':
      return `carries ${row.settingDrift.join(', and ')}`;
    default:
      return `is not one Fadeno can vouch for (${row.status})`;
  }
}

function identityText(identity: { model: string | null; effort: string | null } | null): string {
  if (identity == null) return 'missing';
  if (identity.model == null) return 'the session baseline';
  return identity.effort == null ? identity.model : `${identity.model}/${identity.effort}`;
}

/**
 * One drifted row as a person reads it: `reviewer file gpt-5.6-luna/high vs
 * dial gpt-5.6-terra/xhigh`.
 *
 * The single formatter `status`, `dial` and `doctor` all print through — the
 * three surfaces state the same fact, and a second spelling of it is exactly
 * the one-fact-two-readers drift this codebase keeps paying for. `missing` is
 * rendered here rather than by a ternary at each call site for that same
 * reason; two of the three had already grown a copy of it.
 *
 * A user-scope row keeps its exact 2026-09-05 spelling, so the one sentence a
 * test froze is unchanged. Every other row NAMES ITS FILE, because that is the
 * fact a reader needs and cannot otherwise get: the report's header names the
 * user agent directory, and a row about `.codex/agents/reviewer.toml` read as
 * a row about `$CODEX_HOME/agents/fadeno-reviewer.toml` sends its reader to
 * re-cut a file that is not the one loading.
 */
export function describeCodexAgentIdentityRow(row: CodexAgentIdentityRow): string {
  if (row.status === 'missing') return `${row.archetype} file missing`;
  if (row.status === 'unmanaged') {
    return `${row.archetype} loads ${row.path}, which carries no managed header — Fadeno did not ` +
      'write it and cannot vouch for what it does';
  }
  if (row.status === 'outdated') {
    // The stamped version is the reader's only way to see WHICH build wrote
    // the file they are being told to re-cut, and a file stamped by this very
    // build says something else again: the settings were edited after it was
    // written. Both are worth printing; neither is the verdict.
    return `${row.archetype} loads ${row.path}, cut by ${row.version == null ? 'an unstamped build' : `fadeno ${row.version}`} ` +
      `and carrying ${row.settingDrift.join(', and ')} — re-cutting it is what applies this build's lane permissions`;
  }
  if (row.status === 'shadowed') {
    return `${row.archetype} loads the project-scope command broker ${row.path}, which shadows the ` +
      `managed user-scope agent — dial ${identityText(row.dial)} resolves to the host lane, which ` +
      'a broker can never deliver';
  }
  const where = row.scope === 'project' ? `project file ${row.path} ` : 'file ';
  return `${row.archetype} ${where}${identityText(row.file)} vs dial ${identityText(row.dial)}`;
}

/**
 * How a file's own identity reads in an advisory that has to name it.
 *
 * The sibling of `fileIdentity` in `templates/codex/hooks/spawn-guard.mjs`, and
 * deliberately renders the same string: a null half is the `current-host`
 * shape, where the file states nothing and the session is inherited. The
 * guard's trailing `(cut for <ref>)` clause is omitted because every caller
 * here has already matched the baked executor exactly, so it would only repeat
 * a value the advisory just stated.
 */
export function describeCodexAgentFileIdentity(state: CodexAgentFileState): string {
  return `${state.model ?? 'the session model'}` +
    `${state.reasoningEffort != null ? ` at effort ${state.reasoningEffort}` : ''}`;
}
