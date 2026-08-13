import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot, templatesDir } from './paths.ts';

export type DefinitionKind = 'playbook' | 'schema' | 'vocabulary' | 'enforcement' | 'executors';

export interface DefinitionSource {
  kind: 'snapshot' | 'project' | 'builtin';
  path: string;
}

function projectRoot(repoRoot: string): string {
  return join(repoRoot, '.fadeno');
}

function builtinRoot(): string {
  return join(templatesDir(), 'common', 'fadeno');
}

/** Effective project definitions: a project file shadows the bundled file. */
export function resolveDefinition(
  repoRoot: string,
  kind: DefinitionKind,
  name?: string,
): DefinitionSource | null {
  const projectBase = projectRoot(repoRoot);
  const builtinBase = builtinRoot();
  const project = name == null
    ? join(projectBase, `${kind}.md`)
    : kind === 'playbook'
      ? join(projectBase, 'playbooks', name)
      : join(projectBase, 'schemas', name);
  const builtin = name == null
    ? join(builtinBase, `${kind}.md`)
    : kind === 'playbook'
      ? join(builtinBase, 'playbooks', name)
      : join(builtinBase, 'schemas', name);
  if (existsSync(project)) return { kind: 'project', path: project };
  if (existsSync(builtin)) return { kind: 'builtin', path: builtin };
  return null;
}

function namesIn(dir: string, suffix: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && suffix.test(entry.name))
    .map((entry) => entry.name);
}

/** List effective built-in-plus-project playbooks, project names winning. */
export function listDefinitionNames(repoRoot: string, kind: 'playbook' = 'playbook'): string[] {
  const projectDir = join(projectRoot(repoRoot), `${kind}s`);
  const builtinDir = join(builtinRoot(), `${kind}s`);
  const names = new Set<string>();
  for (const file of [...namesIn(builtinDir, /\.ya?ml$/i), ...namesIn(projectDir, /\.ya?ml$/i)]) {
    names.add(file.replace(/\.ya?ml$/i, ''));
  }
  return [...names].sort();
}

export function resolvePlaybookFile(repoRoot: string, name: string): DefinitionSource | null {
  const stripped = name.replace(/\.ya?ml$/i, '');
  for (const suffix of ['.yaml', '.yml']) {
    const found = resolveDefinition(repoRoot, 'playbook', `${stripped}${suffix}`);
    if (found) return found;
  }
  return null;
}

/** A run snapshot is authoritative; live project/bundled definitions are fallback only. */
export function resolveRunPlaybookFile(runDir: string, repoRoot: string, name: string): DefinitionSource | null {
  const snapshot = join(runDir, 'definitions', 'playbook.yaml');
  return existsSync(snapshot) ? { kind: 'snapshot', path: snapshot } : resolvePlaybookFile(repoRoot, name);
}

/** Project schemas override only the matching bundled schema. */
export function schemaDirectories(repoRoot: string): { project: string; builtin: string } {
  return {
    project: join(projectRoot(repoRoot), 'schemas'),
    builtin: join(builtinRoot(), 'schemas'),
  };
}

export function runSchemaDirectories(runDir: string, repoRoot: string): { snapshot: string; project: string; builtin: string } {
  return {
    snapshot: join(runDir, 'definitions', 'schemas'),
    ...schemaDirectories(repoRoot),
  };
}

export function definitionSourceSummary(repoRoot: string): {
  project: string;
  builtin: string;
  playbooks: string[];
  /** How many effective names come from a file under `.fadeno/playbooks/`. */
  projectPlaybooks: number;
} {
  const projectNames = new Set(
    namesIn(join(projectRoot(repoRoot), 'playbooks'), /\.ya?ml$/i).map((file) =>
      file.replace(/\.ya?ml$/i, ''),
    ),
  );
  const playbooks = listDefinitionNames(repoRoot);
  return {
    project: projectRoot(repoRoot),
    builtin: builtinRoot(),
    playbooks,
    projectPlaybooks: playbooks.filter((name) => projectNames.has(name)).length,
  };
}

export function effectiveRepoRoot(cwd = process.cwd()): string {
  return findRepoRoot(cwd);
}
