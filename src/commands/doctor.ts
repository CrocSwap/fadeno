import { accessSync, constants, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { runStatus, type StatusOptions } from './status.ts';
import { listRetiredClaudeGridCells } from './steering.ts';
import { detectAmbientHarness } from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { isFadenoPathIgnored } from '../lib/source-control.ts';
import {
  WORKSPACE_LEASE_FILE,
  WORKSPACE_LEASE_LOCK,
  readEffectiveLease,
  readWorkspaceLease,
} from '../lib/workspace-lease.ts';
import { compareFadenoVersions, readInstallationManifest } from '../lib/installations.ts';
import { userPaths, type UserPathOptions } from '../lib/user-paths.ts';

// Same literal `steering.ts` writes into every managed Claude agent file
// (retired grid cell or legacy per-dial); not exported there, so duplicated
// here rather than reaching into that module's internals. Already duplicated
// independently by `setup.ts`'s codex equivalent and the dispatch-steering
// hook, so one more read-only copy is consistent with the existing pattern.
// (Grid cells carry a narrower marker, and `listRetiredClaudeGridCells` —
// which steering.ts DOES export — is the single definition of that one.)
const CLAUDE_MANAGED_MARK = '<!-- fadeno:managed';

// The Codex equivalent: `steering apply --codex --scope user` stamps
// `# fadeno:managed version=<pkg version> digest=<sha256>` as the FIRST line of
// every user-scope role agent, and its `managedAgentEmit` gates overwriting on
// exactly this prefix. `steering.ts` keeps that literal private, and that
// module is not this one's to change, so the convention is replicated
// read-only here — the same way `CLAUDE_MANAGED_MARK` above is.
const CODEX_MANAGED_MARK = '# fadeno:managed';
const CODEX_MANAGED_VERSION_RE = /^# fadeno:managed\b[^\n]*?\bversion=(\S+)/;

interface CodexBrokerState {
  /** The file's first line carries the managed header `steering apply` writes. */
  managed: boolean;
  /** `version=` off that header, when it carries one. */
  version: string | null;
}

/**
 * Read one Codex role-agent file's provenance. `null` means "no such file" —
 * as does an unreadable one, which is not provably Fadeno's and so is never
 * claimed (the same rule `listRetiredClaudeGridCells` applies).
 */
function readCodexBroker(path: string): CodexBrokerState | null {
  let text: string;
  try {
    if (!existsSync(path)) return null;
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (!text.startsWith(CODEX_MANAGED_MARK)) return { managed: false, version: null };
  const match = CODEX_MANAGED_VERSION_RE.exec(text);
  return { managed: true, version: match ? match[1]! : null };
}

/**
 * `$CODEX_HOME/agents`, else `<home>/.codex/agents` — the same precedence
 * `steering.ts`'s private `codexAgentDir('user', …)` and `status.ts`'s
 * materialization probe both apply. Replicated rather than imported because
 * that helper is not exported; keep the three in step if the rule ever moves.
 */
function codexUserAgentDir(userPathOptions?: UserPathOptions): string {
  const codexHome = userPathOptions?.env?.CODEX_HOME?.trim() ||
    process.env.CODEX_HOME?.trim() ||
    join(userPathOptions?.home ?? homedir(), '.codex');
  return join(codexHome, 'agents');
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
  } else if ((status as any).activeLoadout == null) {
    findings.push(finding('dials', 'error', 'no dials resolved', 'Run `fadeno dial <archetype> <model>`'));
  } else {
    findings.push(finding('dials', 'ok', `${(status as any).activeLoadout.name} (${(status as any).activeLoadout.source})`));
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
    const unmanagedShadow: string[] = [];
    const staleShadow: Array<{ name: string; label: string }> = [];
    for (const archetype of ['worker', 'reviewer', 'judge']) {
      const name = `${archetype}.toml`;
      const project = readCodexBroker(join(projectDir, name));
      if (project == null) continue;
      const user = readCodexBroker(join(userDir, `fadeno-${archetype}.toml`));
      if (user == null) {
        soleProject.push(name);
      } else if (!project.managed) {
        unmanagedShadow.push(name);
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
        `${unmanagedShadow.join(', ')} in ${projectDir} carry no managed header, and Codex prefers project scope over the user-scope broker(s) in ${userDir} — so the unmanaged copy is what every session loads, and \`fadeno steering apply --codex\` can never refresh it in place (project-scope emit skips an existing file). Frozen at whatever build wrote it, it drifts behind the resolver contract with no symptom: a copy predating \`--prompt-file\`/\`--host-executor\` invokes \`steering resolve\` without them, which drops this repo out of shadow pairing and silently defeats mismatch detection`,
        `Delete ${absolute(unmanagedShadow)} so the user-scope broker takes over. Rewriting in place (\`fadeno steering apply --codex --scope project --force\`) refreshes the content but leaves the file unmanaged and still shadowing, so this finding would stay.`,
      ));
    }
    if (staleShadow.length > 0) {
      findings.push(finding(
        'codex-agents-shadow-stale',
        'warning',
        `${staleShadow.map((item) => item.label).join(', ')} in ${projectDir} are managed but stamped older than the user-scope broker(s) in ${userDir}, and Codex prefers project scope — so the older generation is what every session actually loads`,
        `Delete ${absolute(staleShadow.map((item) => item.name))} so the current user-scope broker takes over; \`fadeno steering apply --codex\` cannot bring a project-scope file up to date in place, because it skips existing files and never stamps project scope with a managed header.`,
      ));
    }
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
      findings.push(finding(
        'plugin-surface',
        'ok',
        `plugin ${surface.version} on disk matches this CLI`,
        `Subagent definitions are still whatever this session loaded at startup — if your agent list stamps a version other than ${status.version}, restart to refresh it.`,
      ));
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
      const detail = `${holder.kind} "${holder.id}" (supervisor_pid ${lease.supervisor_pid ?? 'unknown'}, started ${lease.started_at}, holders: ${holdersCount})`;
      let remediation: string;
      if (holder.kind === 'host-dispatch' && holder.runId != null && holder.dispatchId != null) {
        remediation = `Inspect it with \`fadeno show ${holder.runId}\`; recover an abandoned host dispatch with \`fadeno dispatch-complete ${holder.runId} ${holder.dispatchId}\` or \`fadeno dispatch-fail ${holder.runId} ${holder.dispatchId}\`; Only after verifying no writer remains, remove ${WORKSPACE_LEASE_FILE} as a last resort.`;
      } else if (holder.runId != null) {
        remediation = `Inspect it with \`fadeno show ${holder.runId}\`; recover an abandoned host dispatch with dispatch-fail/dispatch-complete. Only after verifying no writer remains, remove ${WORKSPACE_LEASE_FILE} as a last resort.`;
      } else {
        remediation = `Inspect it with \`fadeno show <run>\`; recover an abandoned host dispatch with dispatch-fail/dispatch-complete. Only after verifying no writer remains, remove ${WORKSPACE_LEASE_FILE} as a last resort.`;
      }
      findings.push(finding('workspace-lease', 'warning', detail, remediation));
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
