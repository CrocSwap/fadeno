import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_ARCHETYPE_DESCRIPTIONS,
  CONTRACT_FOOTER,
  CONTRACT_HEADER,
  awaitingDecision,
  composeWorkerPrompt,
  describeArchetype,
  formatAge,
  hostVocabulary,
  hostTurnReminder,
  nagText,
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

test('the common contract names the worktree and makes implementation duties task-conditional', () => {
  const text = workerContract({ id: 'id-1', name: 'fix-login', archetype: 'worker', repoRoot: '/repo', worktree: WT });
  assert.ok(text.startsWith(`${CONTRACT_HEADER} id-1 (fix-login)`));
  assert.ok(text.trimEnd().endsWith(CONTRACT_FOOTER));
  assert.match(text, /assigned worktree is `\/repo\/\.fadeno\/local\/worktrees\/fix-login`, on branch `fadeno\/fix-login`, cut from `main` at `abcdef123456`/);
  assert.match(text, /For implementation or integration, make the requested changes in the assigned tree, commit them/);
  assert.match(text, /when you have an isolated branch, merge `main` into your own tree/);
  assert.match(text, /A caller-authorized read-only inspection outside the assigned tree, including the main repository or another source tree, is allowed/);
  assert.match(text, /anything untracked/);
  assert.match(text, /For implementation or integration work, recommend whether the result should be merged, kept, discarded, or failed/);
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
  assert.match(text, /Assigned-tree containment applies to modifications and commits/);
  assert.match(text, /caller-authorized read-only inspection outside the assigned tree/);
  assert.doesNotMatch(text, /merge `.*` into your branch/);
  const requested = workerContract({ id: 'id-3', name: 'hot', archetype: 'worker', repoRoot: '/repo', worktree: { kind: 'shared', reason: null } });
  assert.match(requested, /shared tree at `\/repo`\. Other agents/);
});

test('the common contract gives report-only roles a reviewed completion and preserves director and custom duties', () => {
  for (const archetype of ['reviewer', 'scout', 'judge']) {
    const text = workerContract({ id: `id-${archetype}`, name: archetype, archetype, repoRoot: '/repo', worktree: WT });
    assert.match(text, /For a report-only task \(such as review, exploration, or judging\), inspect what the caller authorized, change nothing/);
    assert.match(text, /do not fabricate a commit or merge/);
    assert.match(text, /recommend `reviewed`/);
    assert.match(text, /For report-only work, recommend `reviewed` in one line/);
  }
  const director = workerContract({ id: 'id-director', name: 'lead', archetype: 'director', repoRoot: '/repo', worktree: WT });
  assert.match(director, /A director coordinates delegated work: it does not implement a child's delegated feature itself/);
  assert.match(director, /integrate accepted child changes in its assigned tree/);
  const custom = workerContract({ id: 'id-custom', name: 'auditor', archetype: 'auditor', repoRoot: '/repo', worktree: WT });
  assert.match(custom, /Custom archetypes follow their declared role and the caller's task/);
  assert.match(custom, /For implementation or integration/);
  assert.match(custom, /For a report-only task \(such as review, exploration, or judging\)/);
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

test('the host vocabulary carries the archetype list, the spawn rules, the close obligation, and the nag — and NOT routing', () => {
  const unclosed = correlate([opened('a', { name: 'fix-login' })]);
  const text = hostVocabulary({
    archetypes: [
      { name: 'worker', description: 'Implements.', model: 'luna', effort: 'xhigh', source: 'repo' },
      { name: 'reviewer', description: 'Reviews.', model: 'host', effort: null, source: 'base' },
    ],
    unclosed,
    now: new Date('2026-09-07T10:30:00Z'),
  });
  assert.match(text, /- \*\*worker\*\* — Implements\.$/m);
  assert.match(text, /- \*\*reviewer\*\* — Reviews\.$/m);
  // This text is injected once and outlives every dial change after it. A
  // routing list here was read as current three dials later — see the comment
  // on hostVocabulary. It says where routing IS answered instead.
  // The models the CALLER passed must not appear anywhere: that is the
  // snapshot. (`opus@xhigh` does appear — it is the escalation example, a
  // fixed illustration rather than a reading of the dials.)
  assert.doesNotMatch(text, /routes to|luna/);
  assert.match(text, /Routing is resolved at the spawn and reported by the hook that opens the dispatch/);
  assert.match(text, /Run `fadeno dial` for the current table/);
  assert.match(text, /`fadeno:worker` on Claude Code/);
  assert.match(text, /fadeno dispatch --archetype <name> --prompt-file <file>/, 'a director with no hook still knows the command lane');
  assert.match(text, /Two agents must never share one tree/);
  assert.match(text, /That recommendation is a claim, not a finding/);
  assert.match(text, /fadeno dispatch-close <name\|id> --merged\|--kept\|--discarded\|--failed\|--reviewed/);
  assert.match(text, /Never close the dispatch you are currently running in/);
  assert.match(text, /Only close dispatches you opened/);
  assert.match(text, /If it is still `open`, or if it is `awaiting close` with worktree inspection pending/);
  assert.match(text, /save the already-received final response to a file and replay the idempotent stop with `fadeno dispatch-stop <name\|id> --message-file <path>`/);
  assert.match(text, /Fadeno performs no merge; you do/);
  assert.match(text, /never refuses a spawn because work is unclosed/);
  assert.match(text, /Report it with the dispatch id and the error text, and do not substitute/);
  assert.match(text, /## Unclosed dispatches \(1; 0 stopped and waiting on you\)/);
  assert.match(text, /- `fix-login` a — worker on `fadeno\/worker-a`, open, 30m old/);
});

test('the nag names every unclosed dispatch and says which are stopped and awaiting a decision', () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const rows = [
    opened('1', { name: 'one', at: '2026-09-08T11:50:00Z' }),
    opened('2', { name: 'two', at: '2026-09-08T09:00:00Z', parent: '11111111-aaaa', workspace: null, archetype: 'scout' }),
    { row: 'stopped' as const, id: '2', at: '2026-09-08T10:00:00Z', final_message: 'done', dirty: { paths: [], truncated: false } },
  ];
  const unclosed = correlate(rows);
  const text = nagText(unclosed, now);
  assert.match(text, /## Unclosed dispatches \(2; 1 stopped and waiting on you\)/);
  assert.match(text, /- `one` 1 — worker on `fadeno\/worker-1`, open, 10m old/);
  assert.match(text, /- `two` 2 — scout, stopped, awaiting your decision, 3h old \(spawned by 11111111\)/);
  assert.doesNotMatch(text, /At the limit/);
  assert.equal(nagText([], now), 'No unclosed dispatches in this repository.');
});

test('the host-turn reminder is compact, ledger-derived, and never a spawn refusal', () => {
  const running = correlate(['1', '2', '3', '4', '5', '6'].map((id) => opened(id, { name: `job-${id}` })));
  assert.match(hostTurnReminder(running), /6 dispatches still running; none is waiting for a decision/);

  const stopped = correlate(['1', '2', '3', '4', '5', '6'].flatMap((id) => [
    opened(id, { name: `job-${id}` }),
    { row: 'stopped' as const, id, at: '2026-09-08T10:00:00Z', final_message: 'done', dirty: { paths: [], truncated: false } },
  ]));
  const reminder = hostTurnReminder(stopped);
  assert.match(reminder, /6 stopped dispatches waiting for your decision/);
  assert.match(reminder, /`job-1`, `job-2`, `job-3`, `job-4`, `job-5`, `job-6`/);
  assert.match(reminder, /--reviewed/);

  assert.equal(awaitingDecision(stopped).length, 6);
  assert.equal(awaitingDecision(running).length, 0);
});

test('formatAge reads like a clock at every magnitude', () => {
  assert.equal(formatAge(null), '?');
  assert.equal(formatAge(5), '5m');
  assert.equal(formatAge(125), '2h');
  assert.equal(formatAge(60 * 50), '2d');
});

test('the spawn instruction differs by harness, because what a hook can do to a spawn differs', () => {
  const archetypes = [{ name: 'worker', description: 'd', model: 'sol', effort: 'high', source: 'base' }];
  const base = { archetypes, unclosed: [] };

  // Claude's wrapper rewrites the spawn, so naming the archetype is enough.
  const claude = hostVocabulary({ ...base, host: 'claude' });
  assert.match(claude, /`fadeno:worker` on Claude Code/);
  assert.doesNotMatch(claude, /reasoning_effort/);
  assert.match(claude, /reachable isolated branch/);
  assert.match(claude, /`--shared` and `--from` are incompatible/);

  // Codex's can only refuse one, so the spawn has to carry the dialed model.
  // A host that learned this from a refusal paid a round trip for every first
  // spawn — which is exactly what happened the first time this ran live.
  const codex = hostVocabulary({ ...base, host: 'codex' });
  assert.match(codex, /agent_type: "fadeno-<archetype>"/);
  assert.match(codex, /`model` and `reasoning_effort`/);
  assert.match(codex, /fadeno dial <archetype> --json/);
  assert.match(codex, /is REFUSED/);
  // Still no routing VALUES: the stale-snapshot rule holds on both harnesses.
  assert.doesNotMatch(codex, /sol@high/);
  assert.doesNotMatch(codex, /gpt-/);
});
