import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_ARCHETYPE_DESCRIPTIONS,
  CONTRACT_FOOTER,
  CONTRACT_HEADER,
  composeWorkerPrompt,
  describeArchetype,
  formatAge,
  hostVocabulary,
  nagText,
  spawnRefusedByLimit,
  workerContract,
} from '../src/lib/contracts.ts';
import { correlate, type OpenedRow } from '../src/lib/ledger.ts';

function opened(id: string, overrides: Partial<OpenedRow> = {}): OpenedRow {
  return {
    row: 'opened', id, name: `worker-${id}`, at: '2026-09-07T10:00:00.000Z', session: null, parent: null,
    archetype: 'worker', model: 'luna', effort: 'xhigh', explicit_model: null, lane: 'host', harness: 'claude',
    workspace: { path: `.fadeno/local/worktrees/worker-${id}`, branch: `fadeno/worker-${id}`, base: 'abc' },
    task: 'x', prompt: `.fadeno/prompts/${id}.md`, ...overrides,
  };
}

const WT = { kind: 'worktree' as const, absolute: '/repo/.fadeno/local/worktrees/fix-login', branch: 'fadeno/fix-login', base: 'abcdef1234567890', upstream: 'main' };

test('the worker contract names the worktree, the branch, what to merge from, and what the final message must say', () => {
  const text = workerContract({ id: 'id-1', name: 'fix-login', archetype: 'worker', repoRoot: '/repo', worktree: WT });
  assert.ok(text.startsWith(`${CONTRACT_HEADER} id-1 (fix-login)`));
  assert.ok(text.trimEnd().endsWith(CONTRACT_FOOTER));
  assert.match(text, /`\/repo\/\.fadeno\/local\/worktrees\/fix-login`, on branch `fadeno\/fix-login`, cut from `main` at `abcdef123456`/);
  assert.match(text, /merge `main` into your branch and resolve any conflicts in your own worktree/);
  assert.match(text, /commit it on your branch/);
  assert.match(text, /anything untracked/);
  assert.match(text, /Recommend whether your work should be merged or discarded/);
  assert.match(text, /report the work as unverified/, 'the tracked-content-only lesson travels with the worktree');
  assert.doesNotMatch(text, /git checkout/, 'the shared-tree git rules are not preached to an agent that owns its tree');
});

test('a shared-tree dispatch is told so, told why, and told the git rules that protect other people\'s work', () => {
  const text = workerContract({
    id: 'id-2', name: 'hot', archetype: 'worker', repoRoot: '/repo',
    worktree: { kind: 'shared', reason: 'git worktree add failed: not a git repository' },
  });
  assert.match(text, /shared tree at `\/repo` \(no worktree was cut: git worktree add failed: not a git repository\)/);
  assert.match(text, /Never run `git checkout`, `switch`, `restore`, `reset`, `stash` or `clean` in a shared tree/);
  assert.doesNotMatch(text, /merge `.*` into your branch/);
  const requested = workerContract({ id: 'id-3', name: 'hot', archetype: 'worker', repoRoot: '/repo', worktree: { kind: 'shared', reason: null } });
  assert.match(requested, /shared tree at `\/repo`\. Other agents/);
});

test('the contract is appended after the caller\'s prompt, never before it', () => {
  const contract = workerContract({ id: 'id', name: 'n', archetype: 'reviewer', repoRoot: '/r', worktree: WT });
  const composed = composeWorkerPrompt('Review the retry logic.\n\n', contract);
  assert.ok(composed.startsWith('Review the retry logic.\n\n## Fadeno dispatch'));
  assert.ok(composed.endsWith(`${CONTRACT_FOOTER}\n`));
  assert.match(composed, /You are the `reviewer`/);
});

test('describeArchetype prefers the catalog, falls back to the builtin five, and never answers with nothing', () => {
  assert.equal(describeArchetype('worker', '  Custom worker text. '), 'Custom worker text.');
  assert.equal(describeArchetype('scout', null), BUILTIN_ARCHETYPE_DESCRIPTIONS.scout);
  assert.match(describeArchetype('auditor', undefined), /add one under `archetypes\.auditor\.description`/);
  assert.deepEqual(Object.keys(BUILTIN_ARCHETYPE_DESCRIPTIONS), ['director', 'worker', 'reviewer', 'judge', 'scout']);
});

test('the host vocabulary carries the archetype list with live routing, the spawn rules, the close obligation, and the nag', () => {
  const unclosed = correlate([opened('a', { name: 'fix-login' })]);
  const text = hostVocabulary({
    archetypes: [
      { name: 'worker', description: 'Implements.', model: 'luna', effort: 'xhigh', source: 'repo dial' },
      { name: 'reviewer', description: 'Reviews.', model: 'current-host', effort: null, source: 'base' },
    ],
    unclosed,
    unclosedLimit: 5,
    now: new Date('2026-09-07T10:30:00Z'),
  });
  assert.match(text, /\*\*worker\*\* — Implements\. _\(routes to luna@xhigh; repo dial\)_/);
  assert.match(text, /\*\*reviewer\*\* — Reviews\. _\(routes to this session's own model; base\)_/);
  assert.match(text, /`fadeno:worker` on Claude Code; `worker` on Codex/);
  assert.match(text, /fadeno dispatch --archetype <name> --prompt-file <file>/, 'a director with no hook still knows the command lane');
  assert.match(text, /Two agents must never share one tree/);
  assert.match(text, /That recommendation is a claim, not a finding/);
  assert.match(text, /fadeno dispatch-close <name\|id> --merged\|--kept\|--discarded\|--failed/);
  assert.match(text, /Fadeno performs no merge; you do/);
  assert.match(text, /refuses a new one at 5 unclosed/);
  assert.match(text, /Report it with the dispatch id and the error text, and do not substitute/);
  assert.match(text, /## Unclosed dispatches \(1 of 5 allowed\)/);
  assert.match(text, /- `fix-login` a — worker on `fadeno\/worker-a`, open, 30m old/);
});

test('the nag names every unclosed dispatch, says which are stopped and awaiting a decision, and announces the limit', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const rows = [
    opened('1', { name: 'one', at: '2026-09-08T11:50:00Z' }),
    opened('2', { name: 'two', at: '2026-09-08T09:00:00Z', parent: '11111111-aaaa', workspace: null, archetype: 'scout' }),
    { row: 'stopped' as const, id: '2', at: '2026-09-08T10:00:00Z', final_message: 'done', dirty: { paths: [], truncated: false } },
  ];
  const unclosed = correlate(rows);
  const text = nagText(unclosed, 5, now);
  assert.match(text, /## Unclosed dispatches \(2 of 5 allowed\)/);
  assert.match(text, /- `one` 1 — worker on `fadeno\/worker-1`, open, 10m old/);
  assert.match(text, /- `two` 2 — scout, stopped, awaiting your decision, 3h old \(spawned by 11111111\)/);
  assert.doesNotMatch(text, /At the limit/);
  assert.match(nagText(unclosed, 2, now), /\*\*At the limit\.\*\* The next spawn is refused/);
  assert.equal(nagText([], 5, now), 'No unclosed dispatches in this repository.');
});

test('the limit refuses at the threshold, names the oldest, and asks for the refusal to be reported', () => {
  const unclosed = correlate(['1', '2', '3', '4', '5', '6'].map((id) => opened(id, { name: `job-${id}` })));
  assert.equal(spawnRefusedByLimit(unclosed.slice(0, 4), 5), null);
  const refused = spawnRefusedByLimit(unclosed, 5);
  assert.match(refused ?? '', /6 dispatches are unclosed and the limit is 5/);
  assert.match(refused ?? '', /`job-1`, `job-2`, `job-3`, `job-4`, `job-5`, …/);
  assert.match(refused ?? '', /Report this refusal to the user instead of routing around it\./);
});

test('formatAge reads like a clock at every magnitude', () => {
  assert.equal(formatAge(null), '?');
  assert.equal(formatAge(5), '5m');
  assert.equal(formatAge(125), '2h');
  assert.equal(formatAge(60 * 50), '2d');
});
