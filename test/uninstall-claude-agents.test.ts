import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runUninstall } from '../src/commands/uninstall.ts';
import type { UserPathOptions } from '../src/lib/user-paths.ts';
import { tempRepo } from './helpers.ts';

// `fadeno steering apply --claude` wrote the identity grid straight into
// `~/.claude/agents`, outside the installation manifest — so uninstall never
// knew about it and left it behind. The grid is retired now (effort decides
// the lane), which makes those cells doubly wrong to leave: the harness still
// registers them at session start, for a Fadeno that is no longer installed.

function isolatedUser(t: TestContext): { root: string; user: UserPathOptions; agents: string } {
  const root = tempRepo(t);
  const user: UserPathOptions = {
    home: join(root, 'home'),
    env: {
      FADENO_CONFIG_HOME: join(root, 'user-config'),
      FADENO_STATE_HOME: join(root, 'user-state'),
      FADENO_DATA_HOME: join(root, 'user-data'),
    },
  };
  const agents = join(root, 'home', '.claude', 'agents');
  mkdirSync(agents, { recursive: true });
  return { root, user, agents };
}

function gridCell(archetype: string, effort: string): string {
  return `---\nname: fadeno-${archetype}-${effort}\nmodel: inherit\neffort: ${effort}\n---\n\nBody.\n\n` +
    `<!-- fadeno:managed version=0.6.0-rc.34 digest=deadbeef source=grid:${archetype}@${effort} -->\n`;
}

test('uninstall --claude takes the retired identity grid with it', (t) => {
  const { user, agents } = isolatedUser(t);
  writeFileSync(join(agents, 'fadeno-worker-xhigh.md'), gridCell('worker', 'xhigh'));
  writeFileSync(join(agents, 'fadeno-judge-low.md'), gridCell('judge', 'low'));

  const result = runUninstall({ target: 'claude', userPathOptions: user });

  assert.deepEqual(result.removed.slice().sort(), [
    join(agents, 'fadeno-judge-low.md'),
    join(agents, 'fadeno-worker-xhigh.md'),
  ]);
  assert.deepEqual(result.preserved, []);
  assert.equal(existsSync(join(agents, 'fadeno-worker-xhigh.md')), false);
});

test('uninstall --claude preserves an agent file that is not Fadeno-managed, whatever it is named', (t) => {
  const { user, agents } = isolatedUser(t);
  const mine = '---\nname: fadeno-worker-xhigh\nmodel: inherit\neffort: xhigh\n---\n\nMine, not yours.\n';
  writeFileSync(join(agents, 'fadeno-worker-xhigh.md'), mine);
  // A managed marker alone is not enough either: only the grid's own
  // `source=grid:` stamp licenses a delete on this surface.
  const otherManaged = '---\nname: helper\n---\n\nx\n\n<!-- fadeno:managed version=0.0.1 digest=x source=fable -->\n';
  writeFileSync(join(agents, 'helper.md'), otherManaged);

  const result = runUninstall({ target: 'claude', userPathOptions: user });

  assert.deepEqual(result.removed, []);
  assert.equal(readFileSync(join(agents, 'fadeno-worker-xhigh.md'), 'utf8'), mine);
  assert.equal(readFileSync(join(agents, 'helper.md'), 'utf8'), otherManaged);
});

test('uninstall --codex is unaffected by what sits in the Claude agent directory', (t) => {
  const { user, agents } = isolatedUser(t);
  writeFileSync(join(agents, 'fadeno-worker-xhigh.md'), gridCell('worker', 'xhigh'));

  const result = runUninstall({ target: 'codex', userPathOptions: user });

  assert.deepEqual(result.removed, []);
  assert.equal(existsSync(join(agents, 'fadeno-worker-xhigh.md')), true);
});
