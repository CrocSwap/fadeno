import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { renderDiagram, type DiagramFormat } from '../lib/diagram.ts';
import { findRepoRoot } from '../lib/paths.ts';

export class DiagramError extends Error {}

export interface DiagramOptions {
  /** Playbook name (under .fadeno/playbooks) or a path to a YAML file. */
  playbook: string;
  format?: DiagramFormat;
  cwd?: string;
  repoRoot?: string;
}

function resolvePlaybookFile(repoRoot: string, cwd: string, ref: string): string {
  if (isAbsolute(ref) || ref.includes('/') || /\.ya?ml$/i.test(ref)) {
    const direct = isAbsolute(ref) ? ref : resolve(cwd, ref);
    if (existsSync(direct)) return direct;
  }
  const stripped = ref.replace(/\.(ya?ml)$/i, '');
  for (const candidate of [`${stripped}.yaml`, `${stripped}.yml`]) {
    const path = join(repoRoot, '.fadeno', 'playbooks', candidate);
    if (existsSync(path)) return path;
  }
  throw new DiagramError(`Playbook "${ref}" not found (looked under .fadeno/playbooks).`);
}

/** Render a playbook's control flow as ASCII (default) or Mermaid. */
export function runDiagram(opts: DiagramOptions): string {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const file = resolvePlaybookFile(repoRoot, cwd, opts.playbook);

  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new DiagramError(`Could not parse ${file}: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray((doc as { flow?: unknown }).flow)) {
    throw new DiagramError(`${file} is not a playbook (missing a flow list).`);
  }

  return renderDiagram(doc, opts.format ?? 'ascii');
}
