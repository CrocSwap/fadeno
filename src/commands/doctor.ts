import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { runStatus, type StatusOptions } from './status.ts';
import { detectAmbientHarness } from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { isFadenoPathIgnored } from '../lib/source-control.ts';

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
 *
 * Found two ways because the answer is visible differently depending on who is
 * asking: hooks and agent shells get `CLAUDE_PLUGIN_ROOT` outright, while the
 * main loop only sees the surface as a `<root>/bin` entry appended to PATH.
 * Several plugins can be installed, so a candidate only counts once its
 * manifest names this one.
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
    findings.push(finding('runtime-source', 'ok', `${status.runtime.invocationSource}; managed runtime ${status.runtime.managedVersion ?? 'not installed'}`));
    if (!status.runtime.versionCurrent) {
      findings.push(finding('runtime-version', 'warning', `managed runtime ${status.runtime.managedVersion} differs from caller ${status.version}`, 'Run the current plugin setup skill to refresh it.'));
    }
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
  if (status.activeLoadout == null) {
    findings.push(finding('active-loadout', 'error', 'no active loadout resolves', 'Run `fadeno use native` or declare a default_loadout.'));
  } else {
    findings.push(finding('active-loadout', 'ok', `${status.activeLoadout.name} (${status.activeLoadout.source})`));
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
  // Routes are compiled per harness, and a wrong answer here is not cosmetic:
  // under the wrong block a host slot compiles to `adapter: command` and runs
  // as a subprocess. Resolution prefers ambient evidence, so this check now
  // reports the two cases resolution cannot settle on its own.
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
    // Only an explicit flag or FADENO_HARNESS can outrank detection now.
    findings.push(finding(
      'harness',
      'warning',
      `${ambient.evidence[0]!.marker} says this session runs inside ${ambient.harness}, but an explicit setting selected ${status.harness}`,
      `Drop the override to route as ${ambient.harness}; the two compile different adapters for the same slot.`,
    ));
  }
  // Keyed on Codex being *maintained*, not on it being the harness in front of
  // you: the agents go stale precisely when you switch a loadout from the other
  // host, which is exactly when an active-harness gate stops looking.
  if (status.codexMaterialization?.restartRequired) {
    findings.push(finding(
      'codex-agents',
      'warning',
      `managed host agents are missing or stale in ${status.codexMaterialization.path}`,
      'Run `fadeno setup --codex`, or `fadeno use <loadout>` to rewrite them; a fresh Codex session picks them up.',
    ));
  } else if (status.codexMaterialization != null) {
    findings.push(finding('codex-agents', 'ok', 'managed host-agent state is current'));
  }
  // A session's subagents and its CLI can be different builds, and until now
  // nothing said so. A 2026-08-13 dogfood ran a registry stamped rc.20 against
  // a CLI at rc.22 and reasoned about behaviour from the stamp. The two halves
  // of the plugin age differently: hooks and the bundled binary are re-read
  // from disk on every call, while subagent definitions are snapshotted into
  // the harness at session start and stay frozen for the session's life. That
  // snapshot is unreadable from out here, so this reports the half that can be
  // checked and tells the caller how to check the half that cannot.
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
  return { repoRoot, findings, ok: findings.every((item) => item.severity !== 'error') };
}
