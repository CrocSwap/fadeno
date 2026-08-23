import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packageVersion } from './paths.ts';

export const OPENCODE_STEERING_ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;
export type OpenCodeArchetype = (typeof OPENCODE_STEERING_ARCHETYPES)[number];
export type OpenCodeExpectedKind = 'host' | 'command';
export type OpenCodeIssueKind =
  | 'missing'
  | 'unmanaged'
  | 'malformed'
  | 'stale-version'
  | 'digest-drifted'
  | 'contradictory';

export interface OpenCodeIssue {
  kind: OpenCodeIssueKind;
  path: string;
  detail: string;
}

export interface OpenCodeFileState {
  path: string;
  present: boolean;
  managed: boolean;
  valid: boolean;
  version: string | null;
  digest: string | null;
  digestValid: boolean | null;
  stale: boolean;
}

export interface OpenCodeSlotState {
  archetype: string;
  expected: OpenCodeExpectedKind | null;
  host: OpenCodeFileState;
  command: OpenCodeFileState;
  contradictory: boolean;
}

export interface OpenCodeMaterialization {
  agentDir: string;
  pluginPath: string;
  slots: OpenCodeSlotState[];
  refusals: OpenCodeFileState[];
  plugin: OpenCodeFileState;
  issues: OpenCodeIssue[];
  healthy: boolean;
  restartRequired: boolean;
}

const AGENT_MARK = /<!-- fadeno:managed version=([^\s]+) digest=([0-9a-f]{64}) -->/;
const PLUGIN_MARK = /^\/\/ fadeno:managed version=([^\s]+)(?: digest=([0-9a-f]{64}))?$/m;

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function missing(path: string): OpenCodeFileState {
  return {
    path,
    present: false,
    managed: false,
    valid: false,
    version: null,
    digest: null,
    digestValid: null,
    stale: false,
  };
}

function readText(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

function inspectAgent(path: string, issues: OpenCodeIssue[], required = true): OpenCodeFileState {
  const text = readText(path);
  if (text == null) {
    if (required) issues.push({ kind: 'missing', path, detail: 'managed OpenCode steering file is missing' });
    return missing(path);
  }
  const mark = AGENT_MARK.exec(text);
  if (mark == null) {
    issues.push({ kind: 'unmanaged', path, detail: 'OpenCode steering path exists without a Fadeno managed marker' });
    return {
      path,
      present: true,
      managed: false,
      valid: false,
      version: null,
      digest: null,
      digestValid: null,
      stale: false,
    };
  }
  const version = mark[1] ?? null;
  const recordedDigest = mark[2] ?? null;
  const withoutMark = text.replace(`${mark[0]}\n`, '');
  const digestValid = recordedDigest != null && digest(withoutMark) === recordedDigest;
  const frontmatter = text.startsWith('---\n') && text.includes('\n---\n');
  const mode = /^mode:\s*subagent\s*$/m.test(text);
  const valid = frontmatter && mode;
  const stale = version != null && version !== packageVersion();
  if (!valid) issues.push({ kind: 'malformed', path, detail: 'managed OpenCode agent has malformed frontmatter or is not a subagent' });
  if (stale) issues.push({ kind: 'stale-version', path, detail: `managed OpenCode agent is stamped ${version}, current CLI is ${packageVersion()}` });
  if (!digestValid) issues.push({ kind: 'digest-drifted', path, detail: 'managed OpenCode agent content differs from its recorded digest' });
  return { path, present: true, managed: true, valid, version, digest: recordedDigest, digestValid, stale };
}

function inspectPlugin(path: string, issues: OpenCodeIssue[]): OpenCodeFileState {
  const text = readText(path);
  if (text == null) {
    issues.push({ kind: 'missing', path, detail: 'OpenCode steering plugin is missing' });
    return missing(path);
  }
  const mark = PLUGIN_MARK.exec(text);
  if (mark == null) {
    issues.push({ kind: 'unmanaged', path, detail: 'OpenCode steering plugin exists without a Fadeno managed marker' });
    return { path, present: true, managed: false, valid: false, version: null, digest: null, digestValid: null, stale: false };
  }
  const version = mark[1] ?? null;
  const recordedDigest = mark[2] ?? null;
  const withoutMark = text.replace(`${mark[0]}\n`, '');
  const digestValid = recordedDigest != null && digest(withoutMark) === recordedDigest;
  const stale = version != null && version !== packageVersion();
  const valid = /export\s+default\s+async\s+function\s+FadenoSteering/.test(text) && /tool\.execute\.before/.test(text);
  if (!valid) issues.push({ kind: 'malformed', path, detail: 'managed OpenCode steering plugin has no valid default hook export' });
  if (stale) issues.push({ kind: 'stale-version', path, detail: `managed OpenCode plugin is stamped ${version}, current CLI is ${packageVersion()}` });
  if (!digestValid) issues.push({ kind: 'digest-drifted', path, detail: 'managed OpenCode plugin content differs from its recorded digest' });
  return { path, present: true, managed: true, valid, version, digest: recordedDigest, digestValid, stale };
}

/** Inspect only materialized OpenCode steering state; never writes or executes it. */
export function inspectOpenCodeMaterialization(
  repoRoot: string,
  expected: ReadonlyMap<string, OpenCodeExpectedKind>,
): OpenCodeMaterialization {
  const agentDir = join(repoRoot, '.opencode', 'agent');
  const pluginPath = join(repoRoot, '.opencode', 'plugin', 'fadeno-steering.js');
  const issues: OpenCodeIssue[] = [];
  const slots: OpenCodeSlotState[] = [];
  for (const archetype of OPENCODE_STEERING_ARCHETYPES) {
    const hostPath = join(agentDir, `${archetype}.md`);
    const commandPath = join(agentDir, `fadeno-dispatch-${archetype}.md`);
    const expectedKind = expected.get(archetype) ?? null;
    const host = inspectAgent(hostPath, issues, expectedKind === 'host');
    const command = inspectAgent(commandPath, issues, expectedKind === 'command');
    const contradictory = host.present && command.present;
    if (contradictory) {
      issues.push({ kind: 'contradictory', path: agentDir, detail: `${archetype} has both host and command steering files materialized` });
    }
    slots.push({ archetype, expected: expectedKind, host, command, contradictory });
  }
  const refusals = OPENCODE_STEERING_ARCHETYPES.map((archetype) =>
    inspectAgent(join(agentDir, `fadeno-steering-refused-${archetype}.md`), issues),
  );
  const plugin = inspectPlugin(pluginPath, issues);
  return {
    agentDir,
    pluginPath,
    slots,
    refusals,
    plugin,
    issues,
    healthy: issues.length === 0,
    restartRequired: issues.length > 0,
  };
}
