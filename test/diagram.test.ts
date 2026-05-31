import assert from 'node:assert/strict';
import test from 'node:test';
import { runDiagram, DiagramError } from '../src/commands/diagram.ts';
import { runInit } from '../src/commands/init.ts';
import { tempRepo } from './helpers.ts';

function initRepo(t: Parameters<typeof tempRepo>[0]): string {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  return root;
}

test('ascii diagram renders cards with abbreviated kinds, gate branches, loop body and terminal', (t) => {
  const root = initRepo(t);
  const out = runDiagram({ repoRoot: root, playbook: 'code-change-review' });
  assert.match(out, /entry: plan/);
  assert.match(out, /┌─ plan .* actor ─┐/); // boxed card; actor_call abbreviated to "actor"
  assert.match(out, /┌─ review_gate .* gate ─┐/);
  assert.match(out, /✓ pass ▶ test/);
  assert.match(out, /✗ fail ▶ revise/);
  assert.match(out, /body: implement_revision ▶ review_revision/);
  assert.match(out, /⤓ exhausted ▶ summarize_best_attempt/);
  assert.match(out, /■ end/);
  assert.match(out, /▼/); // fall-through connector
  assert.match(out, /⋮/); // branch-driven continuation
  assert.doesNotMatch(out, /actor_call/); // kinds are abbreviated for display
});

test('mermaid diagram is a flowchart with shaped nodes and labelled edges', (t) => {
  const root = initRepo(t);
  const out = runDiagram({ repoRoot: root, playbook: 'pr-review', format: 'mermaid' });
  assert.match(out, /^flowchart TD/m);
  assert.match(out, /decision_gate\{/); // gate → diamond
  assert.match(out, /post_gate\{\{/); // human_gate → hexagon
  assert.match(out, /decision_gate -->\|pass\| approve/);
  assert.match(out, /decision_gate -->\|fail\| request_changes/);
  assert.match(out, /post_gate -->\|approve\| post/);
});

test('all starter playbooks render in both formats without throwing', (t) => {
  const root = initRepo(t);
  for (const pb of ['code-change-review', 'research-synthesis', 'pr-review']) {
    for (const format of ['ascii', 'mermaid'] as const) {
      assert.doesNotThrow(() => runDiagram({ repoRoot: root, playbook: pb, format }));
    }
  }
});

test('diagram errors on an unknown playbook', (t) => {
  const root = initRepo(t);
  assert.throws(() => runDiagram({ repoRoot: root, playbook: 'nope' }), DiagramError);
});
