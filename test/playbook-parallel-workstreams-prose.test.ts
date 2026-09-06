import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

/**
 * The coordinator's purpose was reframed on 2026-09-05: it used to prescribe
 * the contract's FORM ("freeze the shared contract — names, schemas, interface
 * tokens") and say nothing about why the contract exists, and a director read
 * that as a mandate — 29 KB of design for three workers on an already-designed
 * feature. The purpose is collision avoidance; the weight is judgement.
 *
 * That is a prose change to a file every run reads, which makes it exactly the
 * kind of edit that quietly takes an id with it. The structural half of this
 * test is the tripwire: every step id, gate branch, artifact name, role name
 * and `when_to_use` line is pinned byte-for-byte, so a later rewording that
 * renames something fails here instead of in someone's run.
 */

const PLAYBOOK = join(
  import.meta.dirname,
  '..',
  'templates',
  'common',
  'fadeno',
  'playbooks',
  'parallel-workstreams.yaml',
);

interface Playbook {
  name: string;
  when_to_use: string[];
  roles: Record<string, { purpose: string; archetype?: string }>;
  flow: Array<Record<string, unknown>>;
  artifact_contracts: Record<string, unknown>;
}

function playbook(): Playbook {
  return parse(readFileSync(PLAYBOOK, 'utf8')) as Playbook;
}

test('the reframed prose changed nothing an engine or a run reads by name', () => {
  const doc = playbook();

  assert.equal(doc.name, 'parallel-workstreams');
  assert.deepEqual(doc.when_to_use, [
    'one task splits cleanly into several file-disjoint workstreams',
    'the workstreams share names, schemas, or interface tokens that must not drift',
    'workers finish at different times and must not reconcile against each other',
    'a single integrator should own cross-cutting files and the full suite',
  ]);
  assert.deepEqual(Object.keys(doc.roles), [
    'coordinator',
    'workstream_1',
    'workstream_2',
    'workstream_3',
    'integrator',
    'integration_reviewer',
  ]);
  assert.deepEqual(doc.flow.map((step) => step.id), [
    'fix_contract',
    'accept_contract',
    'revise_contract',
    'reaccept_contract',
    'run_workstreams',
    'integrate',
    'full_suite',
    'suite_gate',
    'review_integration',
    'review_gate',
    'rework',
    'rework_integration',
    'rereview_integration',
    'done',
    'suite_failed',
    'unresolved_review',
    'contract_rejected',
  ]);
  assert.deepEqual(Object.keys(doc.artifact_contracts), [
    'Contract',
    'WorkstreamReport',
    'IntegrationResult',
  ]);

  const byId = new Map(doc.flow.map((step) => [step.id as string, step]));
  const accept = byId.get('accept_contract')!;
  assert.equal(accept.kind, 'human_gate');
  assert.equal(accept.on_approve, 'run_workstreams');
  assert.equal(accept.on_reject, 'revise_contract');
  assert.equal(byId.get('reaccept_contract')!.on_approve, 'run_workstreams');
  assert.equal(byId.get('suite_gate')!.condition, 'tests_pass');
  assert.equal(byId.get('review_gate')!.condition, 'all_reviews_approved');
  assert.equal(byId.get('revise_contract')!.output_path, 'artifacts/contract.v2.md');
  assert.equal(byId.get('run_workstreams')!.output_path, 'artifacts/workstreams/{actor}.md');
});

test('the coordinator purpose leads with collision avoidance and keeps the manifest invariant', () => {
  const purpose = playbook().roles.coordinator!.purpose;

  assert.match(
    purpose.slice(0, 80),
    /colliding/,
    'the purpose must state why the contract exists before it says what to write',
  );
  assert.match(purpose, /file-disjoint\s+ownership manifest/);
  assert.match(purpose, /one invariant/, 'the manifest shape is the part the engine and integrator depend on');
  assert.match(purpose, /as short as the collision risk allows/, 'weight is judgement, proportional to the risk');
});

/**
 * The rejection sentence used to forbid the correction it should have asked
 * for. A regeneration still produces one complete document — that part stands —
 * but "never a diff or patch" made the coordinator rewrite passages the
 * feedback never mentioned.
 */
test('a rejection asks for a targeted correction, not a rewrite from scratch', () => {
  const purpose = playbook().roles.coordinator!.purpose;

  assert.doesNotMatch(purpose, /never a diff or patch/);
  assert.match(purpose, /correct what the recorded feedback names and keep everything it\s+did not touch/);
  assert.match(purpose, /still one complete contract/);
  assert.match(purpose, /highest\s+generation is authoritative/, 'generation precedence is unchanged');
});

/**
 * `artifact_contracts.Contract.instructions` is the OPERATIVE instruction: it
 * is the text the coordinator reads when it produces a Contract, so while it
 * prescribed the form — "State the shared contract first — exact names,
 * schemas, and interface tokens every workstream must use verbatim" — the
 * reframing of the role purpose above was cosmetic and the next run still got
 * told to freeze everything. It survived the first pass because this test did
 * not cover the field. It does now.
 */
test('the Contract instructions ask for collision control, not a prescribed form', () => {
  const instructions = (playbook().artifact_contracts.Contract as { instructions: string }).instructions;

  assert.match(
    instructions.slice(0, 80),
    /collide/,
    'the instruction must state what the contract is for before it says what to write',
  );
  assert.match(instructions, /file-disjoint/);
  assert.match(instructions, /cross-cutting and generated files/, 'the manifest invariant is not negotiable');
  assert.match(instructions, /proportional to\s+the collision risk/, 'weight is judgement, proportional to the risk');
  assert.match(instructions, /only when the design itself is\s+unsettled/);
  assert.match(instructions, /highest generation is authoritative/, 'generation precedence is engine-relevant');
  assert.match(instructions, /reconciliation rules/);

  // The form it must no longer prescribe.
  assert.doesNotMatch(instructions, /State the shared contract first/);
  assert.doesNotMatch(instructions, /must use verbatim/);
});

test('the acceptance gate says what the approver is approving', () => {
  const accept = playbook().flow.find((step) => step.id === 'accept_contract')!;
  const prompt = accept.prompt as string;

  assert.match(prompt, /ownership manifests/);
  assert.match(prompt, /cannot collide/);
  assert.match(prompt, /not a\s+design review/);
});
