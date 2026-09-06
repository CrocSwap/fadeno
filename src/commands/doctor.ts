import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { runStatus, type StatusOptions } from './status.ts';
import { listRetiredClaudeGridCells } from './steering.ts';
import { ARCHETYPE_DISPLAY_ORDER, detectAmbientHarness, IGNORED_DEADLINE_NOTE_TOKEN, resolveRole } from '../lib/executors.ts';
import { catalogRepairFindings, ignoredDeadlineFindings, verificationFindings } from '../lib/catalog-rot.ts';
import { isListable, listHarnessModels, listingFindings } from '../lib/model-listing.ts';
import { auditPersistedState } from '../lib/persisted-state.ts';
import { loadLayeredProfile } from '../lib/config-layers.ts';
import { findRepoRoot, templatesDir } from '../lib/paths.ts';
import { isFadenoPathIgnored } from '../lib/source-control.ts';
import { describeVestigialWorkspaceLease } from '../lib/workspace-lease.ts';
import { dispatchWindowLogFindings, overlapSnapshotFindings } from '../lib/workspace-overlap.ts';
import { catalogLayerVersions, explainSuppressedBuiltin } from '../lib/config-layers.ts';
import { compareFadenoVersions, readInstallationManifest } from '../lib/installations.ts';
import { codexUserAgentDir, readVerifiedModels, userPaths } from '../lib/user-paths.ts';
import {
  CODEX_IDENTITY_REMEDIATION,
  CODEX_UNMANAGED_IDENTITY_REMEDIATION,
  codexAgentIdentityRow,
  codexIdentityRemediation,
  codexStandingReason,
  describeCodexAgentIdentityRow,
  effectiveCodexAgentCandidates,
  findSpawnableCodexAgent,
  readCodexAgentFile,
  type CodexAgentIdentityRow,
} from '../lib/codex-agent-file.ts';
import { listRuns, readEvents } from '../lib/run-ledger.ts';
import { normalizeDeliveryTransport } from '../lib/host-dispatch.ts';
import { openCodeManagedIgnorePatterns, ompManagedIgnorePatterns } from '../lib/source-control.ts';

// Same literal `steering.ts` writes into every managed Claude agent file
// (retired grid cell or legacy per-dial); not exported there, so duplicated
// here rather than reaching into that module's internals. Already duplicated
// independently by `setup.ts`'s codex equivalent and the dispatch-steering
// hook, so one more read-only copy is consistent with the existing pattern.
// (Grid cells carry a narrower marker, and `listRetiredClaudeGridCells` —
// which steering.ts DOES export — is the single definition of that one.)
const CLAUDE_MANAGED_MARK = '<!-- fadeno:managed';

/**
 * What a frozen broker's own text proves about its resolver contract.
 *
 * The point is to say only what was read. Staleness used to be inferred from
 * the file being unrefreshable — plausible, and wrong here: this repo's own
 * frozen copies still carry `--prompt-file`. So the flags are checked, and
 * the sentence differs depending on what is actually missing.
 */
function describeContractDrift(items: Array<{ name: string; missingFlags: string[] }>): string {
  const drifted = items.filter((item) => item.missingFlags.length > 0);
  if (drifted.length === 0) {
    return 'Each one still passes the resolver flags this build expects, so nothing is broken yet — ' +
      'but frozen text cannot follow the contract, and nothing here will say so when it moves.';
  }
  const named = drifted
    .map((item) => `${item.name} omits ${item.missingFlags.join(' and ')}`)
    .join('; ');
  return `${named} — so \`steering resolve\` is invoked without ${
    drifted.some((item) => item.missingFlags.includes('--prompt-file'))
      ? 'the prompt bytes it hashes to decide whether a spawn is paired, dropping this repo out of shadow pairing'
      : 'the proof of the effort its agent was materialized at, defeating mismatch detection'
  }.`;
}

export class DoctorError extends Error {}

export type FindingSeverity = 'ok' | 'warning' | 'error';

export interface DoctorFinding {
  check: string;
  severity: FindingSeverity;
  detail: string;
  remediation?: string;
}

export interface DoctorOptions extends StatusOptions {
  target?: 'codex' | 'claude' | 'opencode' | 'omp' | null;
  /** Injectable for tests; defaults to the real process environment. */
  processEnv?: NodeJS.ProcessEnv;
  /**
   * Spawn each dialed harness's `models_command` and report a dialed model the
   * backend no longer lists (`fadeno doctor --probe-models`). Off by default:
   * every other check in doctor reads files, and this one runs vendor CLIs.
   */
  probeModels?: boolean;
}

export interface DoctorResult {
  repoRoot: string;
  findings: DoctorFinding[];
  ok: boolean;
}

function finding(check: string, severity: FindingSeverity, detail: string, remediation?: string): DoctorFinding {
  return remediation ? { check, severity, detail, remediation } : { check, severity, detail };
}

function commandOnPath(command: string): boolean {
  const candidates = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? ['']
    : (process.env.PATH ?? '').split(delimiter);
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const directory of candidates) {
    const base = directory === '' ? command : join(directory, command);
    for (const suffix of suffixes) {
      const path = suffix !== '' && !base.toUpperCase().endsWith(suffix.toUpperCase()) ? `${base}${suffix}` : base;
      try {
        accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // Try the next PATH/PATHEXT candidate without executing repo code.
      }
    }
  }
  return false;
}

/**
 * The Claude plugin surface this session loaded, and the version it declares.
 */
export function pluginSurface(env: NodeJS.ProcessEnv): { root: string; version: string | null } | null {
  const candidates: string[] = [];
  const explicit = env.CLAUDE_PLUGIN_ROOT;
  if (typeof explicit === 'string' && explicit.length > 0) candidates.push(explicit);
  for (const entry of (env.PATH ?? '').split(delimiter)) {
    if (entry.endsWith(`${sep}bin`)) candidates.push(dirname(entry));
  }
  for (const root of candidates) {
    try {
      const parsed = JSON.parse(
        readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'),
      ) as { name?: unknown; version?: unknown };
      if (parsed.name !== 'fadeno') continue; // another plugin's bin on PATH
      return { root, version: typeof parsed.version === 'string' ? parsed.version : null };
    } catch {
      // Not a plugin root, or an unreadable manifest — try the next candidate.
    }
  }
  return null;
}

/** Read-only health checks; warnings never turn into a failing exit status. */
export function runDoctor(opts: DoctorOptions = {}): DoctorResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const findings: DoctorFinding[] = [];
  // The writability loop below asks only whether the state locations can be
  // written; whether what is already IN them is a shape this build can read is
  // the adjacent question. One closure, called from exactly one of two places
  // — here on the ordinary path, or from the status `catch` before it returns
  // — so the inventory is reported on EVERY invocation and never twice.
  //
  // Always on and read-only: the audit parses, it never rewrites. `fadeno
  // setup` is the only thing that migrates, and the `warning` text says so.
  const persistedStateFindings = (): DoctorFinding[] => {
    try {
      return auditPersistedState({ repoRoot, paths: userPaths(opts.userPathOptions ?? {}) });
    } catch (err) {
      // The audit is a diagnostic; it must not be the thing that fails doctor.
      return [finding(
        'persisted-state',
        'warning',
        `the persisted-state inventory could not be audited: ${(err as Error).message}`,
        'Report this — every surface in the inventory is read defensively, so reaching here is a bug in the audit itself.',
      )];
    }
  };
  let status;
  try {
    status = runStatus(opts);
    findings.push(finding('runtime', 'ok', `Fadeno ${status.version} and bundled definitions are available.`));
    // Directional runtime findings
    const skew = (status.runtime as any).skew as 'managed-older' | 'managed-newer' | 'divergent' | null;
    const managedV = status.runtime.managedVersion;
    const invokingV = status.version;
    const managedPath = status.runtime.managedPath;
    const preferredCli = (status.runtime as any).preferredCli as string;
    const preferredReason = (status.runtime as any).preferredReason as string | null;
    // runtime-source finding (kept for compatibility but directional)
    findings.push(finding('runtime-source', 'ok', `${status.runtime.invocationSource}; managed runtime ${managedV ?? 'not installed'}`));
    if (managedV == null) {
      if (status.runtime.installedHarnesses.length > 0 || managedPath) {
        findings.push(finding('runtime', 'warning', `managed runtime not installed but host integrations reference ${managedPath ?? 'a managed path'}`, 'Run fadeno setup --from <bin-dir> to install it.'));
      }
    } else if (skew === 'managed-older') {
      const harnessFlag = status.runtime.installedHarnesses.length === 1
        ? ` --${status.runtime.installedHarnesses[0]}`
        : status.runtime.installedHarnesses.includes('codex') && status.runtime.installedHarnesses.includes('claude')
          ? (status.harness === 'claude' || status.harness === 'codex' ? ` --${status.harness}` : ' --codex')
          : status.runtime.installedHarnesses.includes('claude') ? ' --claude' : status.runtime.installedHarnesses.includes('codex') ? ' --codex' : '';
      const dir = preferredCli ? dirname(preferredCli) : '<bin-dir>';
      const remediation = `refreshes at next plugin-launched command, or run fadeno setup${harnessFlag} --from ${dir} (e.g. fadeno setup${harnessFlag} --from ${dir})`;
      findings.push(finding('runtime-version', 'warning', `managed runtime ${managedV} is older than this CLI ${invokingV} (managed-older); ${preferredReason ?? ''}`, remediation));
    } else if (skew === 'managed-newer') {
      findings.push(finding('runtime-version', 'warning', `managed runtime ${managedV} is newer than this CLI ${invokingV} (managed-newer); ${preferredReason ?? ''}`, 'Update this CLI via your package manager — do not rerun setup from this older CLI.'));
    } else if (skew === 'divergent') {
      findings.push(finding('runtime-version', 'warning', `managed runtime ${managedV} differs from caller ${invokingV} (divergent)`, `Run fadeno status to see preferred CLI: ${preferredCli}`));
    }
    // Detect missing source
    try {
      const manifest = readInstallationManifest(opts.userPathOptions);
      if (manifest.runtime?.source && !existsSync(manifest.runtime.source)) {
        findings.push(finding('runtime-source-missing', 'warning', `managed runtime source ${manifest.runtime.source} no longer exists (version-keyed cache may have moved)`, 'Plugin-launched commands still refresh via their bundled runtime; a direct managed-CLI invocation cannot heal until the source reappears.'));
      }

      // Unstamped marker
      const upaths = userPaths(opts.userPathOptions);
      const pkgPath = join(upaths.managedRuntimeDir, 'package.json');
      if (managedV != null && !existsSync(pkgPath)) {
        findings.push(finding('runtime-unstamped', 'warning', `managed runtime at ${upaths.managedRuntimeDir} has no version marker (installed by a build older than 0.6.0-rc.33); refresh to stamp it`, 'Run fadeno setup --from <bin-dir> to add the marker.'));
      }
    } catch {}
    // Preferred CLI guidance
    if (preferredReason) {
      findings.push(finding('preferred-cli', 'ok', `use: ${preferredCli} (${preferredReason})`));
    } else if (managedV != null && managedV === invokingV) {
      findings.push(finding('preferred-cli', 'ok', `use: ${preferredCli} (managed runtime matches this CLI)`));
    }
    // Session definitions - always state that current-session skills require fresh session
    findings.push(finding('session-definitions', 'ok', `Skills and subagents are loaded at host session start; a fresh session is required to refresh them — no setup or refresh will update the current session. Compare the [fadeno ...] stamp in your skill/agent listing against ${invokingV}.`));
  } catch (err) {
    // The status path throws for exactly the reasons the persisted-state
    // inventory exists to explain — a dials file or a repo pin stamped with a
    // version this build refuses is one of them — and returning here reported
    // a bare `configuration` error while suppressing the finding that names
    // the surface, the backup directory, and what to do about it. So the
    // audit runs on the failure path too, BEFORE the early return. The
    // generic error is kept beside it: the status failure is real, and the
    // audit is a diagnostic, not a replacement diagnosis.
    findings.push(finding('configuration', 'error', (err as Error).message, 'Fix the malformed YAML or missing catalog before running a playbook.'));
    findings.push(...persistedStateFindings());
    return { repoRoot, findings, ok: false };
  }
  const paths = [join(repoRoot, '.fadeno'), join(repoRoot, '.fadeno', 'runs'), join(repoRoot, '.fadeno', 'progress')];
  for (const path of paths) {
    try {
      if (existsSync(path)) accessSync(path, constants.W_OK);
      findings.push(finding(`path:${path}`, 'ok', existsSync(path) ? 'writable' : 'will be created lazily'));
    } catch {
      findings.push(finding(`path:${path}`, 'error', 'not writable', 'Choose a writable repository or state location.'));
    }
  }
  // The inventory belongs beside the writability loop above: can these
  // locations be written, and is what is already in them readable.
  findings.push(...persistedStateFindings());
  const dials = (status as any).dials as { session: Record<string, unknown>; repo: Record<string, unknown>; user: Record<string, unknown> } | undefined;
  const legacyNote = (status as any).legacy_pin_note as string | null | undefined;
  if (dials) {
    const sessionCount = Object.keys(dials.session).length;
    const userCount = Object.keys(dials.user).length;
    const repoCount = Object.keys(dials.repo).length;
    const detail = `${sessionCount} session dial(s), ${userCount} user dial(s)${repoCount ? `, ${repoCount} repo pin(s)` : ''}`;
    findings.push(finding('dials', 'ok', detail));
    if (legacyNote) findings.push(finding('dials', 'warning', `legacy pin: ${legacyNote}`, 'Run `fadeno dial clear` then re-dial with `fadeno dial`'));
    // A misspelled `archetypes:` key is invisible everywhere else: the posture
    // it declares attaches to an archetype nothing dispatches, and the REAL
    // archetype silently has no posture at all — `explainWriteConflict`
    // returns null for an archetype the catalog never declares, so a
    // write-required task runs on a read-only lane and exits 0. It cannot be
    // refused (an archetype with no declared posture is perfectly legal), so
    // it is linted: a declared archetype that nothing dials and that is not
    // one of the built-in three is almost always a typo for one that is.
    try {
      const { profile } = loadLayeredProfile(repoRoot, (opts as { userPathOptions?: Parameters<typeof loadLayeredProfile>[1] }).userPathOptions ?? {});
      const referenced = new Set<string>([
        // Every archetype Fadeno itself ships. A typo lands in a project or
        // user layer, never in the built-in catalog, so treating the shipped
        // names as referenced is what keeps this lint from firing on Fadeno's
        // own `director` policy.
        ...ARCHETYPE_DISPLAY_ORDER,
        ...Object.keys(profile.dials ?? {}),
        ...Object.keys(dials.session), ...Object.keys(dials.user), ...Object.keys(dials.repo),
      ]);
      const orphans = Object.keys(profile.archetypes).filter((a) => !referenced.has(a)).sort();
      if (orphans.length > 0) {
        findings.push(finding(
          'archetype-policy-unreferenced',
          'warning',
          `catalog declares archetype policy for ${orphans.map((o) => `"${o}"`).join(', ')}, which nothing dials — ` +
            'if that is a typo, the archetype it was meant for has NO declared write posture and its guard is silently off',
          `Check the \`archetypes:\` keys in .fadeno/executors.yaml against the archetypes you actually dispatch.`,
        ));
      }
    } catch {
      // A catalog that will not load is already reported by other findings;
      // this lint must never be the thing that fails doctor.
    }
  } else if ((status as any).activeLoadout == null) {
    findings.push(finding('dials', 'error', 'no dials resolved', 'Run `fadeno dial <archetype> <model>`'));
  } else {
    findings.push(finding('dials', 'ok', `${(status as any).activeLoadout.name} (${(status as any).activeLoadout.source})`));
  }

  // Catalog layering. A self-contained project catalog is a supported mode and
  // a one-way ratchet: it suppresses the builtin and user layers, so from that
  // moment it can only fall behind the builtin shipped beside it. Nothing said
  // so before — this repo's own catalog sat 25 `timeout_ms` declarations, a
  // stale relay, and the whole `tools:` block behind the template in the same
  // checkout while doctor reported zero warnings.
  {
    let suppressed: { missing: string[] } | null = null;
    try {
      suppressed = explainSuppressedBuiltin(repoRoot, opts.userPathOptions ?? {});
    } catch {
      suppressed = null;
    }
    if (suppressed != null) {
      const missing = suppressed.missing;
      if (missing.length === 0) {
        findings.push(finding(
          'catalog-layering',
          'ok',
          'project catalog is self-contained (suppresses the builtin and user layers) and omits no builtin declaration',
        ));
      } else {
        const shown = missing.slice(0, 6).join(', ');
        const rest = missing.length > 6 ? `, +${missing.length - 6} more` : '';
        findings.push(finding(
          'catalog-layering',
          'warning',
          `project catalog is self-contained (suppresses the builtin and user layers) and omits ` +
            `${missing.length} declaration(s) the builtin makes: ${shown}${rest}`,
          'Either re-declare them, or — usually better — delete everything from ' +
            '`.fadeno/executors.yaml` that is not a deliberate override. Without its own `models:` ' +
            'and `harnesses:` the file layers on the builtin instead of replacing it, and cannot fall ' +
            'behind again. Note this reports ABSENCES only: a stale VALUE is indistinguishable from ' +
            'a deliberate override and is not checked.',
        ));
      }
    }
  }

  // Catalog version. A `schema_version: 3` layer still LOADS — a personal
  // `models:`-only catalog is not made wrong by the v4 bump — but it is also
  // frozen out of everything v4 added, and it will start failing the moment
  // someone edits it toward `harnesses:`. Say so once, here, rather than
  // letting the first edit produce the migration error with no warning that
  // the file was old.
  for (const layer of catalogLayerVersions(repoRoot, opts.userPathOptions ?? {})) {
    if (layer.schemaVersion === 4) continue;
    findings.push(finding(
      'catalog-version',
      'warning',
      `${layer.path} declares schema_version ${layer.schemaVersion ?? '(absent)'}; catalog v4 is current`,
      'It still loads because it declares none of the keys v4 removed (`routes`, `relay`, ' +
        '`unregistered_model_driver`, a model `delivery:`, a ` via ` in a dial). Bump it to ' +
        '`schema_version: 4` when you next edit it — see docs/experimental/harness-neutral-dials.md.',
    ));
  }

  // --- Catalog rot ---
  //
  // Two silent decays, both of which leave every command reporting success.
  //
  // The USER catalog is machine state (`fadeno model add` wrote it, possibly
  // under a fadeno two versions old), so `config-layers.ts` reads that one
  // layer tolerantly rather than failing the load — `repairUserLayer`
  // translates what it can before the merge, `dropUndeliverableUserModels`
  // discards what it must after it. That is right, and it is silent: only
  // `fadeno dial` on a SELF-CONTAINED catalog ever printed the note (via
  // `formatModelFallbackNote`), so on the ordinary layering path an alias
  // simply vanishes and the first symptom is a dial that fails naming a model
  // the user is sure they added.
  //
  // The verification cache never expires. `isModelVerified` is an existence
  // check with no notion of age, so a row written a year ago short-circuits
  // the probe forever while the provider quietly retires the id.
  //
  // Read-only and best-effort throughout: a catalog that will not load is
  // already reported by `configuration`, and neither check may be the thing
  // that fails doctor.
  {
    let layered: ReturnType<typeof loadLayeredProfile> | null = null;
    try {
      layered = loadLayeredProfile(repoRoot, opts.userPathOptions ?? {});
    } catch {
      layered = null;
    }
    if (layered != null) {
      const fallback = layered.modelFallback;
      findings.push(...catalogRepairFindings({
        repairs: fallback.repairs,
        // `dropped` is structured (`{ alias, harness }`); phrase it the way
        // `formatModelFallbackNote` does so the two surfaces cannot drift into
        // describing the same event differently.
        drops: fallback.dropped.map((drop) =>
          `user-catalog model "${drop.alias}" dropped — nothing in this catalog can deliver ` +
          `harness/provider "${drop.harness}"`),
      }));

      // EVERY resolved dial, through the same `resolveRole` cascade `status`
      // uses for its role table — the dial layers are exactly `status.dials`.
      //
      // The archetype set is the union of four sources, not three: the canon
      // display order, the three stored dial layers, AND the CATALOG's own
      // `dials:` mapping. That last one is easy to miss and is the whole
      // reason a custom archetype can rot invisibly — a project catalog that
      // declares `dials: {integrator: sol}` names an archetype no stored layer
      // mentions, so a set built from `status.dials` alone never resolves it
      // and never audits it. An archetype declared only in `archetypes:`
      // policy and dialed by nothing is a different finding
      // (`archetype-policy-unreferenced`, above).
      const layers = status.dials;
      const archetypeNames = new Set<string>([
        ...ARCHETYPE_DISPLAY_ORDER,
        ...Object.keys(layers.session), ...Object.keys(layers.repo), ...Object.keys(layers.user),
        ...Object.keys(layered.profile.dials),
      ]);
      // `listable` travels with each dial: the staleness audit covers the
      // whole set and only WORDS itself differently for a harness nothing can
      // probe, while the listing probe below is the part that is genuinely
      // restricted to listable harnesses (it spawns; there is nothing to
      // spawn). Two different questions, one dial set.
      const dialed: Array<{ archetype: string; harness: string; modelId: string; listable: boolean }> = [];
      for (const archetype of [...archetypeNames].sort()) {
        let harness: string | null;
        let modelId: string;
        try {
          const resolved = resolveRole(archetype, archetype, layered.profile, layers);
          harness = resolved.delivery.harness;
          modelId = resolved.delivery.modelId;
        } catch {
          continue; // an undeclared harness is a different finding's problem
        }
        // `current-host` names whatever session is running: it has no
        // provider-facing id, appears in no backend listing, and is never
        // cached, so both checks skip it exactly as `probeModel` does. A
        // host-native dial is not an unverified model, it is a model-free dial.
        if (harness == null || modelId === 'current-host') continue;
        dialed.push({ archetype, harness, modelId, listable: isListable(layered.profile.harnesses?.[harness]) });
      }
      // A `timeout_ms` the loader accepted and will never arm. Warned about
      // rather than refused: catalogs written before deadlines were removed
      // declare it, and a load-time refusal would break every command over a
      // key that now does nothing.
      findings.push(...ignoredDeadlineFindings(layered.profile.notes, IGNORED_DEADLINE_NOTE_TOKEN));
      findings.push(...verificationFindings({
        dialed,
        verifications: readVerifiedModels(opts.userPathOptions ?? {}),
        now: new Date(),
        // `fadeno models verify` re-probes every dialed pair with the cache
        // ignored (`force: true`), refreshing a row that still lists and
        // deleting one that does not — so it is the remediation for BOTH the
        // missing and the stale case. `fadeno dial`'s own probe only fires on
        // a cache miss, which is why it is not named here. For an unlistable
        // harness the library says so instead of naming it.
        verifyCommand: '`fadeno models verify`',
        verificationsPath: userPaths(opts.userPathOptions ?? {}).modelVerificationsFile,
      }));
      // The listing check answers the other half of the same question — not
      // "when was this last confirmed" but "is it in the listing right now" —
      // so it runs against the same `dialed` set, restricted to the harnesses
      // that can actually be listed, behind its flag.
      //
      // Behind a flag because it is the only part of doctor that SPAWNS: one
      // vendor CLI per dialed harness, each up to `LISTING_TIMEOUT_MS`. A
      // read-only diagnostic that shells out by default is not read-only in
      // the sense users mean, so the default reports the flag instead.
      const probeable = dialed.filter((dial) => dial.listable);
      if (opts.probeModels === true) {
        const probeHarnesses = [...new Set(probeable.map((dial) => dial.harness))].sort();
        const listings = probeHarnesses
          .map((harness) => ({ harness, entry: layered.profile.harnesses?.[harness] ?? null }))
          .filter((item) => isListable(item.entry))
          .map((item) => ({ harness: item.harness, result: listHarnessModels(item.harness, item.entry!) }));
        findings.push(...listingFindings({ dialed: probeable, listings }));
      } else if (probeable.length === 0) {
        // Two facts, and the finding owes the reader both: nothing here is
        // probeable, AND the flag that would probe it is `--probe-models`.
        // Saying only the first leaves someone who dials a listable harness
        // tomorrow with no way to learn the check exists — and the contract
        // makes naming the flag unconditional for exactly that reason. So the
        // honest sentence stays in `detail` and the flag moves into
        // `remediation`, worded as what it would do here rather than as a
        // suggestion to run something that would find nothing today.
        findings.push(finding(
          'model-listing-skipped',
          'ok',
          'no dialed model resolves onto a harness that declares a models_command, so there is no backend listing to check it against.',
          '`fadeno doctor --probe-models` runs this check; it has nothing to spawn until a dialed model resolves onto a harness that declares a models_command.',
        ));
      } else {
        findings.push(finding(
          'model-listing-skipped',
          'ok',
          `${probeable.length} dialed model(s) were not checked against their harness listings; that check spawns each harness's models_command.`,
          'Run `fadeno doctor --probe-models` to list every dialed harness and report a model its backend no longer names.',
        ));
      }
    }
  }

  for (const role of status.roles) {
    const spec = role.adapter === 'command' ? status.external.find((item) => item.archetype === role.archetype) : null;
    if (spec == null || spec.command == null) continue;
    if (!commandOnPath(spec.command[0]!)) {
      findings.push(finding(`executor:${role.executor}`, 'warning', `${role.command?.[0] ?? role.executor} is unavailable`, 'Install the provider CLI or select a host executor explicitly; Fadeno will not fall back automatically.'));
    } else {
      findings.push(finding(`executor:${role.executor}`, 'ok', 'executable is present on PATH (not executed)'));
    }
  }
  const ambient = detectAmbientHarness(opts.userPathOptions);
  if (ambient.evidence.length > 1) {
    const names = ambient.evidence.map((item) => `${item.harness} (${item.marker})`).join(' and ');
    findings.push(finding(
      'harness',
      'warning',
      `nested hosts both claim this session — ${names} — so detection abstained and this call compiled as ${status.harness ?? 'standalone'}`,
      'Set FADENO_HARNESS explicitly for this session; a spawned executor gets its own identity automatically.',
    ));
  } else if (ambient.harness == null) {
    // With no marker, the only way to be anything but standalone is an
    // explicit FADENO_HARNESS — there is no stored default to fall back on.
    const resolved = status.harness ?? 'standalone';
    findings.push(finding(
      'harness',
      'ok',
      resolved === 'standalone'
        ? 'standalone; not inside a harness, so no host lane is compiled here'
        : `${resolved}; no host claims this session, so an explicit setting selected it`,
    ));
  } else if (status.harness === ambient.harness) {
    findings.push(finding('harness', 'ok', `${ambient.harness}, detected from the host this session is running inside`));
  } else {
    findings.push(finding(
      'harness',
      'warning',
      `${ambient.evidence[0]!.marker} says this session runs inside ${ambient.harness}, but an explicit setting selected ${status.harness}`,
      `Drop the override to route as ${ambient.harness}; the two compile different adapters for the same slot.`,
    ));
  }
  if (status.codexMaterialization?.restartRequired) {
    // Same filter as `status`'s own `fresh`: anything that is not `current` or
    // `not_applicable` needs saying, including the two verdicts about the
    // file's standing rather than its identity (`unmanaged`, `shadowed`).
    const drifted = status.codexMaterialization.agents.filter(
      (agent) => agent.status !== 'current' && agent.status !== 'not_applicable',
    );
    const detail = drifted.map(describeCodexAgentIdentityRow).join('; ');
    findings.push(finding(
      'codex-agents',
      'warning',
      // The header names the managed user-scope directory; a row that was
      // judged elsewhere names its own file, which is why the describer prints
      // the path for every scope but that one.
      `the agents Codex would load for the role slots are missing or stale (managed set in ${status.codexMaterialization.path})${detail === '' ? '' : ` — ${detail}`}`,
      // One remediation, printed from where it is defined: `status`, `dial` and
      // `doctor` re-spelling it separately is how the three drift apart.
      `${status.codexMaterialization.remediation ?? CODEX_IDENTITY_REMEDIATION}.`,
    ));
  } else if (status.codexMaterialization != null) {
    findings.push(finding('codex-agents', 'ok', 'managed host-agent state is current'));
  }
  // OpenCode materializes one selected lane per role plus three refusal
  // brokers. Unlike Codex's user-scoped TOMLs, these files are project-local
  // and can be silently shadowed by a foreign file at the same path, so
  // status/doctor inspect ownership, frontmatter, version, and the digest
  // stamped into every managed agent. The plugin has the same ownership and
  // version checks plus a digest stamped over its generated JS body.
  if (status.opencodeMaterialization != null) {
    const materialized = status.opencodeMaterialization;
    if (materialized.healthy) {
      findings.push(finding('opencode-steering', 'ok', 'managed OpenCode agents and runtime plugin are current and internally consistent'));
    } else {
      for (const issue of materialized.issues) {
        const remediation = issue.kind === 'missing'
          ? 'Run `fadeno steering apply --opencode --force`, then restart OpenCode.'
          : issue.kind === 'unmanaged'
            ? 'Move or remove the foreign file, or replace it deliberately with `fadeno steering apply --opencode --force`; never edit a managed file in place.'
            : issue.kind === 'malformed'
              ? 'Run `fadeno steering apply --opencode --force`, then restart OpenCode.'
              : issue.kind === 'stale-version' || issue.kind === 'digest-drifted'
                ? 'Refresh with `fadeno steering apply --opencode --force`, then restart OpenCode.'
                : 'Keep only the lane selected by `fadeno status --opencode`; refresh with `fadeno steering apply --opencode --force`.';
        findings.push(finding(`opencode-${issue.kind}`, 'warning', `${issue.detail} (${issue.path})`, remediation));
      }
    }
  }
  if (status.ompMaterialization != null) {
    const materialized = status.ompMaterialization;
    if (materialized.healthy) {
      findings.push(finding('omp-steering', 'ok', 'managed omp agents and runtime extension are current and internally consistent'));
    } else {
      for (const issue of materialized.issues) {
        const remediation = issue.kind === 'missing'
          ? 'Run `fadeno steering apply --omp --force`, then restart omp.'
          : issue.kind === 'unmanaged'
            ? 'Move or rename the foreign file, then run `fadeno steering apply --omp`; Fadeno preserves unmarked files.'
            : issue.kind === 'contradictory'
              ? 'Keep only the lane selected by `fadeno status --omp`; refresh with `fadeno steering apply --omp --force`.'
              : 'Refresh with `fadeno steering apply --omp --force`, then restart omp.';
        findings.push(finding(`omp-${issue.kind}`, 'warning', `${issue.detail} (${issue.path})`, remediation));
      }
    }
  }
  // --- Project-scope Codex brokers shadowing the user-scope ones ---
  //
  // Codex resolves a role agent from `<repo>/.codex/agents/<archetype>.toml`
  // in preference to `$CODEX_HOME/agents/fadeno-<archetype>.toml`, so whatever
  // a repo carries at project scope silently outranks what `fadeno setup
  // --codex` maintains at user scope. Older `fadeno init` runs copied frozen
  // brokers out of the templates into project scope and stamped no managed
  // header on them — which is also what stops `steering apply` from ever
  // refreshing them, since project-scope emit is non-destructive and skips an
  // existing file without `--force`.
  //
  // The production symptom is pure silence. A broker frozen before
  // `--prompt-file` / `--host-executor` invokes `steering resolve` without
  // them, so the resolver never sees the prompt bytes it hashes to pair a
  // spawn with a shadow challenger; that repo drops out of shadow pairing
  // entirely and mismatch detection is off, with nothing on disk looking
  // wrong.
  //
  // Read-only, and it separates the states rather than warning on all of them:
  // a project broker with no user counterpart is simply the only broker there
  // is; an unmanaged one that IS shadowing can never be refreshed in place; a
  // managed one stamped older than user scope is a stale copy. Same
  // generation — or a project copy NEWER than user scope, which shadows
  // nothing current — says nothing at all.
  //
  // This family and the `codex-agents` row above are about DIFFERENT
  // questions, and both are worth asking: this one is relational (does a
  // project file override the managed user-scope set?), that one is about the
  // file Codex would actually load (can Fadeno vouch for it, and does its
  // identity match the dial?). They are kept from contradicting each other by
  // sharing their inputs rather than by re-deciding the same facts: the file
  // set comes from `effectiveCodexAgentCandidates` — the one encoding of
  // Codex's project-over-user precedence — and the standing verdict from
  // `codexStandingReason`, read off `codexAgentIdentityRow` itself. A second
  // hand-rolled `!managed` test here is exactly how the two surfaces came to
  // print `ok` and `unmanaged` about the same path.
  {
    const projectDir = join(repoRoot, '.codex', 'agents');
    const userDir = codexUserAgentDir(opts.userPathOptions);
    const soleProject: Array<{ name: string; row: CodexAgentIdentityRow; standing: string | null }> = [];
    const unmanagedShadow: Array<{ name: string; missingFlags: string[] }> = [];
    const staleShadow: Array<{ name: string; label: string }> = [];
    // A candidate at project scope IS "a project file exists for this
    // archetype" — the entry condition this block used to re-derive with its
    // own directory sweep. The user file still has to be read separately,
    // because precedence means the effective set never looks at it.
    for (const candidate of effectiveCodexAgentCandidates(repoRoot, opts.userPathOptions)) {
      if (candidate.scope !== 'project') continue;
      const name = `${candidate.archetype}.toml`;
      const project = candidate.state;
      const user = readCodexAgentFile(join(userDir, `fadeno-${candidate.archetype}.toml`));
      if (user == null) {
        // The REASON, not just the yes/no. A file can now fail to be vouched
        // for in more than one way, and a sentence that names the wrong one is
        // its own wrong answer. One row, read twice, so the verdict this
        // finding branches its remediation on and the clause it prints cannot
        // come apart.
        const row = codexAgentIdentityRow(candidate.archetype, candidate, null);
        soleProject.push({ name, row, standing: codexStandingReason(row) });
      } else if (!project.managed) {
        unmanagedShadow.push({ name, missingFlags: project.missingFlags });
      } else if (
        project.version != null && user.version != null &&
        compareFadenoVersions(project.version, user.version) === -1
      ) {
        staleShadow.push({ name, label: `${name} (${project.version} < ${user.version})` });
      }
    }
    const absolute = (names: string[]): string => names.map((name) => join(projectDir, name)).join(', ');
    if (soleProject.length > 0) {
      // The relational answer — nothing is being shadowed — is `ok` however the
      // file got there, and it stays `ok` so that one file cannot produce two
      // warnings a reader takes for two problems. What it must NOT do is imply
      // more than it read: calling an unmanaged file a "broker" claims a
      // provenance this check never checked, and an unqualified `ok` next to a
      // `codex-agents` warning about the same path is the contradiction. So the
      // sentence names its own limits and hands the file itself to the row that
      // judges it.
      const unvouched = soleProject.filter((item) => item.standing != null);
      const one = unvouched.length === 1;
      // The two ways a sole project file fails to be vouched for want DIFFERENT
      // fixes, and the difference is exactly the one `--force` is about: an
      // unmanaged file is never refreshed by any apply, while an outdated
      // managed one is refreshed in place by an ordinary `--scope project`
      // apply. Printing the unmanaged sentence over an outdated file would send
      // its owner to move a file Fadeno wrote and will happily re-cut.
      const unmanaged = unvouched.filter((item) => item.row.status === 'unmanaged').map((item) => item.name);
      const refreshable = unvouched.filter((item) => item.row.status !== 'unmanaged');
      findings.push(finding(
        'codex-agents-project',
        'ok',
        `project-scope Codex agent file(s) ${soleProject.map((item) => item.name).join(', ')} in ${projectDir} have no user-scope counterpart in ${userDir}, so nothing is being shadowed` +
        (unvouched.length === 0
          ? ''
          // The clause names each file's OWN standing rather than asserting one
          // reason for all of them: until 2026-09-06 `unmanaged` was the only
          // way to be unvouched, and this sentence hardcoded "carries no
          // managed header" — which becomes a false statement about a managed
          // file the moment a second standing verdict exists.
          : ` — which is all this check reads. ${unvouched.map((item) => `${item.name} ${item.standing}`).join('; ')}, so this \`ok\` is not a clean bill of health for ${one ? 'that file' : 'those files'}; whether Codex would load something Fadeno can vouch for is the \`codex-agents\` check's question, answered there whenever Codex is a maintained harness`),
        'Codex prefers project scope: once `fadeno setup --codex` materializes managed user-scope brokers, these files would win over them' +
        // The forward-looking half is still true, but on its own it implies
        // the unmanaged file is an ordinary managed one that would simply
        // win. It would win and never be refreshable, so the fix for that is
        // printed from where it is defined rather than re-spelled here.
        (unmanaged.length === 0
          ? ''
          : ` — and \`fadeno steering apply\` would never refresh the unmanaged one${unmanaged.length === 1 ? '' : 's'}. To hand ${unmanaged.length === 1 ? 'that slot' : 'those slots'} back, ${CODEX_UNMANAGED_IDENTITY_REMEDIATION}`) +
        // And the fix for everything else, chosen by the one mapping that owns
        // "which apply spelling reaches this file".
        (refreshable.length === 0
          ? '.'
          : `. For ${refreshable.map((item) => item.name).join(', ')}, ${codexIdentityRemediation(refreshable.map((item) => item.row))}.`),
      ));
    }
    if (unmanagedShadow.length > 0) {
      findings.push(finding(
        'codex-agents-shadow',
        'warning',
        `${unmanagedShadow.map((item) => item.name).join(', ')} in ${projectDir} carry no managed header, and Codex prefers project scope over the user-scope broker(s) in ${userDir} — so the unmanaged copy is what every session loads, and no ordinary \`fadeno steering apply --codex\` or \`fadeno init\` refreshes it in place, because project-scope emit only ever refreshes a file carrying the managed header. ${describeContractDrift(unmanagedShadow)}`,
        `Delete ${absolute(unmanagedShadow.map((item) => item.name))} so the user-scope broker takes over — or, to keep project scope deliberately, run \`fadeno steering apply --codex --scope project --force\`, which rewrites the content and stamps the managed header, clearing this finding.`,
      ));
    }
    if (staleShadow.length > 0) {
      findings.push(finding(
        'codex-agents-shadow-stale',
        'warning',
        `${staleShadow.map((item) => item.label).join(', ')} in ${projectDir} are managed but stamped older than the user-scope broker(s) in ${userDir}, and Codex prefers project scope — so the older generation is what every session actually loads`,
        `Delete ${absolute(staleShadow.map((item) => item.name))} so the current user-scope broker takes over, or run \`fadeno steering apply --codex --scope project\` to bring the project copy up to this build — a managed project file is refreshed in place.`,
      ));
    }
  }
  // --- Command-fallback dispatches a native agent could have delivered ---
  //
  // A top-level coordinator session is not itself a materialized Codex role
  // agent, so its own `steering resolve` call always passes no
  // `--host-executor` and can only ever land on `mode=command` or
  // `mode=restart_required` for a locked engine request — never `mode=host`,
  // even when a role agent cut for that exact executor/model/effort sits
  // right there in `.codex/agents/`. The resolver now says so via
  // `delegate_to`, but an advisory nobody reads is invisible; this check is
  // the tripwire that makes the drift visible after the fact, scanning the
  // one most recent run rather than the whole `.fadeno/runs/` history to stay
  // cheap.
  try {
    const latestRun = listRuns(repoRoot)[0];
    if (latestRun != null) {
      const { events } = readEvents(latestRun.dir);
      const fallbackRows = events.filter((event) =>
        event.type === 'actor_dispatched' &&
        normalizeDeliveryTransport(event.extra.delivery_transport) === 'command-fallback',
      );
      if (fallbackRows.length > 0) {
        const candidates = effectiveCodexAgentCandidates(repoRoot, opts.userPathOptions);
        const avoidableExecutors = new Set<string>();
        let avoidableCount = 0;
        for (const row of fallbackRows) {
          const executor = typeof row.extra.executor === 'string' ? row.extra.executor : null;
          if (executor == null) continue;
          // `agent_type` is the role slot the row had to be claimed as; `*` is
          // the immutable wildcard, where any declared role surface could have
          // taken it. Only an agent whose FILE carries this row's snapshotted
          // model and effort could have delivered it, since on Codex the file
          // is what runs (see `findSpawnableCodexAgent`); one carrying
          // anything else would have run that instead, and counting it would
          // report a fallback as "avoidable" when the only alternative was a
          // silent identity substitution. The baked host executor matters for
          // its own reason — a broker (none) or an agent for another executor
          // would resolve recursively.
          //
          // A row that names no model or effort cannot answer the question at
          // all, and an advisory does not guess.
          const agentType = typeof row.extra.agent_type === 'string' ? row.extra.agent_type : null;
          const model = typeof row.extra.model === 'string' ? row.extra.model : null;
          const reasoningEffort =
            typeof row.extra.reasoning_effort === 'string' ? row.extra.reasoning_effort : null;
          if (model == null || reasoningEffort == null) continue;
          if (findSpawnableCodexAgent(candidates, agentType, executor, { model, reasoningEffort }) == null) continue;
          avoidableCount += 1;
          avoidableExecutors.add(executor);
        }
        if (avoidableCount > 0) {
          findings.push(finding(
            'codex-agents-fallback-avoidable',
            'warning',
            `${avoidableCount} engine dispatch(es) in the most recent run (${latestRun.runId}) took the command fallback for executor(s) ${[...avoidableExecutors].sort().join(', ')}, even though a managed Codex role agent whose file carries that exact identity is installed and could have delivered them in-host`,
            'Spawn the role agent named in the resolver\'s `delegate_to` and hand it the engine assignment envelope. When the resolver names the installed agent as stale instead, run `fadeno steering apply --codex` and start a fresh Codex session to re-cut it. Otherwise use `fadeno dispatch-fallback`.',
          ));
        }
      }
    }
  } catch {
    // Read-only advisory: a malformed or unreadable run must not fail doctor.
  }
  // --- Retired Claude managed agents ---
  //
  // `fadeno steering apply --claude` no longer WRITES anything. Effort decides
  // the lane now — a host spawn runs at the session's effort, and a pinned
  // effort the session cannot give goes out on the command lane — so there is
  // nothing left for an agent file to pin. Apply's whole job on this surface
  // is removal: the identity grid (`fadeno-<archetype>-<effort>.md`, marked
  // `source=grid:…`) and the legacy per-dial agents it once replaced
  // (`<archetype>.md`, which additionally pin whatever model was dialed the
  // moment they were written).
  //
  // Both linger silently. The harness registers whatever is in the directory
  // at session start, so a survivor keeps overriding what `fadeno dial`
  // reports with no symptom short of the wrong identity actually running —
  // this repo's own dogfooded tree was exactly that. Read-only here, and
  // scoped to files this steering path itself wrote: only a file carrying the
  // managed marker is ever inspected, never a user's own hand-authored agent
  // of the same name.
  {
    const claudeAgentDir = join(repoRoot, '.claude', 'agents');
    for (const name of ['worker.md', 'reviewer.md', 'judge.md']) {
      const path = join(claudeAgentDir, name);
      let text: string;
      try {
        if (!existsSync(path)) continue;
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes(CLAUDE_MANAGED_MARK)) continue; // never report on a hand-written agent
      const modelMatch = /^model:\s*(.+)$/m.exec(text);
      const model = modelMatch ? modelMatch[1]!.trim() : 'unknown';
      findings.push(finding(
        'claude-agents-legacy',
        'warning',
        `${name} is a legacy per-dial managed agent pinning model "${model}" — it silently overrides whatever \`fadeno dial\` currently resolves for this archetype`,
        'Run `fadeno steering apply --claude` to remove it; the plugin\'s role agents deliver the dial live.',
      ));
    }
    const retiredGrid = listRetiredClaudeGridCells(claudeAgentDir);
    if (retiredGrid.length > 0) {
      findings.push(finding(
        'claude-agents-grid',
        'warning',
        `${retiredGrid.length} retired identity-grid cell(s) remain in ${claudeAgentDir} (${retiredGrid.map((path) => basename(path)).slice(0, 3).join(', ')}${retiredGrid.length > 3 ? ', …' : ''}) — ` +
          'they pin an effort nothing consults any more, and the harness still registers them at session start',
        'Run `fadeno steering apply --claude` to remove them.',
      ));
    }
  }
/**
 * Template files that exist in this CLI's own `templates/` tree and are absent
 * from a plugin's bundled `bin/templates` snapshot.
 *
 * The bundle is generated by `npm run build:bin`, which is NOT run by a version
 * bump — so a file added to `templates/` after the last build ships nowhere,
 * at a version that matches perfectly. Deliberately one-directional: an EXTRA
 * file in the bundle is stale residue and worth its own check, but a MISSING
 * one breaks a command outright, which is the failure this exists to catch.
 *
 * Scoped to `common/fadeno`, where the schemas and catalog live — the files a
 * command reads at runtime, as opposed to definitions the harness loads.
 */
function missingBundledTemplates(pluginRoot: string): string[] {
  const relDir = join('common', 'fadeno');
  const source = join(templatesDir(), relDir);
  const bundled = join(pluginRoot, 'bin', 'templates', relDir);
  if (!existsSync(source) || !existsSync(bundled)) return [];
  const walk = (dir: string, prefix: string, out: string[]): string[] => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return out;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(abs, `${prefix}${entry}/`, out);
      else out.push(`${prefix}${entry}`);
    }
    return out;
  };
  const want = walk(source, '', []);
  return want.filter((rel) => !existsSync(join(bundled, rel))).sort();
}

  const surface = pluginSurface(opts.processEnv ?? process.env);
  if (surface != null) {
    if (surface.version == null) {
      findings.push(finding('plugin-surface', 'warning', `the plugin at ${surface.root} declares no version`, 'Regenerate it with `fadeno plugin` so evidence rows can name the build that wrote them.'));
    } else if (surface.version !== status.version) {
      findings.push(finding(
        'plugin-surface',
        'warning',
        `hooks and subagents load from plugin ${surface.version} (${surface.root}), but this CLI is ${status.version}`,
        'Restart the harness so both halves are the same build; dispatch rows record the version that actually ran under `fadeno_version`.',
      ));
    } else {
      // Version equality is NOT content equality, and this finding used to
      // claim the stronger one. `bakeoff.schema.json` shipped in
      // templates/ and was absent from both bundled `bin/templates` snapshots
      // for five commits at the SAME version — so `fadeno bakeoff` from a
      // managed runtime failed with "no model-comparison schema available"
      // while doctor reported a match. A check must not assert a property it
      // does not test.
      const missing = missingBundledTemplates(surface.root);
      if (missing.length > 0) {
        findings.push(finding(
          'plugin-surface',
          'warning',
          `plugin ${surface.version} is the same version as this CLI but its bundled templates are stale: ` +
            `${missing.length} file(s) present in templates/ and missing from the bundle (${missing.slice(0, 3).join(', ')}` +
            `${missing.length > 3 ? ', …' : ''})`,
          'Regenerate with `npm run build:plugin` and `npm run build:plugin:codex` — a version bump alone does not rebuild the bundle.',
        ));
      } else {
        findings.push(finding(
          'plugin-surface',
          'ok',
          `plugin ${surface.version} matches this CLI, and its bundled templates are complete`,
          `Subagent definitions are still whatever this session loaded at startup — if your agent list stamps a version other than ${status.version}, restart to refresh it.`,
        ));
      }
    }
  }
  const gitignore = join(repoRoot, '.gitignore');
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const ignoreLines = ignored.split(/\r?\n/).map((line) => line.trim());
  const ignorePatterns = [
    '.fadeno/runs/', '.fadeno/progress/', '.fadeno/local/', '.fadeno/dispatches.jsonl',
    '.codex/agents/fadeno-*.toml', '.claude/settings.local.json',
    ...(status.harness === 'opencode' ? openCodeManagedIgnorePatterns(repoRoot) : []),
    ...(status.harness === 'omp' ? ompManagedIgnorePatterns(repoRoot) : []),
  ];
  for (const pattern of ignorePatterns) {
    if (!isFadenoPathIgnored(ignoreLines, pattern)) {
      const remediation = pattern.startsWith('.opencode/')
        ? 'Run `fadeno steering apply --opencode`; it adds ignores only for currently managed OpenCode files.'
        : pattern.startsWith('.omp/')
          ? 'Run `fadeno steering apply --omp`; it adds ignores only for currently managed omp files.'
        : 'The first `new-run`/`dispatch`, `fadeno init`, or `fadeno vendor` adds it non-destructively.';
      findings.push(finding(`ignore:${pattern}`, 'warning', 'managed ignore entry is absent', remediation));
    }
  }
  // The vestigial writer lease.
  //
  // This block used to be the lease's own health check: is the holder running,
  // ended, or unobservable, and should a human `dispatch-fail` it. All of that
  // was in service of a lock that no longer exists, and the most dangerous
  // part of it was the remediation — every branch ended "only after verifying
  // no writer remains", which is correct advice about a live lock and actively
  // harmful about a file nothing reads. A user who dutifully hedged left a
  // wedged repo wedged.
  //
  // What is left is one finding: the file (or its lock directory) is here, it
  // does nothing, delete it. No staleness threshold, no pid probe, no
  // liveness verdict — nothing that requires answering the question the whole
  // mechanism was removed for being unable to answer.
  {
    const vestigial = describeVestigialWorkspaceLease(repoRoot);
    if (vestigial == null) {
      findings.push(finding('workspace-lease', 'ok', 'no leftover writer lease (Fadeno no longer takes one)'));
    } else {
      findings.push(finding('workspace-lease', 'warning', vestigial.detail, vestigial.remediation));
    }
  }
  // What replaced that lease writes an append-only log nothing ever mentioned.
  // A torn line in it degrades every receipt the repo writes from then on, and
  // there was no surface that said the file existed, let alone that it was
  // broken.
  findings.push(...dispatchWindowLogFindings(repoRoot));
  // Leftover overlap baselines: the machine-local snapshots a shared host
  // `dispatch-start` writes so its terminal can compute a real changed set.
  // The logic lives with the state it describes (`workspace-overlap.ts`),
  // beside `describeVestigialWorkspaceLease` in spirit — one push, no reasoning
  // here about what counts as stale.
  findings.push(...overlapSnapshotFindings(repoRoot));
  return { repoRoot, findings, ok: findings.every((item) => item.severity !== 'error') };
}
