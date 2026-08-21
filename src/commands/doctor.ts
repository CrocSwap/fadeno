import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { runStatus, type StatusOptions } from './status.ts';
import { listRetiredClaudeGridCells } from './steering.ts';
import { detectAmbientHarness } from '../lib/executors.ts';
import { loadLayeredProfile } from '../lib/config-layers.ts';
import { findRepoRoot, templatesDir } from '../lib/paths.ts';
import { isFadenoPathIgnored } from '../lib/source-control.ts';
import {
  WORKSPACE_LEASE_FILE,
  WORKSPACE_LEASE_LOCK,
  readEffectiveLease,
  readWorkspaceLease,
} from '../lib/workspace-lease.ts';
import { describeWorkspaceLeaseLiveness } from '../lib/supervisor.ts';
import { explainSuppressedBuiltin } from '../lib/config-layers.ts';
import { compareFadenoVersions, readInstallationManifest } from '../lib/installations.ts';
import { codexUserAgentDir, userPaths } from '../lib/user-paths.ts';
import {
  effectiveCodexAgentCandidates,
  findSpawnableCodexAgent,
  readCodexAgentFile,
  CODEX_STEERING_ARCHETYPES,
} from '../lib/codex-agent-file.ts';
import { listRuns, readEvents } from '../lib/run-ledger.ts';
import { normalizeDeliveryTransport } from '../lib/host-dispatch.ts';

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
  target?: 'codex' | 'claude' | null;
  /** Injectable for tests; defaults to the real process environment. */
  processEnv?: NodeJS.ProcessEnv;
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
/** Compact human duration for a lease hold: "3s", "12m", "1h47m". */
function describeHeld(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`;
}

export function runDoctor(opts: DoctorOptions = {}): DoctorResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const findings: DoctorFinding[] = [];
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
    findings.push(finding('configuration', 'error', (err as Error).message, 'Fix the malformed YAML or missing catalog before running a playbook.'));
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
        'worker', 'reviewer', 'judge',
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
            'and `routes:` the file layers on the builtin instead of replacing it, and cannot fall ' +
            'behind again. Note this reports ABSENCES only: a stale VALUE is indistinguishable from ' +
            'a deliberate override and is not checked.',
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
      `nested hosts both claim this session — ${names} — so detection abstained and ${status.harness ?? 'standalone'} came from the recorded memo`,
      'Set FADENO_HARNESS explicitly for this session; a spawned executor gets its own identity automatically.',
    ));
  } else if (ambient.harness == null) {
    findings.push(finding('harness', 'ok', `${status.harness ?? 'standalone'}; no host claims this session, so the recorded memo decides`));
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
    findings.push(finding(
      'codex-agents',
      'warning',
      `managed host agents are missing or stale in ${status.codexMaterialization.path}`,
      'Run `fadeno setup --codex` to rewrite them; a fresh Codex session picks them up.',
    ));
  } else if (status.codexMaterialization != null) {
    findings.push(finding('codex-agents', 'ok', 'managed host-agent state is current'));
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
  {
    const projectDir = join(repoRoot, '.codex', 'agents');
    const userDir = codexUserAgentDir(opts.userPathOptions);
    const soleProject: string[] = [];
    const unmanagedShadow: Array<{ name: string; missingFlags: string[] }> = [];
    const staleShadow: Array<{ name: string; label: string }> = [];
    for (const archetype of CODEX_STEERING_ARCHETYPES) {
      const name = `${archetype}.toml`;
      const project = readCodexAgentFile(join(projectDir, name));
      if (project == null) continue;
      const user = readCodexAgentFile(join(userDir, `fadeno-${archetype}.toml`));
      if (user == null) {
        soleProject.push(name);
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
      findings.push(finding(
        'codex-agents-project',
        'ok',
        `project-scope Codex broker(s) ${soleProject.join(', ')} in ${projectDir} have no user-scope counterpart in ${userDir}, so nothing is being shadowed`,
        'Codex prefers project scope: once `fadeno setup --codex` materializes managed user-scope brokers, these files would win over them.',
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
          // taken it. The agent's own model/effort are NOT compared: Codex
          // applies an agent file only after an explicit spawn value, so any
          // managed agent for the role could have carried this row's
          // snapshotted identity.
          const agentType = typeof row.extra.agent_type === 'string' ? row.extra.agent_type : null;
          if (findSpawnableCodexAgent(candidates, agentType) == null) continue;
          avoidableCount += 1;
          avoidableExecutors.add(executor);
        }
        if (avoidableCount > 0) {
          findings.push(finding(
            'codex-agents-fallback-avoidable',
            'warning',
            `${avoidableCount} engine dispatch(es) in the most recent run (${latestRun.runId}) took the command fallback for executor(s) ${[...avoidableExecutors].sort().join(', ')}, even though a managed Codex role agent for that role is installed and could have delivered them in-host`,
            'The coordinator resolved without --host-executor (it is not itself a materialized role agent), so `steering resolve` reported mode=command. Spawn the role agent named in the resolver\'s `delegate_to`, passing its `model` and `reasoning_effort` as EXPLICIT spawn values — Codex applies an agent file only after an explicit spawn value, so the file\'s own identity neither constrains nor delivers the snapshotted one. Use `fadeno dispatch-fallback` only when no managed role agent exists.',
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
  for (const pattern of ['.fadeno/runs/', '.fadeno/progress/', '.fadeno/local/', '.fadeno/dispatches.jsonl', '.codex/agents/fadeno-*.toml', '.claude/settings.local.json']) {
    if (!isFadenoPathIgnored(ignoreLines, pattern)) findings.push(finding(`ignore:${pattern}`, 'warning', 'managed ignore entry is absent', 'The first `new-run`/`dispatch`, `fadeno init`, or `fadeno vendor` adds it non-destructively.'));
  }
  {
    const LOCK_STALE_MS = 120_000;
    let lockStale: { path: string; mtimeMs: number } | null = null;
    const lockAbs = join(repoRoot, WORKSPACE_LEASE_LOCK);
    if (existsSync(lockAbs)) {
      try {
        const lst = lstatSync(lockAbs);
        if (lst.isSymbolicLink()) {
          findings.push(finding(
            'workspace-lease',
            'warning',
            `stale lock symlink at ${WORKSPACE_LEASE_LOCK}`,
            `remove ${WORKSPACE_LEASE_LOCK} only after verifying no writer remains`,
          ));
        } else if (lst.isDirectory()) {
          let mtime = lst.mtimeMs;
          try {
            mtime = statSync(lockAbs).mtimeMs;
          } catch {}
          if (Date.now() - mtime > LOCK_STALE_MS) {
            lockStale = { path: WORKSPACE_LEASE_LOCK, mtimeMs: mtime };
            findings.push(finding(
              'workspace-lease',
              'warning',
              `stale lock directory at ${WORKSPACE_LEASE_LOCK} (mtime ${new Date(mtime).toISOString()})`,
              `remove ${WORKSPACE_LEASE_LOCK} only after verifying no writer remains`,
            ));
          }
        }
      } catch {
      }
    }
    let lease: ReturnType<typeof readWorkspaceLease> = null;
    let effective: ReturnType<typeof readEffectiveLease> = null;
    let leaseSymlinkWarning = false;
    const leaseAbs = join(repoRoot, WORKSPACE_LEASE_FILE);
    if (existsSync(leaseAbs)) {
      try {
        const lst = lstatSync(leaseAbs);
        if (lst.isSymbolicLink()) {
          findings.push(finding(
            'workspace-lease',
            'warning',
            `unreadable workspace lease symlink at ${WORKSPACE_LEASE_FILE}`,
            `remove ${WORKSPACE_LEASE_FILE} only after verifying no writer remains`,
          ));
          leaseSymlinkWarning = true;
        }
      } catch {}
    }
    if (!leaseSymlinkWarning) {
      try {
        lease = readWorkspaceLease(repoRoot);
      } catch {
        lease = null;
      }
      try {
        effective = readEffectiveLease(repoRoot);
      } catch {
        effective = null;
      }
    }
    if (leaseSymlinkWarning) {
    } else if (lease == null) {
      findings.push(finding('workspace-lease', 'ok', 'no active workspace lease'));
    } else if (effective != null) {
      const holder = lease.holder;
      const holdersCount = lease.holders?.length ?? 1;
      const liveness = describeWorkspaceLeaseLiveness(lease, repoRoot);
      const held = describeHeld(liveness?.heldMs ?? 0);
      // A running dispatch is not a problem, and calling it one had a cost:
      // this check reported EVERY held lease as an abandoned host dispatch and
      // offered `dispatch-fail` on it. Run against a live 47-minute command
      // fallback, that destroys the run and re-does the work. Assert
      // abandonment only where there is evidence for it.
      if (liveness?.state === 'running') {
        findings.push(finding(
          'workspace-lease',
          'ok',
          `${holder.kind} "${holder.id}" is running (held ${held}, supervisor alive via ${liveness.claim})`,
        ));
      } else {
        // The two remaining states are NOT the same claim, and the remediation
        // says which one this is. `ended` has positive evidence the supervisor
        // is gone; `unobservable` has no evidence either way — a host delivery
        // runs in another agent's session, which publishes nothing here.
        const ended = liveness?.state === 'ended';
        const observed = ended
          ? `held ${held}, supervisor has exited`
          : `held ${held}, liveness not observable from here`;
        const detail = `${holder.kind} "${holder.id}" (supervisor_pid ${lease.supervisor_pid ?? 'unknown'}, started ${lease.started_at}, ${observed}, holders: ${holdersCount})`;
        const lead = ended
          ? 'Its supervisor is gone, so recover it'
          : 'If it is genuinely abandoned, recover it';
        let remediation: string;
        if (holder.kind === 'host-dispatch' && holder.runId != null && holder.dispatchId != null) {
          remediation = `Inspect it with \`fadeno show ${holder.runId}\`; ${lead} with \`fadeno dispatch-complete ${holder.runId} ${holder.dispatchId}\` or \`fadeno dispatch-fail ${holder.runId} ${holder.dispatchId}\`; Only after verifying no writer remains, remove ${WORKSPACE_LEASE_FILE} as a last resort.`;
        } else if (holder.runId != null) {
          remediation = `Inspect it with \`fadeno show ${holder.runId}\`; ${lead} with dispatch-fail/dispatch-complete. Only after verifying no writer remains, remove ${WORKSPACE_LEASE_FILE} as a last resort.`;
        } else {
          remediation = `Inspect it with \`fadeno show <run>\`; ${lead} with dispatch-fail/dispatch-complete. Only after verifying no writer remains, remove ${WORKSPACE_LEASE_FILE} as a last resort.`;
        }
        findings.push(finding('workspace-lease', 'warning', detail, remediation));
      }
    } else {
      const holder = lease.holder;
      const pid = lease.supervisor_pid ?? 'unknown';
      const detail = `stale lease for "${holder.id}" (supervisor_pid ${pid} is dead)`;
      const remediation = `re-acquire will reclaim it; or remove ${WORKSPACE_LEASE_FILE} only after verifying no writer remains`;
      findings.push(finding('workspace-lease', 'warning', detail, remediation));
    }
    void lockStale;
  }
  return { repoRoot, findings, ok: findings.every((item) => item.severity !== 'error') };
}
