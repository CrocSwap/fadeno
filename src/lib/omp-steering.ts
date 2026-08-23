import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageVersion } from './paths.ts';

export const OMP_STEERING_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;
export type OmpArchetype = (typeof OMP_STEERING_ARCHETYPES)[number];
export type OmpExpectedKind = 'host' | 'command';
export type OmpIssueKind =
  | 'missing'
  | 'unmanaged'
  | 'malformed'
  | 'stale-version'
  | 'digest-drifted'
  | 'contradictory'
  | 'unregistered';

export const OMP_PROJECT_EXTENSION_ENTRY = './.omp/extensions/fadeno-steering.ts';

export interface OmpIssue {
  kind: OmpIssueKind;
  path: string;
  detail: string;
}

export interface OmpFileState {
  path: string;
  present: boolean;
  managed: boolean;
  valid: boolean;
  version: string | null;
  digest: string | null;
  digestValid: boolean | null;
  stale: boolean;
}

export interface OmpSlotState {
  archetype: string;
  expected: OmpExpectedKind | null;
  host: OmpFileState;
  command: OmpFileState;
  contradictory: boolean;
}

export interface OmpMaterialization {
  agentDir: string;
  extensionPath: string;
  settingsPath: string;
  settingsRegistered: boolean;
  slots: OmpSlotState[];
  refusals: OmpFileState[];
  extension: OmpFileState;
  issues: OmpIssue[];
  healthy: boolean;
  restartRequired: boolean;
}

const AGENT_MARK = /<!-- fadeno:managed version=([^\s]+) digest=([0-9a-f]{64}) -->/;
const EXTENSION_MARK = /^\/\/ fadeno:managed version=([^\s]+)(?: digest=([0-9a-f]{64}))?$/m;

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function missing(path: string): OmpFileState {
  return { path, present: false, managed: false, valid: false, version: null, digest: null, digestValid: null, stale: false };
}

function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

function inspectAgent(path: string, issues: OmpIssue[], required: boolean): OmpFileState {
  const text = readText(path);
  if (text == null) {
    if (required) issues.push({ kind: 'missing', path, detail: 'managed omp steering agent is missing' });
    return missing(path);
  }
  const mark = AGENT_MARK.exec(text);
  if (mark == null) {
    issues.push({ kind: 'unmanaged', path, detail: 'omp steering path exists without a Fadeno managed marker' });
    return { path, present: true, managed: false, valid: false, version: null, digest: null, digestValid: null, stale: false };
  }
  const version = mark[1] ?? null;
  const recordedDigest = mark[2] ?? null;
  const withoutMark = text.replace(`${mark[0]}\n`, '');
  const digestValid = recordedDigest != null && digest(withoutMark) === recordedDigest;
  const frontmatter = text.startsWith('---\n') && text.includes('\n---\n');
  const name = /^name:\s*[A-Za-z0-9_-]+\s*$/m.test(text);
  const description = /^description:\s*.+$/m.test(text);
  const valid = frontmatter && name && description;
  const stale = version != null && version !== packageVersion();
  if (!valid) issues.push({ kind: 'malformed', path, detail: 'managed omp agent has malformed name/description frontmatter' });
  if (stale) issues.push({ kind: 'stale-version', path, detail: `managed omp agent is stamped ${version}, current CLI is ${packageVersion()}` });
  if (!digestValid) issues.push({ kind: 'digest-drifted', path, detail: 'managed omp agent content differs from its recorded digest' });
  return { path, present: true, managed: true, valid, version, digest: recordedDigest, digestValid, stale };
}

function inspectExtension(path: string, issues: OmpIssue[]): OmpFileState {
  const text = readText(path);
  if (text == null) {
    issues.push({ kind: 'missing', path, detail: 'omp steering extension is missing' });
    return missing(path);
  }
  const mark = EXTENSION_MARK.exec(text);
  if (mark == null) {
    issues.push({ kind: 'unmanaged', path, detail: 'omp steering extension exists without a Fadeno managed marker' });
    return { path, present: true, managed: false, valid: false, version: null, digest: null, digestValid: null, stale: false };
  }
  const version = mark[1] ?? null;
  const recordedDigest = mark[2] ?? null;
  const withoutMark = text.replace(`${mark[0]}\n`, '');
  const digestValid = recordedDigest != null && digest(withoutMark) === recordedDigest;
  const valid = /export\s+default\s+function/.test(text) && /tool_call/.test(text) && /tasks/.test(text);
  const stale = version != null && version !== packageVersion();
  if (!valid) issues.push({ kind: 'malformed', path, detail: 'managed omp extension has no valid task tool_call hook' });
  if (stale) issues.push({ kind: 'stale-version', path, detail: `managed omp extension is stamped ${version}, current CLI is ${packageVersion()}` });
  if (!digestValid) issues.push({ kind: 'digest-drifted', path, detail: 'managed omp extension content differs from its recorded digest' });
  return { path, present: true, managed: true, valid, version, digest: recordedDigest, digestValid, stale };
}

function inspectSettings(path: string, issues: OmpIssue[]): boolean {
  const text = readText(path);
  if (text == null) {
    issues.push({ kind: 'missing', path, detail: 'omp settings are missing, so the ignored steering extension is not registered' });
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    issues.push({ kind: 'malformed', path, detail: 'omp settings are not valid JSON; Fadeno preserved them and could not register steering' });
    return false;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    issues.push({ kind: 'malformed', path, detail: 'omp settings must be a JSON object; Fadeno preserved the existing value' });
    return false;
  }
  const extensions = (parsed as Record<string, unknown>).extensions;
  if (!Array.isArray(extensions) || !extensions.every((entry) => typeof entry === 'string')) {
    issues.push({ kind: 'malformed', path, detail: 'omp settings extensions must be an array of strings; Fadeno preserved the existing value' });
    return false;
  }
  if (!extensions.includes(OMP_PROJECT_EXTENSION_ENTRY)) {
    issues.push({ kind: 'unregistered', path, detail: `omp settings do not register ${OMP_PROJECT_EXTENSION_ENTRY}` });
    return false;
  }
  return true;
}

function inspectSlotFile(
  agentDir: string,
  archetype: string,
  kind: 'host' | 'command' | 'refusal',
  issues: OmpIssue[],
  required: boolean,
): OmpFileState {
  const preferredName = kind === 'host'
    ? `${archetype}.md`
    : kind === 'command'
      ? `fadeno-dispatch-${archetype}.md`
      : `fadeno-steering-refused-${archetype}.md`;
  const aliasName = `fadeno-steering-${kind}-${archetype}.md`;
  const preferredPath = join(agentDir, preferredName);
  const preferredText = readText(preferredPath);
  // A non-selected static role is a valid omp surface, not a steering
  // contradiction. Only inspect it for ownership when this lane is expected.
  if (!required && preferredText != null && !AGENT_MARK.test(preferredText)) {
    return { path: preferredPath, present: true, managed: false, valid: false, version: null, digest: null, digestValid: null, stale: false };
  }
  const preferred = inspectAgent(preferredPath, issues, required);
  if (preferred.managed) return preferred;
  const alias = inspectAgent(join(agentDir, aliasName), issues, required);
  if (alias.present) return alias;
  if (required && preferred.present) return preferred;
  return preferred;
}

/** Inspect project-local omp steering state without writing or executing it. */
export function inspectOmpMaterialization(
  repoRoot: string,
  expected: ReadonlyMap<string, OmpExpectedKind>,
): OmpMaterialization {
  const agentDir = join(repoRoot, '.omp', 'agents');
  const extensionPath = join(repoRoot, '.omp', 'extensions', 'fadeno-steering.ts');
  const settingsPath = join(repoRoot, '.omp', 'settings.json');
  const issues: OmpIssue[] = [];
  const slots: OmpSlotState[] = [];
  for (const archetype of OMP_STEERING_ARCHETYPES) {
    const host = inspectSlotFile(agentDir, archetype, 'host', issues, expected.get(archetype) === 'host');
    const command = inspectSlotFile(agentDir, archetype, 'command', issues, expected.get(archetype) === 'command');
    const contradictory = host.present && command.present;
    if (contradictory) issues.push({ kind: 'contradictory', path: agentDir, detail: `${archetype} has both host and command steering agents materialized` });
    slots.push({ archetype, expected: expected.get(archetype) ?? null, host, command, contradictory });
  }
  const refusals = OMP_STEERING_ARCHETYPES.map((archetype) => inspectSlotFile(agentDir, archetype, 'refusal', issues, true));
  const extension = inspectExtension(extensionPath, issues);
  const settingsRegistered = inspectSettings(settingsPath, issues);
  return { agentDir, extensionPath, settingsPath, settingsRegistered, slots, refusals, extension, issues, healthy: issues.length === 0, restartRequired: issues.length > 0 };
}
