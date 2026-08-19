import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { packageVersion } from './paths.ts';
import { readUserHarness, userPaths, type FadenoHarness, type FadenoUserPaths, type UserPathOptions } from './user-paths.ts';

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
  runtime: { version: string; path: string; source: string | null; version_source?: 'observed' | 'assumed'; installed_at?: string; source_frame?: string } | null;
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

/**
 * Every harness this machine keeps state for — not the one it is running in.
 */
export function maintainedHarnesses(options: UserPathOptions = {}): FadenoHarness[] {
  const manifest = readInstallationManifest(options);
  const names = new Set<FadenoHarness>(Object.keys(manifest.harnesses) as FadenoHarness[]);
  const memo = readUserHarness(options);
  if (memo != null) names.add(memo);
  return [...names].sort();
}

export function writeInstallationManifest(paths: FadenoUserPaths, manifest: InstallationManifest): void {
  mkdirSync(dirname(paths.installationsFile), { recursive: true });
  const tmp = `${paths.installationsFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tmp, paths.installationsFile);
}

export function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// --- version comparison ---

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

export function compareFadenoVersions(a: string, b: string): -1 | 0 | 1 | null {
  const ma = VERSION_RE.exec(a.trim());
  const mb = VERSION_RE.exec(b.trim());
  if (!ma || !mb) return null;
  const aMajor = Number(ma[1]), aMinor = Number(ma[2]), aPatch = Number(ma[3]);
  const bMajor = Number(mb[1]), bMinor = Number(mb[2]), bPatch = Number(mb[3]);
  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1;
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  const aRc = ma[4] !== undefined ? Number(ma[4]) : null;
  const bRc = mb[4] !== undefined ? Number(mb[4]) : null;
  if (aRc === null && bRc === null) return 0;
  if (aRc === null && bRc !== null) return 1;
  if (aRc !== null && bRc === null) return -1;
  if (aRc! !== bRc!) return aRc! > bRc! ? 1 : -1;
  return 0;
}

export function sourceBundleVersion(sourceDir: string): string | null {
  const candidates = [
    join(dirname(sourceDir), '.claude-plugin', 'plugin.json'),
    join(dirname(sourceDir), '.codex-plugin', 'plugin.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
      if (parsed.name !== 'fadeno') continue;
      if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
        return parsed.version.trim();
      }
    } catch {}
  }
  try {
    const pkg = join(sourceDir, 'package.json');
    if (existsSync(pkg)) {
      const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
        if (parsed.name === 'fadeno-runtime' || parsed.name === 'fadeno') {
          return parsed.version.trim();
        }
      }
    }
  } catch {}
  return null;
}

export function readRuntimeVersionAt(binDir: string): { version: string | null; source: 'observed' | 'assumed' } {
  try {
    const pkgPath = join(binDir, 'package.json');
    if (existsSync(pkgPath)) {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim().length > 0) {
        if (parsed.name === 'fadeno-runtime' || parsed.name === 'fadeno') {
          return { version: parsed.version.trim(), source: 'observed' };
        }
      }
    }
  } catch {}
  return { version: null, source: 'assumed' };
}

export type RuntimeSyncOutcome = 'installed' | 'refreshed' | 'current' | 'kept-newer' | 'locked' | 'absent' | 'skipped-no-source';

export interface SyncOptions {
  force?: boolean;
  trustSource?: boolean;
  allowInstall?: boolean;
  copyFn?: typeof cpSync;
  digestFn?: typeof fileDigest;
  renameFn?: typeof renameSync;
  rmFn?: typeof rmSync;
}

const LOCK_STALE_MS = 120_000;

function isStaleLock(lockPath: string): boolean {
  try {
    const st = statSync(lockPath);
    return Date.now() - st.mtimeMs > LOCK_STALE_MS;
  } catch {
    try {
      const lst = lstatSync(lockPath);
      return Date.now() - lst.mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

export function syncManagedRuntime(
  paths: FadenoUserPaths,
  sourceDir: string | null,
  manifest: InstallationManifest,
  opts: SyncOptions = {},
): { outcome: RuntimeSyncOutcome; from: string | null; to: string | null } {
  const allowInstall = opts.allowInstall ?? false;
  const trustSource = opts.trustSource ?? false;
  const force = opts.force ?? false;
  const copyFn = opts.copyFn ?? cpSync;
  const digestFn = opts.digestFn ?? fileDigest;
  const renameFn = opts.renameFn ?? renameSync;
  const rmFn = opts.rmFn ?? rmSync;

  const managedDir = paths.managedRuntimeDir;
  const managedCli = paths.managedCli;
  const dataDir = paths.dataDir;
  const lockPath = join(dataDir, '.runtime.lock');
  const stagingPath = join(dataDir, 'runtime.staging');
  const oldPath = join(dataDir, 'runtime.old');

  const fromVersion = manifest.runtime?.version ?? null;

  if (sourceDir == null || !existsSync(join(sourceDir, 'fadeno'))) {
    if (manifest.runtime != null) {
      return { outcome: 'skipped-no-source', from: fromVersion, to: fromVersion };
    }
    return { outcome: 'absent', from: null, to: null };
  }

  try {
    if (resolve(sourceDir) === resolve(managedDir)) {
      const observed = readRuntimeVersionAt(sourceDir);
      const ver = observed.version ?? packageVersion();
      const src = observed.version != null ? 'observed' as const : 'assumed' as const;
      if (manifest.runtime != null) {
        if (manifest.runtime.version !== ver) {
          manifest.runtime = { version: ver, path: managedCli, source: manifest.runtime.source, version_source: src, installed_at: new Date().toISOString() };
          try { writeInstallationManifest(paths, manifest); } catch {}
        }
      } else {
        manifest.runtime = { version: ver, path: managedCli, source: null, version_source: src, installed_at: new Date().toISOString() };
        try { writeInstallationManifest(paths, manifest); } catch {}
      }
      return { outcome: 'current', from: fromVersion, to: ver };
    }
  } catch {}

  if (manifest.runtime == null) {
    if (!allowInstall) {
      return { outcome: 'absent', from: null, to: null };
    }
    let srcVer = sourceBundleVersion(sourceDir);
    let srcSource: 'observed' | 'assumed' = 'observed';
    if (srcVer == null && trustSource) {
      srcVer = packageVersion();
      srcSource = 'assumed';
    }
    if (srcVer == null) {
      return { outcome: 'kept-newer', from: null, to: null };
    }
    mkdirSync(dataDir, { recursive: true });
    try {
      mkdirSync(lockPath);
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        if (isStaleLock(lockPath)) {
          try { rmFn(lockPath, { recursive: true, force: true } as any); } catch {}
          try { mkdirSync(lockPath); } catch { return { outcome: 'locked', from: null, to: srcVer }; }
        } else {
          return { outcome: 'locked', from: null, to: srcVer };
        }
      } else {
        throw err;
      }
    }
    let staged = false;
    try {
      try { rmFn(stagingPath, { recursive: true, force: true } as any); } catch {}
      try { rmFn(oldPath, { recursive: true, force: true } as any); } catch {}
      copyFn(sourceDir, stagingPath, { recursive: true });
      staged = true;
      if (!existsSync(join(stagingPath, 'fadeno'))) throw new InstallationError(`staged runtime missing fadeno binary`);
      if (existsSync(join(sourceDir, 'templates')) && !existsSync(join(stagingPath, 'templates'))) {
        throw new InstallationError(`staged runtime missing templates`);
      }
      if (managedCli.endsWith('.cmd')) {
        writeFileSync(join(stagingPath, 'fadeno.cmd'), '@echo off\r\nnode "%~dp0fadeno" %*\r\n', 'utf8');
      }
      renameFn(stagingPath, managedDir);
      staged = false;
      manifest.runtime = { version: srcVer, path: managedCli, source: sourceDir, version_source: srcSource, installed_at: new Date().toISOString() };
      writeInstallationManifest(paths, manifest);
      return { outcome: 'installed', from: null, to: srcVer };
    } catch (e) {
      if (staged) try { rmFn(stagingPath, { recursive: true, force: true } as any); } catch {}
      try { rmFn(stagingPath, { recursive: true, force: true } as any); } catch {}
      try { rmFn(oldPath, { recursive: true, force: true } as any); } catch {}
      throw e;
    } finally {
      try { rmFn(lockPath, { recursive: true, force: true } as any); } catch {}
      try { if (existsSync(stagingPath)) rmFn(stagingPath, { recursive: true, force: true } as any); } catch {}
      try { if (existsSync(oldPath)) rmFn(oldPath, { recursive: true, force: true } as any); } catch {}
    }
  }

  const currentVersion = manifest.runtime!.version;

  let sourceVersion = sourceBundleVersion(sourceDir);
  let sourceVersionSource: 'observed' | 'assumed' = 'observed';
  if (sourceVersion == null && trustSource) {
    sourceVersion = packageVersion();
    sourceVersionSource = 'assumed';
  } else if (sourceVersion == null) {
    return { outcome: 'kept-newer', from: currentVersion, to: currentVersion };
  }

  const cmp = sourceVersion != null ? compareFadenoVersions(sourceVersion, currentVersion) : null;

  if (cmp === 0) {
    let srcDigest: string | null = null;
    let dstDigest: string | null = null;
    try {
      srcDigest = digestFn(join(sourceDir, 'fadeno'));
      dstDigest = digestFn(join(managedDir, 'fadeno'));
    } catch {
      srcDigest = 'missing-src';
      dstDigest = 'missing-dst';
    }
    if (srcDigest === dstDigest) {
      return { outcome: 'current', from: currentVersion, to: currentVersion };
    }
  } else if (cmp === -1) {
    if (!force) {
      return { outcome: 'kept-newer', from: currentVersion, to: currentVersion };
    }
  } else if (cmp === null) {
    if (!trustSource) {
      return { outcome: 'kept-newer', from: currentVersion, to: currentVersion };
    }
    let srcDigest: string | null = null;
    let dstDigest: string | null = null;
    try {
      srcDigest = digestFn(join(sourceDir, 'fadeno'));
      dstDigest = digestFn(join(managedDir, 'fadeno'));
    } catch {
      srcDigest = 'missing-src';
      dstDigest = 'missing-dst';
    }
    if (srcDigest === dstDigest) {
      return { outcome: 'current', from: currentVersion, to: currentVersion };
    }
  }

  mkdirSync(dataDir, { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      if (isStaleLock(lockPath)) {
        try { rmFn(lockPath, { recursive: true, force: true } as any); } catch {}
        try { mkdirSync(lockPath); } catch (e: any) {
          if (e.code === 'EEXIST') return { outcome: 'locked', from: currentVersion, to: sourceVersion };
          throw e;
        }
      } else {
        return { outcome: 'locked', from: currentVersion, to: sourceVersion };
      }
    } else {
      throw err;
    }
  }

  let staged = false;
  let renamed = false;
  let restoreFailed = false;
  try {
    try { rmFn(stagingPath, { recursive: true, force: true } as any); } catch {}
    try { rmFn(oldPath, { recursive: true, force: true } as any); } catch {}
    copyFn(sourceDir, stagingPath, { recursive: true });
    staged = true;
    if (!existsSync(join(stagingPath, 'fadeno'))) throw new InstallationError(`staged runtime missing fadeno binary`);
    if (existsSync(join(sourceDir, 'templates')) && !existsSync(join(stagingPath, 'templates'))) {
      throw new InstallationError(`staged runtime missing templates`);
    }
    if (managedCli.endsWith('.cmd')) {
      writeFileSync(join(stagingPath, 'fadeno.cmd'), '@echo off\r\nnode "%~dp0fadeno" %*\r\n', 'utf8');
    }
    if (existsSync(managedDir)) {
      renameFn(managedDir, oldPath);
      renamed = true;
    }
    renameFn(stagingPath, managedDir);
    staged = false;
    try { rmFn(oldPath, { recursive: true, force: true } as any); } catch {}
    renamed = false;
    manifest.runtime = {
      version: sourceVersion!,
      path: managedCli,
      source: sourceDir,
      version_source: sourceVersionSource,
      installed_at: new Date().toISOString(),
    };
    writeInstallationManifest(paths, manifest);
    return { outcome: 'refreshed', from: currentVersion, to: sourceVersion! };
  } catch (e) {
    if (renamed) {
      let restored = false;
      try {
        if (existsSync(oldPath) && !existsSync(managedDir)) {
          try { renameFn(oldPath, managedDir); restored = true; } catch { restoreFailed = true; }
        } else if (existsSync(oldPath) && existsSync(managedDir)) {
          try { rmFn(managedDir, { recursive: true, force: true } as any); } catch {}
          try { renameFn(oldPath, managedDir); restored = true; } catch { restoreFailed = true; }
        }
      } catch { restoreFailed = true; }
      if (restored) renamed = false;
      else restoreFailed = true;
    }
    if (staged) {
      try { rmFn(stagingPath, { recursive: true, force: true } as any); } catch {}
    }
    try { if (existsSync(stagingPath)) rmFn(stagingPath, { recursive: true, force: true } as any); } catch {}
    throw e;
  } finally {
    try { rmFn(lockPath, { recursive: true, force: true } as any); } catch {}
    try { if (existsSync(stagingPath)) rmFn(stagingPath, { recursive: true, force: true } as any); } catch {}
    if (!restoreFailed) {
      try { if (existsSync(oldPath)) rmFn(oldPath, { recursive: true, force: true } as any); } catch {}
    } else {
      try { console.error(`fadeno: runtime rollback preserved at ${oldPath}; restore to ${managedDir} failed — recover manually`); } catch {}
    }
  }
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
