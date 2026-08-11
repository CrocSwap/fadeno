import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSteeringApply, type SteeringApplyResult } from './steering.ts';
import { loadExecutorProfile, readLocalLoadout, readUserLoadout } from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { readUserHarness, userPaths, type UserPathOptions } from '../lib/user-paths.ts';

export class UseError extends Error {}

export interface UseOptions {
  name: string;
  project?: boolean;
  target?: 'codex' | 'claude';
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
}

export interface UseResult {
  name: string;
  scope: 'user' | 'project';
  path: string;
  previous: string | null;
  steering: SteeringApplyResult | null;
  external: Array<{ archetype: string; executor: string; command: string[] }>;
  restartRequired: boolean;
  notices: string[];
}

function projectPin(repoRoot: string): string {
  return join(repoRoot, '.fadeno', 'local', 'loadout');
}

/** Select a loadout at user scope by default; `--project` is the safe override. */
export function runUse(opts: UseOptions): UseResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const name = opts.name.trim();
  if (name.length === 0) throw new UseError('Usage: fadeno use <loadout>');
  const loaded = loadExecutorProfile(repoRoot, opts.userPathOptions);
  if (!(name in loaded.profile.loadouts)) {
    throw new UseError(`"${name}" is not a declared loadout (${Object.keys(loaded.profile.loadouts).sort().join(', ')}).`);
  }
  const scope = opts.project ? 'project' : 'user';
  const paths = userPaths(opts.userPathOptions);
  const path = scope === 'project' ? projectPin(repoRoot) : paths.loadoutFile;
  const previous = scope === 'project' ? readLocalLoadout(repoRoot) : readUserLoadout(opts.userPathOptions);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${name}\n`, 'utf8');

  const slots = loaded.profile.loadouts[name]!;
  const external = Object.entries(slots).flatMap(([archetype, executor]) => {
    const spec = loaded.profile.executors[executor]!;
    return spec.adapter === 'command' ? [{ archetype, executor, command: spec.command }] : [];
  });
  const target = opts.target ?? readUserHarness(opts.userPathOptions);
  const needsNativeMaterialization = target === 'codex' && Object.values(slots).some((executor) => loaded.profile.executors[executor]?.adapter === 'host');
  const steering = needsNativeMaterialization
    ? runSteeringApply({
        repoRoot,
        loadout: name,
        target: 'codex',
        scope: 'user',
        userPathOptions: opts.userPathOptions,
        cliPath: existsSync(paths.managedCli) ? paths.managedCli : undefined,
      })
    : null;
  const steeringChanged = steering?.restartRequired ?? false;
  const notices = external.length > 0
    ? external.map((item) => `${item.archetype} leaves the current harness for ${item.executor} (${item.command.join(' ')}), under its own sandbox; evidence is written to .fadeno/dispatches.jsonl.`)
    : ['native loadout selected; no external sandbox crossing is active.'];
  if ((steering?.conflicts.length ?? 0) > 0) {
    notices.push(`Preserved ${steering!.conflicts.length} unmanaged Codex agent file(s); move them aside or use explicit \`steering apply --force\` to replace them.`);
  } else if (steeringChanged) notices.push('Codex native host slots were materialized automatically; start one fresh Codex session to load them.');
  else if (steering != null) notices.push('Codex native host slots are already materialized; no restart is needed.');
  return {
    name,
    scope,
    path,
    previous,
    steering,
    external,
    restartRequired: steeringChanged,
    notices,
  };
}
