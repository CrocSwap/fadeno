import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { listDefinitionNames, resolvePlaybookFile, type DefinitionSource } from '../lib/definitions.ts';
import { renderDiagram } from '../lib/diagram.ts';
import { findRepoRoot } from '../lib/paths.ts';

export class PlaybooksError extends Error {}

export interface PlaybookSummary {
  /** The file-stem callers pass to `fadeno playbooks <name>`. */
  name: string;
  description: string;
  when_to_use: string[];
  /** Whether the effective definition came from the project or bundled catalog. */
  source: 'project' | 'builtin';
  path: string;
}

export interface PlaybooksListResult {
  kind: 'list';
  repoRoot: string;
  playbooks: PlaybookSummary[];
}

export interface PlaybooksDetailResult {
  kind: 'detail';
  repoRoot: string;
  playbook: PlaybookSummary;
  /** Existing deterministic ASCII workflow view. */
  diagram: string;
}

export type PlaybooksResult = PlaybooksListResult | PlaybooksDetailResult;

export interface PlaybooksOptions {
  /** An effective definition name; omit it to list the catalog. */
  playbook?: string;
  cwd?: string;
  repoRoot?: string;
}

/**
 * The display shape is intentionally smaller than the playbook schema.
 * `fadeno validate` owns complete schema, reference, and semantic checks;
 * this command only needs metadata plus the flow consumed by renderDiagram.
 */
interface PlaybookDisplayDocument {
  description?: unknown;
  when_to_use?: unknown;
  flow?: unknown;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function invalidDisplay(source: DefinitionSource, detail: string): never {
  throw new PlaybooksError(`Effective playbook ${source.path} cannot be displayed: ${detail}. Run \`fadeno validate\` for full validation.`);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Parse exactly the display fields in the effective file chosen by the shared resolver. */
function readSummary(name: string, source: DefinitionSource): { summary: PlaybookSummary; document: PlaybookDisplayDocument } {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(source.path, 'utf8'));
  } catch (err) {
    throw new PlaybooksError(`Could not parse effective playbook ${source.path}: ${(err as Error).message}`);
  }
  if (!isObject(parsed)) invalidDisplay(source, 'expected a YAML mapping');
  const document = parsed as PlaybookDisplayDocument;
  if (typeof document.description !== 'string' || document.description.trim().length === 0) {
    invalidDisplay(source, 'missing a description');
  }
  if (!Array.isArray(document.flow) || document.flow.length === 0) invalidDisplay(source, 'missing a flow list');
  if (document.when_to_use != null && (!Array.isArray(document.when_to_use) || !document.when_to_use.every((item) => typeof item === 'string'))) {
    invalidDisplay(source, 'when_to_use must be a list of strings');
  }
  if (source.kind === 'snapshot') invalidDisplay(source, 'snapshot definitions are not part of the effective catalog');
  const whenToUse = document.when_to_use == null ? [] : (document.when_to_use as string[]).map(oneLine);

  return {
    summary: {
      name,
      description: oneLine(document.description),
      when_to_use: whenToUse,
      source: source.kind,
      path: source.path,
    },
    document,
  };
}

/** List the effective bundled-plus-project catalog, or render one effective workflow. */
export function runPlaybooks(opts: PlaybooksOptions = {}): PlaybooksResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  if (opts.playbook == null) {
    const playbooks = listDefinitionNames(repoRoot).map((name) => {
      const source = resolvePlaybookFile(repoRoot, name);
      if (source == null) throw new PlaybooksError(`Effective playbook "${name}" could not be resolved.`);
      return readSummary(name, source).summary;
    });
    return { kind: 'list', repoRoot, playbooks };
  }

  const source = resolvePlaybookFile(repoRoot, opts.playbook);
  if (source == null) throw new PlaybooksError(`Playbook "${opts.playbook}" not found in bundled or project definitions.`);
  const { summary, document } = readSummary(opts.playbook.replace(/\.ya?ml$/i, ''), source);
  return { kind: 'detail', repoRoot, playbook: summary, diagram: renderDiagram(document, 'ascii') };
}
