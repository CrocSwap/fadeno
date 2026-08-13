import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSteeringApply, type SteeringApplyResult } from './steering.ts';
import {
  activeHarness,
  loadExecutorProfile,
  readLocalLoadoutState,
  readUserLoadout,
  writeLocalLoadoutState,
} from '../lib/executors.ts';
import { maintainedHarnesses } from '../lib/installations.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { userPaths, type UserPathOptions } from '../lib/user-paths.ts';

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
  /**
   * Session overrides the project pin carried and this selection discarded.
   * Always `{}` at user scope — only the project pin can hold an overlay.
   */
  droppedOverrides: Record<string, string>;
}

/** Select a loadout at user scope by default; `--project` is the safe override. */
export function runUse(opts: UseOptions): UseResult {
  const repoRoot = opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd());
  const name = opts.name.trim();
  if (name.length === 0) throw new UseError('Usage: fadeno use <loadout>');
  // Which harness's routes to describe: the one in front of you.
  const target = opts.target ?? activeHarness(undefined, opts.userPathOptions);
  const loaded = loadExecutorProfile(repoRoot, opts.userPathOptions, target);
  if (!(name in loaded.profile.loadouts)) {
    throw new UseError(`"${name}" is not a declared loadout (${Object.keys(loaded.profile.loadouts).sort().join(', ')}).`);
  }
  const scope = opts.project ? 'project' : 'user';
  const paths = userPaths(opts.userPathOptions);
  // The project pin is the file session overrides decorate, so it is written
  // through the kernel writer: selecting a base rewrites it as a bare name and
  // any overlay dialed against the previous base goes with it.
  const pin = scope === 'project' ? readLocalLoadoutState(repoRoot) : null;
  const droppedOverrides = pin?.overrides ?? {};
  const previous = scope === 'project' ? pin!.loadout : readUserLoadout(opts.userPathOptions);
  let path: string;
  if (scope === 'project') {
    path = writeLocalLoadoutState(repoRoot, { loadout: name, overrides: {} });
  } else {
    path = paths.loadoutFile;
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `${name}\n`, 'utf8');
  }

  const slots = loaded.profile.loadouts[name]!;
  const external = Object.entries(slots).flatMap(([archetype, executor]) => {
    const spec = loaded.profile.executors[executor]!;
    return spec.adapter === 'command' ? [{ archetype, executor, command: spec.command }] : [];
  });
  // Materialize by what this machine maintains, not by where you are sitting.
  // Codex binds role agents to files at session start, so a loadout switched
  // from a Claude session leaves them naming the previous executor until
  // something rewrites them — and nothing else will. An explicit `--target`
  // still scopes the write, since that is the caller saying what they mean.
  const codexMaintained = opts.target != null
    ? opts.target === 'codex'
    : maintainedHarnesses(opts.userPathOptions).includes('codex');
  // Host slots are harness-dependent, so ask the codex catalog which archetypes
  // need an agent — the active profile would answer for the wrong harness.
  const codexSlots = codexMaintained
    ? (target === 'codex' ? loaded.profile : loadExecutorProfile(repoRoot, opts.userPathOptions, 'codex').profile)
    : null;
  const needsHostMaterialization = codexSlots != null &&
    Object.values(slots).some((executor) => codexSlots.executors[executor]?.adapter === 'host');
  const steering = needsHostMaterialization
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
  } else if (steeringChanged) {
    const allHostSlotsFallback = Object.values(slots).every((executor) => {
      const spec = loaded.profile.executors[executor]!;
      return spec.adapter !== 'host' || spec.fallbackCommand != null;
    });
    notices.push(
      allHostSlotsFallback
        ? 'Codex host slots were materialized automatically. Declared command fallbacks work now; restart only to deliver the new slots in-session.'
        : 'Codex host slots were materialized automatically; a fresh Codex session is required for slots without a command fallback.',
    );
  }
  else if (steering != null) notices.push('Codex host slots are already materialized; no restart is needed.');
  // A silently discarded overlay is how a user keeps paying for the executor
  // they thought they had switched away from — say it, with the bindings named.
  const droppedNames = Object.keys(droppedOverrides).sort();
  if (droppedNames.length > 0) {
    notices.push(
      `dropped ${droppedNames.length} session override(s) pinned over "${previous ?? '?'}" ` +
        `(${droppedNames.map((archetype) => `${archetype}→${droppedOverrides[archetype]}`).join(', ')}); ` +
        're-dial with `fadeno loadout set <archetype> <executor>` if still wanted.',
    );
  }
  return {
    name,
    scope,
    path,
    previous,
    steering,
    external,
    restartRequired: steeringChanged,
    notices,
    droppedOverrides,
  };
}
