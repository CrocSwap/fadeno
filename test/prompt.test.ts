import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runInit } from '../src/commands/init.ts';
import { PromptError, runPrompt } from '../src/commands/prompt.ts';
import { runValidate } from '../src/commands/validate.ts';
import { canonicalJson } from '../src/lib/prompt.ts';
import { expandOutputPath } from '../src/lib/prompt-resolve.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { tempRepo } from './helpers.ts';

const DOGFOOD = join(import.meta.dirname, '..', 'docs', 'experimental', 'dual-architect-review.yaml');
const RUN_ID = '2026-07-12-1718-design-and-build-fadeno-prompt';
const TASK = 'Design and build fadeno prompt: deterministic step-prompt assembly';
const FABLE = '# Fable approach\n\nUse a trie for prefix matching.\n';
const SOL = '# Sol approach\n\nUse a hashmap keyed by id.\n';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const EVENTS_AT_CROSS_REVIEW = [
  '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}',
  '{"type":"step_started","step":"frame","timestamp":"2026-07-12T21:20:11.527Z"}',
  '{"type":"artifact_written","step":"frame","artifact":"artifacts/brief.md","timestamp":"2026-07-12T21:21:10.365Z"}',
  '{"type":"step_started","step":"draft_approaches","timestamp":"2026-07-12T21:21:10.416Z"}',
  '{"type":"artifact_written","step":"draft_approaches","artifact":"artifacts/approach-sol.md","timestamp":"2026-07-12T21:28:35.231Z"}',
  '{"type":"artifact_written","step":"draft_approaches","artifact":"artifacts/approach-fable.md","timestamp":"2026-07-12T21:31:15.350Z"}',
  '{"type":"step_started","step":"cross_review","timestamp":"2026-07-12T21:31:15.407Z"}',
  '',
].join('\n');

interface SeedOpts {
  runId?: string;
  status?: string;
  currentStep?: string;
  events?: string;
  artifacts?: Record<string, string>;
  playbook?: string;
  playbookName?: string;
}

function seed(root: string, opts: SeedOpts = {}): string {
  runInit({ target: 'codex', repoRoot: root });
  const name = opts.playbookName ?? 'dual-architect-review';
  const source = opts.playbook ?? readFileSync(DOGFOOD, 'utf8');
  writeFileSync(join(root, '.fadeno', 'playbooks', `${name}.yaml`), source);

  const runId = opts.runId ?? RUN_ID;
  const dir = join(root, '.fadeno', 'runs', runId);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(
    join(dir, 'run.yaml'),
    [
      `run_id: ${runId}`,
      `playbook: ${name}`,
      `status: ${opts.status ?? 'running'}`,
      `task: "${TASK}"`,
      'started_at: 2026-07-12T21:18:58.647Z',
      'host: cli',
      'artifacts_dir: artifacts',
      `current_step: ${opts.currentStep ?? 'cross_review'}`,
      '',
    ].join('\n'),
  );

  const artifacts = opts.artifacts ?? { 'artifacts/approach-fable.md': FABLE, 'artifacts/approach-sol.md': SOL };
  for (const [rel, body] of Object.entries(artifacts)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  writeFileSync(join(dir, 'events.jsonl'), opts.events ?? EVENTS_AT_CROSS_REVIEW);
  return dir;
}

// --- 1. Golden bytes ---

test('golden: cross_review --actor architect_fable renders byte-exact', (t) => {
  const root = tempRepo(t);
  seed(root);
  const result = runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', record: false });

  const schemaText = canonicalJson(JSON.parse(read(root, join('.fadeno', 'schemas', 'review-report.schema.json'))));
  const expected = `# Fadeno step assignment

## Task

${TASK}

## Assignment

- run: ${RUN_ID}
- playbook: dual-architect-review (schema_version 0.1)
- step: cross_review (map)
- actor: architect_fable
- map member: architect_fable (other members: architect_sol)
- invocation: 1

> Draft an independent architecture; cross-review the other architect's draft. (Fable, Claude Code)

## Inputs

1. ApproachDraft[] — produced by step \`draft_approaches\` (invocation 1)
   - \`artifacts/approach-fable.md\` — ${Buffer.byteLength(FABLE)} bytes, sha256 ${sha256(FABLE)} — produced by you
   - \`artifacts/approach-sol.md\` — ${Buffer.byteLength(SOL)} bytes, sha256 ${sha256(SOL)} — produced by \`architect_sol\`

## Execution constraints

- Map step: perform only the \`architect_fable\` member. The other members (\`architect_sol\`) are handled separately — do not coordinate with them or produce their outputs.
- Policies (advisory unless enforced by hooks/CI): max_revision_loops = 2; max_subagents = 6; require_user_approval_for = [destructive_commands, dependency_addition, deploy, external_send].
- You may read the repository, but must not modify \`run.yaml\`, \`events.jsonl\`, prompt snapshots under \`artifacts/prompts/\`, or any artifact other than your declared output below.

## Output contract

- Collective output: ReviewReport[]. Your output: ReviewReport.
- Write exactly one artifact to \`artifacts/cross-review.architect_fable.json\`.
- Media type: application/json.
- Emit JSON only — no prose, no code fences around it — conforming to this schema:

\`\`\`json
${schemaText}
\`\`\`

- Self-check before finishing: \`fadeno validate artifacts/cross-review.architect_fable.json --schema review-report\`.
- Downstream: gate \`convergence_gate\` computes \`no_blocking_issues\` from ReviewReport[]. A \`blocking\`-severity issue fails it. The coordinator first assembles all map members into one array.

## Completion protocol

- Produce exactly the one declared artifact above; write nothing else.
- Do not modify the run ledger (\`run.yaml\`, \`events.jsonl\`) or any prompt snapshot.
- Keep all commentary inside the artifact; emit no other prose.
- If your harness cannot write files, return only the artifact body for the coordinator to save.
`;
  assert.equal(result.prompt, expected);
});

test('golden: single actor_call with an untyped output', (t) => {
  const root = tempRepo(t);
  seed(root, { playbook: MINI, playbookName: 'mini', currentStep: 'draft', events: MINI_EVENTS_DRAFT, artifacts: {} });
  const result = runPrompt({ repoRoot: root, run: RUN_ID, step: 'draft', record: false });
  assert.equal(result.plan.output.path, 'artifacts/note.md');
  assert.match(result.prompt, /- Output: Note\./);
  assert.match(result.prompt, /- Produce one self-contained markdown document\./);
  assert.match(result.prompt, /- actor: writer/);
});

test('loop-body output is generation-scoped .v<G> with G = N + 1', (t) => {
  const root = tempRepo(t);
  seed(root, { events: RECONCILE_EVENTS, artifacts: RECONCILE_ARTIFACTS });
  const result = runPrompt({ repoRoot: root, run: RUN_ID, step: 'revise_approaches', actor: 'architect_fable', record: false });
  assert.equal(result.plan.iteration, 1);
  assert.equal(result.plan.output.path, 'artifacts/approach-fable.v2.md');
  assert.match(result.prompt, /- iteration: 1 of 2/);
  // expandOutputPath applies G = N + 1 directly.
  assert.equal(expandOutputPath('artifacts/x.v{iteration}.md', 'a', 1), 'artifacts/x.v2.md');
  assert.equal(expandOutputPath({ a: 'artifacts/{actor}.v{iteration}.md' }, 'a', 2), 'artifacts/a.v3.md');
});

// --- 2. Ledger-grounded resolution ---

test('a disk artifact with no event is invisible; an event after the cutoff is excluded', (t) => {
  const root = tempRepo(t);
  // Decoy revision on disk, plus a revise event AFTER the cross_review cutoff.
  const events = [
    '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}',
    '{"type":"step_started","step":"draft_approaches","timestamp":"2026-07-12T21:21:10.416Z"}',
    '{"type":"artifact_written","step":"draft_approaches","artifact":"artifacts/approach-sol.md","timestamp":"2026-07-12T21:28:35.231Z"}',
    '{"type":"artifact_written","step":"draft_approaches","artifact":"artifacts/approach-fable.md","timestamp":"2026-07-12T21:31:15.350Z"}',
    '{"type":"step_started","step":"cross_review","timestamp":"2026-07-12T21:31:15.407Z"}',
    '{"type":"artifact_written","step":"revise_approaches","artifact":"artifacts/approach-fable.v2.md","timestamp":"2026-07-12T21:40:00.000Z"}',
    '',
  ].join('\n');
  seed(root, {
    events,
    artifacts: {
      'artifacts/approach-fable.md': FABLE,
      'artifacts/approach-sol.md': SOL,
      'artifacts/approach-fable.v2.md': '# stale revision on disk\n', // decoy, no event <= cutoff
    },
  });
  const result = runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', record: false });
  const paths = result.plan.inputs.flatMap((i) => i.files.map((f) => f.path));
  assert.deepEqual(paths, ['artifacts/approach-fable.md', 'artifacts/approach-sol.md']);
  assert.doesNotMatch(result.prompt, /v2/);
});

// --- 3. Ordinals ---

test('iteration is counted from loop_iteration_started when events carry no iteration field', (t) => {
  const root = tempRepo(t);
  seed(root, { events: RECONCILE_EVENTS, artifacts: RECONCILE_ARTIFACTS });
  const result = runPrompt({ repoRoot: root, run: RUN_ID, step: 'revise_approaches', actor: 'architect_fable', record: false });
  assert.equal(result.plan.iteration, 1);
  assert.equal(result.plan.maxIterations, 2);
});

test('a loop-body step whose loop never started is an error', (t) => {
  const root = tempRepo(t);
  seed(root); // events stop at cross_review; reconcile never started
  assert.throws(
    () => runPrompt({ repoRoot: root, run: RUN_ID, step: 'revise_approaches', actor: 'architect_fable', record: false }),
    (err: unknown) => err instanceof PromptError && /no recorded loop_iteration_started/.test((err as Error).message),
  );
});

test('a step with no step_started yet is preview-only (ahead of dispatch)', (t) => {
  const root = tempRepo(t);
  // draft_approaches has started (so its inputs exist) but cross_review has not.
  const events = [
    '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}',
    '{"type":"step_started","step":"draft_approaches","timestamp":"2026-07-12T21:21:10.416Z"}',
    '{"type":"artifact_written","step":"draft_approaches","artifact":"artifacts/approach-sol.md","timestamp":"2026-07-12T21:28:35.231Z"}',
    '{"type":"artifact_written","step":"draft_approaches","artifact":"artifacts/approach-fable.md","timestamp":"2026-07-12T21:31:15.350Z"}',
    '',
  ].join('\n');
  seed(root, { events });
  const result = runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable' });
  assert.equal(result.recorded, 'preview');
  assert.equal(result.promptPath, null);
  assert.equal(result.plan.cutoffLine, null);
});

// --- 4. Attribution ---

test('an event `member` field drives attribution; otherwise it is neutral', (t) => {
  const root = tempRepo(t);
  const events = [
    '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}',
    '{"type":"step_started","step":"draft","timestamp":"2026-07-12T21:20:00.000Z"}',
    '{"type":"artifact_written","step":"draft","artifact":"artifacts/note.md","member":"writer","timestamp":"2026-07-12T21:21:00.000Z"}',
    '{"type":"step_started","step":"review","timestamp":"2026-07-12T21:22:00.000Z"}',
    '',
  ].join('\n');
  seed(root, { playbook: MINI, playbookName: 'mini', currentStep: 'review', events, artifacts: { 'artifacts/note.md': '# note\n' } });
  const withMember = runPrompt({ repoRoot: root, run: RUN_ID, step: 'review', record: false });
  assert.match(withMember.prompt, /- `artifacts\/note\.md` — \d+ bytes, sha256 [0-9a-f]{64} — produced by `writer`/);

  // Same fixture without the member field: no attribution suffix (neutral).
  const neutralEvents = events.replace(',"member":"writer"', '');
  writeFileSync(join(root, '.fadeno', 'runs', RUN_ID, 'events.jsonl'), neutralEvents);
  const neutral = runPrompt({ repoRoot: root, run: RUN_ID, step: 'review', record: false });
  assert.match(neutral.prompt, /- `artifacts\/note\.md` — \d+ bytes, sha256 [0-9a-f]{64}\n/);
  assert.doesNotMatch(neutral.prompt, /note\.md.*produced by/);
});

// --- 5. Output paths + validator cases ---

test('a map over roles with no output_path uses a typed part-path default', (t) => {
  const root = tempRepo(t);
  // Strip cross_review's output_path so the default applies.
  const playbook = readFileSync(DOGFOOD, 'utf8').replace(
    /    output_path:\n      architect_fable: artifacts\/cross-review\.architect_fable\.json\n      architect_sol: artifacts\/cross-review\.architect_sol\.json\n/,
    '',
  );
  seed(root, { playbook });
  const result = runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', record: false });
  assert.equal(result.plan.output.path, 'artifacts/parts/cross_review/architect_fable.json');
});

test('a map over roles with an untyped output and no output_path is an error', (t) => {
  const root = tempRepo(t);
  const events = [
    '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}',
    '{"type":"step_started","step":"fan","timestamp":"2026-07-12T21:20:00.000Z"}',
    '',
  ].join('\n');
  seed(root, { playbook: UNTYPED_MAP, playbookName: 'untyped-map', currentStep: 'fan', events, artifacts: {} });
  assert.throws(
    () => runPrompt({ repoRoot: root, run: RUN_ID, step: 'fan', actor: 'a', record: false }),
    (err: unknown) => err instanceof PromptError && /maps an untyped output.*no output_path/.test((err as Error).message),
  );
});

test('validator: a loop-body output_path template must contain {iteration}', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const bad = readFileSync(DOGFOOD, 'utf8').replace('artifacts/approach-fable.v{iteration}.md', 'artifacts/approach-fable.md');
  const file = join(root, '.fadeno', 'playbooks', 'bad.yaml');
  writeFileSync(file, bad);
  const outcome = runValidate({ repoRoot: root, path: file });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.results[0]!.issues.some((i) => /must contain \{iteration\}/.test(i.message)));
});

test('validator: output_path collisions, "..", and absolute paths are rejected', (t) => {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });

  const collide = writePlaybook(root, 'collide', `  - id: m
    kind: map
    over: [a, b]
    output: R
    output_path:
      a: artifacts/same.json
      b: artifacts/same.json
    terminal_status: completed
`, ['a', 'b']);
  assert.ok(runValidate({ repoRoot: root, path: collide }).results[0]!.issues.some((i) => /collides/.test(i.message)));

  const traversal = writePlaybook(root, 'traversal', `  - id: m
    kind: actor_call
    actor: a
    output: R
    output_path: ../escape.json
    terminal_status: completed
`, ['a']);
  assert.ok(runValidate({ repoRoot: root, path: traversal }).results[0]!.issues.some((i) => /".."/.test(i.message)));

  const absolute = writePlaybook(root, 'absolute', `  - id: m
    kind: actor_call
    actor: a
    output: R
    output_path: /etc/escape.json
    terminal_status: completed
`, ['a']);
  assert.ok(runValidate({ repoRoot: root, path: absolute }).results[0]!.issues.some((i) => /absolute path/.test(i.message)));
});

// --- 6. Determinism ---

test('assembly is byte-identical across calls, cwds, and temp roots', (t) => {
  const rootA = tempRepo(t);
  const rootB = tempRepo(t);
  seed(rootA);
  seed(rootB);
  const a1 = runPrompt({ repoRoot: rootA, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', record: false });
  const a2 = runPrompt({ cwd: rootA, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', record: false });
  const b1 = runPrompt({ repoRoot: rootB, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', record: false });
  assert.equal(a1.prompt, a2.prompt);
  assert.equal(a1.prompt, b1.prompt);
  assert.equal(a1.sha256, b1.sha256);
});

test('canonicalJson is stable under key reordering (schema reformatting)', () => {
  const a = { b: 1, a: { d: 2, c: [3, 1] } };
  const b = { a: { c: [3, 1], d: 2 }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{\n  "a": {\n    "c": [\n      3,\n      1\n    ],\n    "d": 2\n  },\n  "b": 1\n}');
});

// --- 7. Recording ---

test('recording writes one snapshot + one prompt_assembled event; re-run reuses', (t) => {
  const root = tempRepo(t);
  const dir = seed(root);
  const now = new Date('2026-07-12T22:00:00.000Z');
  const first = runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', now });
  assert.equal(first.recorded, 'created');
  assert.equal(first.promptPath, 'artifacts/prompts/cross_review--architect_fable--n1.md');
  assert.equal(read(dir, join('artifacts', 'prompts', 'cross_review--architect_fable--n1.md')), first.prompt);

  const assembled = () => readEvents(dir).events.filter((e) => e.type === 'prompt_assembled');
  assert.equal(assembled().length, 1);
  const manifest = assembled()[0]!;
  assert.equal(manifest.timestamp, '2026-07-12T22:00:00.000Z');
  assert.equal(manifest.extra.prompt_sha256, first.sha256);
  assert.equal(manifest.extra.prompt_path, first.promptPath);
  assert.ok(typeof manifest.extra.playbook_sha256 === 'string');
  assert.ok(Array.isArray(manifest.extra.inputs) && (manifest.extra.inputs as unknown[]).length === 2);

  const second = runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', now });
  assert.equal(second.recorded, 'reused');
  assert.equal(assembled().length, 1); // no duplicate event
});

test('a mutated input triggers a record conflict without clobbering the snapshot', (t) => {
  const root = tempRepo(t);
  const dir = seed(root);
  const first = runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable' });
  writeFileSync(join(dir, 'artifacts', 'approach-fable.md'), `${FABLE}mutated\n`);
  assert.throws(
    () => runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable' }),
    (err: unknown) => err instanceof PromptError && /refusing to overwrite/.test((err as Error).message),
  );
  assert.equal(read(dir, join('artifacts', 'prompts', 'cross_review--architect_fable--n1.md')), first.prompt);
});

test('--no-record writes nothing; a terminal run is preview-only', (t) => {
  const root = tempRepo(t);
  const dir = seed(root);
  const before = read(dir, 'events.jsonl');
  const preview = runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', record: false });
  assert.equal(preview.recorded, 'preview');
  assert.equal(read(dir, 'events.jsonl'), before);

  const termRoot = tempRepo(t);
  seed(termRoot, { status: 'completed' });
  const terminal = runPrompt({ repoRoot: termRoot, run: RUN_ID, step: 'cross_review', actor: 'architect_fable' });
  assert.equal(terminal.recorded, 'preview');
});

// --- 8. Strictness ---

test('a malformed events line fails before resolution', (t) => {
  const root = tempRepo(t);
  seed(root, { events: `${EVENTS_AT_CROSS_REVIEW}not-json\n` });
  assert.throws(
    () => runPrompt({ repoRoot: root, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', record: false }),
    (err: unknown) => err instanceof PromptError && /events\.jsonl has malformed lines/.test((err as Error).message),
  );
});

// --- 9. Error matrix ---

test('error matrix: every unpromptable selection produces its message', (t) => {
  const root = tempRepo(t);
  const dir = seed(root);
  const expectError = (opts: Parameters<typeof runPrompt>[0], re: RegExp): void => {
    assert.throws(
      () => runPrompt(opts),
      (err: unknown) => err instanceof PromptError && re.test((err as Error).message),
      re.source,
    );
  };
  const base = { repoRoot: root, run: RUN_ID, record: false };
  expectError({ ...base, step: 'nope' }, /not found\. Steps: /);
  expectError({ ...base, step: 'convergence_gate' }, /fadeno gate <run> <condition> --artifact <path>/);
  expectError({ ...base, step: 'arbitrate' }, /human_gate; ask the user directly: /);
  expectError({ ...base, step: 'reconcile' }, /is a loop; prompt one of its body steps: /);
  expectError({ ...base, step: 'cross_review' }, /maps over roles; pass --actor architect_fable\|architect_sol/);
  expectError({ ...base, step: 'cross_review', actor: 'nobody' }, /valid members: architect_fable, architect_sol/);
  expectError({ ...base, step: 'cross_review', actor: 'architect_fable', iteration: 1 }, /only valid on loop-body steps/);
  expectError({ ...base, step: 'build', actor: 'builder' }, /not promptable in v1/);

  // Missing input file on disk.
  writeFileSync(join(dir, 'events.jsonl'), EVENTS_AT_CROSS_REVIEW);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  writeFileSync(join(dir, 'artifacts', 'approach-fable.md'), FABLE);
  // remove approach-sol.md by overwriting the run with only one draft on disk
  const noSol = tempRepo(t);
  seed(noSol, { artifacts: { 'artifacts/approach-fable.md': FABLE } });
  expectError({ repoRoot: noSol, run: RUN_ID, step: 'cross_review', actor: 'architect_fable', record: false }, /is missing on disk/);
});

// --- shared fixtures ---

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function writePlaybook(root: string, name: string, flow: string, roles: string[]): string {
  const roleLines = roles.map((r) => `  ${r}: {purpose: work}`).join('\n');
  const doc = `kind: AgentPlaybook
schema_version: "0.1"
name: ${name}
description: ${name}
roles:
${roleLines}
flow:
${flow}`;
  const file = join(root, '.fadeno', 'playbooks', `${name}.yaml`);
  writeFileSync(file, doc);
  return file;
}

const MINI = `kind: AgentPlaybook
schema_version: "0.1"
name: mini
description: mini
roles:
  writer:
    purpose: Write the note.
  reviewer:
    purpose: Review the note.
flow:
  - id: draft
    kind: actor_call
    actor: writer
    output: Note
  - id: review
    kind: actor_call
    actor: reviewer
    input:
      - Note
    output: Summary
    terminal_status: completed
`;

const MINI_EVENTS_DRAFT = [
  '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}',
  '{"type":"step_started","step":"draft","timestamp":"2026-07-12T21:20:00.000Z"}',
  '',
].join('\n');

const UNTYPED_MAP = `kind: AgentPlaybook
schema_version: "0.1"
name: untyped-map
description: untyped map
roles:
  a:
    purpose: work
  b:
    purpose: work
flow:
  - id: fan
    kind: map
    over:
      - a
      - b
    output: Note[]
    terminal_status: completed
`;

const RECONCILE_EVENTS = [
  '{"type":"run_started","step":null,"timestamp":"2026-07-12T21:18:58.647Z"}',
  '{"type":"step_started","step":"draft_approaches","timestamp":"2026-07-12T21:21:10.416Z"}',
  '{"type":"artifact_written","step":"draft_approaches","artifact":"artifacts/approach-sol.md","timestamp":"2026-07-12T21:28:35.231Z"}',
  '{"type":"artifact_written","step":"draft_approaches","artifact":"artifacts/approach-fable.md","timestamp":"2026-07-12T21:31:15.350Z"}',
  '{"type":"step_started","step":"cross_review","timestamp":"2026-07-12T21:31:15.407Z"}',
  '{"type":"artifact_written","step":"cross_review","artifact":"artifacts/cross-review.architect_sol.json","timestamp":"2026-07-12T21:34:39.341Z"}',
  '{"type":"artifact_written","step":"cross_review","artifact":"artifacts/cross-review.architect_fable.json","timestamp":"2026-07-12T21:39:45.934Z"}',
  '{"type":"artifact_written","step":"cross_review","artifact":"artifacts/cross-review.json","timestamp":"2026-07-12T21:39:45.997Z"}',
  '{"type":"step_started","step":"convergence_gate","timestamp":"2026-07-12T21:39:46.053Z"}',
  '{"type":"gate_evaluated","step":"convergence_gate","condition":"no_blocking_issues","artifact":"artifacts/cross-review.json","result":"fail","timestamp":"2026-07-12T21:39:46.132Z"}',
  '{"type":"step_started","step":"reconcile","timestamp":"2026-07-12T21:40:11.637Z"}',
  '{"type":"loop_iteration_started","step":"reconcile","timestamp":"2026-07-12T21:40:11.689Z"}',
  '{"type":"step_started","step":"revise_approaches","timestamp":"2026-07-12T21:40:11.743Z"}',
  '',
].join('\n');

const RECONCILE_ARTIFACTS: Record<string, string> = {
  'artifacts/approach-fable.md': FABLE,
  'artifacts/approach-sol.md': SOL,
  'artifacts/cross-review.architect_fable.json': '{"reviewer":"architect_fable","summary":"s","issues":[],"verdict":"comment"}\n',
  'artifacts/cross-review.architect_sol.json': '{"reviewer":"architect_sol","summary":"s","issues":[],"verdict":"comment"}\n',
  'artifacts/cross-review.json': '[]\n',
};
