import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileDigest, readInstallationManifest, writeInstallationManifest } from '../lib/installations.ts';
import { readUserHarness, userPaths, type FadenoHarness, type UserPathOptions } from '../lib/user-paths.ts';

export class UninstallError extends Error {}

export interface UninstallOptions {
  target?: FadenoHarness | null;
  all?: boolean;
  purgeUserData?: boolean;
  force?: boolean;
  userPathOptions?: UserPathOptions;
}

export interface UninstallResult {
  harnesses: FadenoHarness[];
  removed: string[];
  preserved: string[];
  purged: boolean;
}

function legacyManagedFiles(harness: FadenoHarness, opts?: UserPathOptions): string[] {
  if (harness !== 'codex') return [];
  const env = opts?.env ?? process.env;
  const home = opts?.home ?? homedir();
  const agentsDir = join(env.CODEX_HOME?.trim() || join(home, '.codex'), 'agents');
  return ['worker', 'reviewer', 'judge'].map((role) => join(agentsDir, `fadeno-${role}.toml`));
}

function removePermissionRule(
  permission: { path: string; rule: string; createdFile: boolean },
  removed: string[],
  preserved: string[],
): void {
  if (!existsSync(permission.path)) return;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(permission.path, 'utf8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    data = parsed as Record<string, unknown>;
  } catch {
    preserved.push(`${permission.path} (could not remove ${permission.rule})`);
    return;
  }
  const permissions = data.permissions;
  if (permissions == null || typeof permissions !== 'object' || Array.isArray(permissions)) return;
  const allow = (permissions as Record<string, unknown>).allow;
  if (!Array.isArray(allow) || !allow.includes(permission.rule)) return;
  (permissions as Record<string, unknown>).allow = allow.filter((item) => item !== permission.rule);
  const emptyPermissions = Object.values(permissions).every((value) => Array.isArray(value) && value.length === 0);
  if (emptyPermissions) delete data.permissions;
  if (permission.createdFile && Object.keys(data).length === 0) rmSync(permission.path, { force: true });
  else writeFileSync(permission.path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  removed.push(`${permission.path} permission ${permission.rule}`);
}

export function runUninstall(opts: UninstallOptions): UninstallResult {
  if (opts.purgeUserData && !opts.force) {
    throw new UninstallError('`--purge-user-data` is destructive; repeat with --force after reviewing the user paths.');
  }
  const paths = userPaths(opts.userPathOptions);
  const manifest = readInstallationManifest(opts.userPathOptions);
  const selected: FadenoHarness[] = opts.all || opts.purgeUserData
    ? ['codex', 'claude']
    : opts.target != null ? [opts.target] : [];
  if (selected.length === 0 && !opts.purgeUserData) {
    throw new UninstallError('Choose `--codex`, `--claude`, `--all`, or `--purge-user-data --force`.');
  }
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const harness of selected) {
    const installation = manifest.harnesses[harness];
    const recorded = installation?.files ?? [];
    const files = [
      ...recorded,
      ...legacyManagedFiles(harness, opts.userPathOptions)
        .filter((path) => !recorded.some((file) => file.path === path))
        .map((path) => ({ path, sha256: '' })),
    ];
    for (const file of files) {
      if (!existsSync(file.path)) continue;
      const managedMarker = readFileSync(file.path, 'utf8').startsWith('# fadeno:managed');
      if (managedMarker || (file.sha256 !== '' && fileDigest(file.path) === file.sha256)) {
        rmSync(file.path, { force: true });
        removed.push(file.path);
      } else {
        preserved.push(file.path);
      }
    }
    for (const permission of installation?.permissionRules ?? []) {
      removePermissionRule(permission, removed, preserved);
    }
    delete manifest.harnesses[harness];
  }

  const currentHarness = readUserHarness(opts.userPathOptions);
  if (currentHarness != null && selected.includes(currentHarness)) {
    const remaining = (['codex', 'claude'] as const).find((name) => manifest.harnesses[name] != null);
    if (remaining == null) rmSync(paths.harnessFile, { force: true });
    else writeFileSync(paths.harnessFile, `${remaining}\n`, 'utf8');
  }
  if (Object.keys(manifest.harnesses).length === 0) {
    rmSync(paths.managedRuntimeDir, { recursive: true, force: true });
    // Clean staging/rollback/lock siblings when removing final runtime
    rmSync(join(paths.dataDir, 'runtime.staging'), { recursive: true, force: true });
    rmSync(join(paths.dataDir, 'runtime.old'), { recursive: true, force: true });
    rmSync(join(paths.dataDir, '.runtime.lock'), { recursive: true, force: true });
    manifest.runtime = null;
  }
  writeInstallationManifest(paths, manifest);

  if (opts.purgeUserData) {
    rmSync(paths.configDir, { recursive: true, force: true });
    rmSync(paths.stateDir, { recursive: true, force: true });
    rmSync(paths.dataDir, { recursive: true, force: true });
    return { harnesses: selected, removed, preserved, purged: true };
  }
  return { harnesses: selected, removed, preserved, purged: false };
}
