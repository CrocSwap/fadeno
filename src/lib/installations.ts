import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { packageVersion } from './paths.ts';
import { userPaths, type FadenoHarness, type FadenoUserPaths, type UserPathOptions } from './user-paths.ts';

export interface ManagedFile {
  path: string;
  sha256: string;
}

export interface ManagedPermissionRule {
  path: string;
  rule: string;
  createdFile: boolean;
}

export interface InstallationManifest {
  schema_version: 1;
  runtime: { version: string; path: string; source: string | null } | null;
  harnesses: Partial<Record<FadenoHarness, {
    version: string;
    files: ManagedFile[];
    permissionRules?: ManagedPermissionRule[];
  }>>;
}

export class InstallationError extends Error {}

export function emptyInstallationManifest(): InstallationManifest {
  return { schema_version: 1, runtime: null, harnesses: {} };
}

export function readInstallationManifest(options: UserPathOptions = {}): InstallationManifest {
  const path = userPaths(options).installationsFile;
  if (!existsSync(path)) return emptyInstallationManifest();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as InstallationManifest;
    if (parsed.schema_version !== 1 || parsed.harnesses == null || typeof parsed.harnesses !== 'object') {
      throw new InstallationError(`unsupported or malformed installation manifest at ${path}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof InstallationError) throw err;
    throw new InstallationError(`could not parse installation manifest ${path}: ${(err as Error).message}`);
  }
}

export function writeInstallationManifest(paths: FadenoUserPaths, manifest: InstallationManifest): void {
  mkdirSync(dirname(paths.installationsFile), { recursive: true });
  writeFileSync(paths.installationsFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Copy a plugin-bundled runtime to the stable user path. */
export function installManagedRuntime(
  paths: FadenoUserPaths,
  sourceDir: string | null,
  manifest: InstallationManifest,
): boolean {
  if (sourceDir == null || !existsSync(join(sourceDir, 'fadeno'))) return false;
  if (resolve(sourceDir) === resolve(paths.managedRuntimeDir)) {
    manifest.runtime = { version: packageVersion(), path: paths.managedCli, source: sourceDir };
    return false;
  }
  rmSync(paths.managedRuntimeDir, { recursive: true, force: true });
  mkdirSync(paths.managedRuntimeDir, { recursive: true });
  cpSync(sourceDir, paths.managedRuntimeDir, { recursive: true });
  if (paths.managedCli.endsWith('.cmd')) {
    writeFileSync(paths.managedCli, '@echo off\r\nnode "%~dp0fadeno" %*\r\n', 'utf8');
  }
  manifest.runtime = { version: packageVersion(), path: paths.managedCli, source: sourceDir };
  return true;
}

export function recordHarnessInstallation(
  paths: FadenoUserPaths,
  harness: FadenoHarness,
  files: string[],
  manifest: InstallationManifest,
  permissionRules: ManagedPermissionRule[] = [],
): void {
  manifest.harnesses[harness] = {
    version: packageVersion(),
    files: files.filter(existsSync).map((path) => ({ path, sha256: fileDigest(path) })),
    ...(permissionRules.length > 0 ? { permissionRules } : {}),
  };
  writeInstallationManifest(paths, manifest);
}
