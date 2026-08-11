import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { runStatus, type StatusOptions } from './status.ts';
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
  if (opts.target === 'codex' && status.codexMaterialization?.restartRequired) {
    findings.push(finding('codex-agents', 'warning', 'managed native agents are missing or stale', 'Run `fadeno setup --codex` and start a fresh Codex session.'));
  } else if (opts.target === 'codex') {
    findings.push(finding('codex-agents', 'ok', 'managed native-agent state is current'));
  }
  const gitignore = join(repoRoot, '.gitignore');
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const ignoreLines = ignored.split(/\r?\n/).map((line) => line.trim());
  for (const pattern of ['.fadeno/runs/', '.fadeno/progress/', '.fadeno/local/', '.fadeno/dispatches.jsonl', '.codex/agents/fadeno-*.toml', '.claude/settings.local.json']) {
    if (!isFadenoPathIgnored(ignoreLines, pattern)) findings.push(finding(`ignore:${pattern}`, 'warning', 'managed ignore entry is absent', 'Run `fadeno setup`, `fadeno init`, or `fadeno vendor` to add it non-destructively.'));
  }
  return { repoRoot, findings, ok: findings.every((item) => item.severity !== 'error') };
}
