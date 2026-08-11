import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runVerify } from './verify.ts';
import { resolveDefinition, resolvePlaybookFile } from '../lib/definitions.ts';
import { findRepoRoot, packageVersion } from '../lib/paths.ts';
import { resolveRun, type RunSummary } from '../lib/run-ledger.ts';

export class EvidenceError extends Error {}

export interface EvidencePromoteOptions {
  run: string;
  cwd?: string;
  repoRoot?: string;
}

export interface EvidencePromoteResult {
  run: string;
  destination: string;
  manifest: string;
  idempotent: boolean;
  files: string[];
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function copyOne(source: string, destination: string, rel: string, files: string[]): void {
  if (existsSync(destination)) {
    if (sha256(source) !== sha256(destination)) throw new EvidenceError(`evidence destination conflict at ${destination}; refusing to overwrite it.`);
  } else {
    mkdirSync(join(destination, '..'), { recursive: true });
    cpSync(source, destination);
  }
  files.push(rel);
}

function copyTree(sourceRoot: string, destinationRoot: string, files: string[], prefix = 'artifacts'): void {
  if (!existsSync(sourceRoot)) return;
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const destination = join(destinationRoot, entry.name);
    const childPrefix = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) copyTree(source, destination, files, childPrefix);
    else if (entry.isFile()) copyOne(source, destination, childPrefix, files);
  }
}

/** Promote a successfully verified run into an immutable, committable receipt. */
export function runEvidencePromote(opts: EvidencePromoteOptions): EvidencePromoteResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const verification = runVerify({ run: opts.run, repoRoot });
  if (!verification.ok) throw new EvidenceError(`run ${verification.run.runId} did not verify successfully; promotion refused.`);
  const run: RunSummary = resolveRun(repoRoot, opts.run);
  const destination = join(repoRoot, '.fadeno', 'evidence', run.runId);
  mkdirSync(destination, { recursive: true });
  const files: string[] = [];
  copyOne(join(run.dir, 'run.yaml'), join(destination, 'run.yaml'), 'run.yaml', files);
  copyOne(join(run.dir, 'events.jsonl'), join(destination, 'events.jsonl'), 'events.jsonl', files);
  if (existsSync(join(run.dir, 'profile.yaml'))) copyOne(join(run.dir, 'profile.yaml'), join(destination, 'profile.yaml'), 'profile.yaml', files);
  copyTree(join(run.dir, 'artifacts'), join(destination, 'artifacts'), files);

  const snapshottedDefinitions = join(run.dir, 'definitions');
  if (existsSync(snapshottedDefinitions)) {
    copyTree(snapshottedDefinitions, join(destination, 'definitions'), files, 'definitions');
  } else {
    if (run.playbook != null) {
      const playbook = resolvePlaybookFile(repoRoot, run.playbook);
      if (playbook) copyOne(playbook.path, join(destination, 'definitions', 'playbook.yaml'), 'definitions/playbook.yaml', files);
    }
    const schemaNames = ['playbook.schema.json', 'run.schema.json', 'review-report.schema.json', 'test-result.schema.json'];
    for (const name of schemaNames) {
      const schema = resolveDefinition(repoRoot, 'schema', name);
      if (schema) copyOne(schema.path, join(destination, 'definitions', 'schemas', name), `definitions/schemas/${name}`, files);
    }
  }

  files.sort();
  const manifest = {
    fadeno_version: packageVersion(),
    run_id: run.runId,
    files: Object.fromEntries(files.map((rel) => {
      const path = join(destination, rel);
      return [rel, sha256(path)];
    })),
  };
  const manifestPath = join(destination, 'manifest.json');
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const hadManifest = existsSync(manifestPath);
  if (hadManifest && readFileSync(manifestPath, 'utf8') !== text) throw new EvidenceError(`evidence destination conflict at ${manifestPath}; refusing to overwrite it.`);
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, text, 'utf8');
  return { run: run.runId, destination, manifest: manifestPath, idempotent: hadManifest, files };
}
