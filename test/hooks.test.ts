import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { tempRepo } from './helpers.ts';

function runShell(command: string, cwd: string, path: string): number {
  try {
    execFileSync('/bin/sh', ['-c', command], { cwd, env: { ...process.env, PATH: `${path}:${process.env.PATH ?? ''}` }, stdio: 'pipe' });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
}

test('Claude Stop hook handles missing runs and preserves gate failures', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'claude', repoRoot: root, withHooks: true });
  const settings = JSON.parse(readFileSync(join(root, '.fadeno', 'hooks', 'claude-settings.example.json'), 'utf8')) as {
    hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
  };
  const command = settings.hooks.Stop[0]!.hooks[0]!.command;

  const mockBin = join(root, 'mock-bin');
  mkdirSync(mockBin);
  const fadeno = join(mockBin, 'fadeno');
  writeFileSync(fadeno, '#!/bin/sh\nif grep -Rq "blocking" .fadeno/runs 2>/dev/null; then exit 1; fi\nexit 0\n');
  chmodSync(fadeno, 0o755);

  assert.equal(runShell(command, root, mockBin), 0); // no run: explicit early success

  const { runDir } = runNewRun({ repoRoot: root, playbook: 'code-change-review', task: 'hook test' });
  writeFileSync(join(runDir, 'artifacts', 'review-report.json'), JSON.stringify({ reviewer: 'r', summary: 'ok', issues: [], verdict: 'approve' }));
  assert.equal(runShell(command, root, mockBin), 0);
  writeFileSync(join(runDir, 'artifacts', 'review-report.json'), JSON.stringify({ reviewer: 'r', summary: 'blocked', issues: [{ severity: 'blocking', title: 'x' }], verdict: 'request_changes' }));
  assert.equal(runShell(command, root, mockBin), 1);
});
