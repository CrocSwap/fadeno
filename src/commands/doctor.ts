import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
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
      findings.push(finding(`executor:${role.executor}`, 'warning', `${role.command?.[0] ?? role.executor} is unavailable`, 'Install the provider CLI or select native explicitly; Fadeno will not fall back automatically.'));
    } else {
      findings.push(finding(`executor:${role.executor}`, 'ok', 'executable is present on PATH (not executed)'));
    }
  }
  // An unrecorded harness is not a cosmetic gap: routes are compiled per
  // harness, and under `standalone` the native route does not exist at all, so
  // a host-native slot silently becomes a subprocess. It also disarms every
  // check below that keys on a specific harness, including `codex-agents`.
  const ambient = detectAmbientHarness(opts.userPathOptions);
  if (ambient == null) {
    findings.push(finding('harness', 'ok', `${status.harness ?? 'standalone'}; no ambient host evidence to compare against`));
  } else if (status.harness === ambient.harness) {
    findings.push(finding('harness', 'ok', `${ambient.harness}, matching the host this session is running inside`));
  } else if (status.harness == null || status.harness === 'standalone') {
    findings.push(finding(
      'harness',
      'warning',
      `${ambient.marker} says this session runs inside ${ambient.harness}, but no harness is recorded so routes compile as standalone`,
      `Run \`fadeno setup --${ambient.harness}\`; until then every ${ambient.harness}-native slot is delivered as a subprocess instead.`,
    ));
  } else {
    findings.push(finding(
      'harness',
      'warning',
      `configured harness is ${status.harness}, but ${ambient.marker} says this session runs inside ${ambient.harness}`,
      `Run \`fadeno setup --${ambient.harness}\` if that is the host you meant; the two compile different adapters for the same slot.`,
    ));
  }
  if (status.harness === 'codex' && status.codexMaterialization?.restartRequired) {
    findings.push(finding('codex-agents', 'warning', 'managed native agents are missing or stale', 'Run `fadeno setup --codex` and start a fresh Codex session.'));
  } else if (status.harness === 'codex') {
    findings.push(finding('codex-agents', 'ok', 'managed native-agent state is current'));
  }
  const gitignore = join(repoRoot, '.gitignore');
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const ignoreLines = ignored.split(/\r?\n/).map((line) => line.trim());
  for (const pattern of ['.fadeno/runs/', '.fadeno/progress/', '.fadeno/local/', '.fadeno/dispatches.jsonl', '.codex/agents/fadeno-*.toml', '.claude/settings.local.json']) {
    if (!isFadenoPathIgnored(ignoreLines, pattern)) findings.push(finding(`ignore:${pattern}`, 'warning', 'managed ignore entry is absent', 'The first `new-run`/`dispatch`, `fadeno init`, or `fadeno vendor` adds it non-destructively.'));
  }
  return { repoRoot, findings, ok: findings.every((item) => item.severity !== 'error') };
}
