import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import { runInit } from '../src/commands/init.ts';
import { runNewRun } from '../src/commands/new-run.ts';
import { runDrive } from '../src/commands/drive.ts';
import { readEvents } from '../src/lib/run-ledger.ts';
import { runVerify } from '../src/commands/verify.ts';
import { completeHostDispatch, startHostDispatch } from '../src/lib/host-dispatch.ts';
import { LedgerWriter } from '../src/lib/run-ledger-write.ts';
import { tempRepo } from './helpers.ts';

const VALID_REVIEW = JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'approve' });
const VALID2 = JSON.stringify({ reviewer: 'r2', summary: 's2', issues: [], verdict: 'approve' });
const BAD_VERDICT = JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'bad' });

function seedHostEnvelopeRun(t: TestContext) {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const playbook = `kind: AgentPlaybook
schema_version: "0.1"
name: envelope-host-fixture
description: host envelope
roles:
  agent_1: { purpose: worker }
inputs:
  Agent1Spec: { media_type: text/markdown }
flow:
  - id: implement
    kind: actor_call
    actor: agent_1
    input: [Agent1Spec]
    output: ReviewReport
    terminal_status: completed
`;
  writeFileSync(join(root, '.fadeno', 'playbooks', 'envelope-host-fixture.yaml'), playbook);
  writeFileSync(join(root, 'agent-1.md'), 'spec');
  const execYaml = {
    schema_version: 3,
    models: { m: { provider: 'dummy', id: 'm', effort: 'high' } },
    routes: {
      standalone: { dummy: { host: true }, 'current-host': { host: true } },
      codex: { dummy: { host: true }, 'current-host': { host: true } },
      claude: { dummy: { host: true }, 'current-host': { host: true } },
      grok: { dummy: { host: true }, 'current-host': { host: true } },
    },
    archetypes: { worker: {} },
    bindings: { agent_1: 'm' },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(execYaml));
  const { runId } = runNewRun({ repoRoot: root, playbook: 'envelope-host-fixture', task: 't', inputs: ['Agent1Spec=agent-1.md'] });
  const driven = runDrive({ repoRoot: root, run: runId });
  assert.equal(driven.outcome, 'awaiting_host_dispatch');
  const dispatchId = driven.requests[0]!.dispatchId;
  startHostDispatch({ repoRoot: root, run: runId, dispatchId, agentId: 'agent-123' });
  return { root, runId, dispatchId };
}

function seedEngineEnvelopeRun(t: TestContext, command: string[]) {
  const root = tempRepo(t);
  runInit({ target: 'codex', repoRoot: root });
  const playbook = `kind: AgentPlaybook
schema_version: "0.1"
name: envelope-engine-fixture
description: engine envelope
roles:
  agent_1: { purpose: worker }
inputs:
  Agent1Spec: { media_type: text/markdown }
flow:
  - id: implement
    kind: actor_call
    actor: agent_1
    input: [Agent1Spec]
    output: ReviewReport
    terminal_status: completed
`;
  writeFileSync(join(root, '.fadeno', 'playbooks', 'envelope-engine-fixture.yaml'), playbook);
  writeFileSync(join(root, 'agent-1.md'), 'spec');
  const execYaml = {
    schema_version: 3,
    models: { m: { provider: 'dummy', id: 'm', effort: 'high' } },
    routes: {
      standalone: { dummy: { command, }, 'current-host': { host: true } },
      codex: { dummy: { command, }, 'current-host': { host: true } },
      claude: { dummy: { command, }, 'current-host': { host: true } },
      grok: { dummy: { command, }, 'current-host': { host: true } },
    },
    archetypes: { worker: {} },
    bindings: { agent_1: 'm' },
  };
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml(execYaml));
  const { runId } = runNewRun({ repoRoot: root, playbook: 'envelope-engine-fixture', task: 't', inputs: ['Agent1Spec=agent-1.md'] });
  return { root, runId };
}

test('host: fenced extraction parks raw and normalized, idempotent', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const fenced = `Here:\n\`\`\`json\n${VALID_REVIEW}\n\`\`\`\n`;
  const tmp = join(root, 'tmp-out.json');
  writeFileSync(tmp, fenced, 'utf8');
  const first = completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  assert.equal(first.state, 'completed');
  const runDir = join(root, '.fadeno', 'runs', runId);
  const events = readEvents(runDir).events as any[];
  const completed = events.find((e: any) => e.type === 'actor_completed' && e.extra.dispatch_id === dispatchId);
  assert.ok(completed, `actor_completed not found, events: ${JSON.stringify(events.map((e:any)=>e.type+':'+e.extra.dispatch_id))}`);
  assert.equal(completed.extra.output_extraction, 'fenced');
  assert.equal(completed.extra.output_valid, true);
  assert.equal(typeof completed.extra.raw_output_bytes, 'number');
  assert.ok(Number.isInteger(completed.extra.raw_output_bytes));
  assert.equal(completed.extra.raw_output_bytes, Buffer.byteLength(fenced, 'utf8'));
  assert.equal(typeof completed.extra.envelope_candidates, 'number');
  assert.equal(completed.extra.envelope_candidates, 1);
  const outPath = join(runDir, completed.extra.output);
  const rawPath = join(runDir, completed.extra.raw_output);
  assert.equal(readFileSync(outPath, 'utf8'), VALID_REVIEW);
  assert.equal(readFileSync(rawPath, 'utf8'), fenced);
  assert.ok(readFileSync(rawPath, 'utf8').includes(readFileSync(outPath, 'utf8')));
  assert.equal(readFileSync(rawPath).length, completed.extra.raw_output_bytes);
  const second = completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  assert.equal(second.idempotent, true);
  const verify = runVerify({ repoRoot: root, run: runId });
  const env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.ok(env);
  assert.equal(env.status, 'ok');
});

test('host: exact JSON stays on legacy path without extraction', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const tmp = join(root, 'tmp-exact.json');
  writeFileSync(tmp, VALID_REVIEW, 'utf8');
  const res = completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  assert.equal(res.state, 'completed');
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const completed = ev.find((e: any) => e.type === 'actor_completed' && e.extra.dispatch_id === dispatchId);
  assert.ok(completed);
  assert.equal(completed.extra.output_valid, true);
  assert.equal(completed.extra.output_extraction, undefined, 'exact JSON must not have extraction metadata');
  assert.equal(completed.extra.raw_output, undefined);
  // Output should be the normalized path, not raw
  const outPath = join(root, '.fadeno', 'runs', runId, completed.extra.output);
  assert.equal(readFileSync(outPath, 'utf8'), VALID_REVIEW);
});

test('host: ambiguous fenced retains repair behavior (no extraction, parked attempt)', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const ambiguous = `\`\`\`json\n${VALID_REVIEW}\n\`\`\`\n\`\`\`json\n${VALID2}\n\`\`\``;
  const tmp = join(root, 'tmp-amb.json');
  writeFileSync(tmp, ambiguous, 'utf8');
  const res = completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  // Host path parks invalid output but still marks completed with output_valid false
  // (no automatic retry for host; validation failure is recorded as attempt)
  assert.equal(res.state, 'completed');
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const completed = ev.find((e: any) => e.type === 'actor_completed' && e.extra.dispatch_id === dispatchId);
  assert.ok(completed);
  assert.equal(completed.extra.output_valid, false, 'ambiguous must not be valid');
  assert.equal(completed.extra.output_extraction, undefined, 'ambiguous must not extract');
  // Ensure did not write normalized output at planned path but at attempts path
  assert.match(completed.extra.output, /^artifacts\/attempts\//);
});

test('host: schema-invalid fenced retains repair behavior', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const badFenced = `\`\`\`json\n${BAD_VERDICT}\n\`\`\``;
  const tmp = join(root, 'tmp-bad.json');
  writeFileSync(tmp, badFenced, 'utf8');
  const res = completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  assert.equal(res.state, 'completed');
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const completed = ev.find((e: any) => e.type === 'actor_completed' && e.extra.dispatch_id === dispatchId);
  assert.ok(completed);
  assert.equal(completed.extra.output_valid, false);
  assert.equal(completed.extra.output_extraction, undefined);
  assert.ok(Array.isArray(completed.extra.validation_errors) && completed.extra.validation_errors.some((m: string) => m.includes('envelope candidate failed schema')));
});

test('host: mixed valid+invalid fenced must fail closed (no guessing)', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const mixed = `\`\`\`json\n${VALID_REVIEW}\n\`\`\`\n\`\`\`json\n${BAD_VERDICT}\n\`\`\``;
  const tmp = join(root, 'tmp-mixed.json');
  writeFileSync(tmp, mixed, 'utf8');
  completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const completed = ev.find((e: any) => e.type === 'actor_completed' && e.extra.dispatch_id === dispatchId);
  assert.ok(completed);
  assert.equal(completed.extra.output_valid, false, 'mixed tier must not extract valid payload');
  assert.equal(completed.extra.output_extraction, undefined);
});

test('engine: fenced valid is extracted with raw evidence and no schema_repair', (t: TestContext) => {
  const fencedCmd = ['node', '-e', `process.stdout.write(\`Here:\\n\\\`\\\`\\\`json\\n${VALID_REVIEW}\\n\\\`\\\`\\\`\\n\`)`];
  const { root, runId } = seedEngineEnvelopeRun(t, fencedCmd);
  const res = runDrive({ repoRoot: root, run: runId });
  assert.equal(res.outcome, 'terminal');
  assert.equal(res.status, 'completed');
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const dispatches = ev.filter((e: any) => e.type === 'actor_dispatched');
  assert.equal(dispatches.length, 1, 'fenced valid must not mint a schema_repair attempt');
  assert.equal(dispatches[0].extra.attempt_reason, 'initial');
  const completed = ev.find((e: any) => e.type === 'actor_completed');
  assert.ok(completed);
  assert.equal(completed.extra.output_valid, true);
  assert.equal(completed.extra.output_extraction, 'fenced');
  assert.equal(completed.extra.envelope_candidates, 1);
  assert.equal(typeof completed.extra.raw_output, 'string');
  assert.equal(typeof completed.extra.raw_output_sha256, 'string');
  assert.equal(typeof completed.extra.raw_output_bytes, 'number');
  assert.ok(Number.isInteger(completed.extra.raw_output_bytes) && completed.extra.raw_output_bytes > 0, 'raw_output_bytes must be positive integer');
  const runDir = join(root, '.fadeno', 'runs', runId);
  const rawText = readFileSync(join(runDir, completed.extra.raw_output), 'utf8');
  const rawBytes = readFileSync(join(runDir, completed.extra.raw_output)).length;
  assert.equal(completed.extra.raw_output_bytes, rawBytes, 'raw_output_bytes must match actual file length');
  assert.equal(typeof completed.extra.envelope_candidates, 'number');
  assert.ok(completed.extra.envelope_candidates >= 1);
  const outText = readFileSync(join(runDir, completed.extra.output), 'utf8');
  assert.equal(outText, VALID_REVIEW);
  assert.ok(rawText.includes(outText), 'payload must be contiguous substring of raw');
});

test('engine: exact JSON stays on legacy path without extraction', (t: TestContext) => {
  const exactCmd = ['node', '-e', `process.stdout.write('${VALID_REVIEW}')`];
  const { root, runId } = seedEngineEnvelopeRun(t, exactCmd);
  const res = runDrive({ repoRoot: root, run: runId });
  assert.equal(res.outcome, 'terminal');
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const completed = ev.find((e: any) => e.type === 'actor_completed');
  assert.ok(completed);
  assert.equal(completed.extra.output_valid, true);
  assert.equal(completed.extra.output_extraction, undefined, 'exact JSON must not have extraction');
  assert.equal(completed.extra.raw_output, undefined);
  const dispatches = ev.filter((e: any) => e.type === 'actor_dispatched');
  assert.equal(dispatches.length, 1);
});

test('engine: ambiguous fenced retains bounded repair behavior', (t: TestContext) => {
  const ambCmd = ['node', '-e', `process.stdout.write(\`\\\`\\\`\\\`json\\n${VALID_REVIEW}\\n\\\`\\\`\\\`\\n\\\`\\\`\\\`json\\n${VALID2}\\n\\\`\\\`\\\`\\n\`)`];
  const { root, runId } = seedEngineEnvelopeRun(t, ambCmd);
  const res = runDrive({ repoRoot: root, run: runId });
  // Drive attempts one repair then surfaces invalid_output (not terminal completed)
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const dispatches = ev.filter((e: any) => e.type === 'actor_dispatched');
  assert.ok(dispatches.length >= 2, `ambiguous must trigger at least one repair attempt, got ${dispatches.length}`);
  assert.equal(dispatches[1].extra.attempt_reason, 'schema_repair');
  const completed = ev.find((e: any) => e.type === 'actor_completed' && e.extra.output_valid === false);
  assert.ok(completed, 'ambiguous must result in output_valid false');
  assert.equal(completed.extra.output_extraction, undefined);
});

test('engine: schema-invalid fenced retains bounded repair behavior', (t: TestContext) => {
  const badCmd = ['node', '-e', `process.stdout.write(\`\\\`\\\`\\\`json\\n${BAD_VERDICT}\\n\\\`\\\`\\\`\\n\`)`];
  const { root, runId } = seedEngineEnvelopeRun(t, badCmd);
  runDrive({ repoRoot: root, run: runId });
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const dispatches = ev.filter((e: any) => e.type === 'actor_dispatched');
  assert.ok(dispatches.length >= 2, 'schema_invalid must trigger repair');
  assert.equal(dispatches[1].extra.attempt_reason, 'schema_repair');
  const failed = ev.find((e: any) => e.type === 'actor_completed' && e.extra.output_valid === false);
  assert.ok(failed);
  assert.ok(failed.extra.validation_errors.some((m: string) => m.includes('envelope candidate failed schema')));
  assert.equal(failed.extra.output_extraction, undefined);
});

test('engine: mixed valid+invalid fenced must fail closed into repair', (t: TestContext) => {
  const mixedCmd = ['node', '-e', `process.stdout.write(\`\\\`\\\`\\\`json\\n${VALID_REVIEW}\\n\\\`\\\`\\\`\\n\\\`\\\`\\\`json\\n${BAD_VERDICT}\\n\\\`\\\`\\\`\\n\`)`];
  const { root, runId } = seedEngineEnvelopeRun(t, mixedCmd);
  runDrive({ repoRoot: root, run: runId });
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const dispatches = ev.filter((e: any) => e.type === 'actor_dispatched');
  assert.ok(dispatches.length >= 2, 'mixed tier must not succeed, must go to repair');
  const failed = ev.find((e: any) => e.type === 'actor_completed' && e.extra.output_valid === false);
  assert.ok(failed);
  assert.equal(failed.extra.output_extraction, undefined);
});

test('engine: bare JSON that parses but fails schema stays semantic without envelope prefix', (t: TestContext) => {
  const bareBadCmd = ['node', '-e', `process.stdout.write('${BAD_VERDICT}')`];
  const { root, runId } = seedEngineEnvelopeRun(t, bareBadCmd);
  runDrive({ repoRoot: root, run: runId });
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const failed = ev.find((e: any) => e.type === 'actor_completed' && e.extra.output_valid === false);
  assert.ok(failed, 'bare schema-invalid JSON must produce invalid completion');
  assert.equal(failed.extra.output_extraction, undefined, 'bare invalid JSON must not have extraction');
  assert.equal(failed.extra.raw_output, undefined, 'bare invalid must not have raw_output');
  assert.ok(Array.isArray(failed.extra.validation_errors) && failed.extra.validation_errors.length > 0);
  assert.ok(!failed.extra.validation_errors.some((m: string) => m.includes('envelope candidate failed schema')), 'bare invalid must not have envelope prefix, got ' + JSON.stringify(failed.extra.validation_errors));
  // Should still go to bounded repair, not extraction
  const dispatches = ev.filter((e: any) => e.type === 'actor_dispatched');
  assert.ok(dispatches.length >= 2, 'bare invalid must trigger schema_repair');
  assert.equal(dispatches[1].extra.attempt_reason, 'schema_repair');
});

test('host: bare JSON that parses but fails schema stays semantic without envelope prefix', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const tmp = join(root, 'tmp-bare-bad.json');
  writeFileSync(tmp, BAD_VERDICT, 'utf8');
  const res = completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  assert.equal(res.state, 'completed');
  const ev = readEvents(join(root, '.fadeno', 'runs', runId)).events as any[];
  const completed = ev.find((e: any) => e.type === 'actor_completed' && e.extra.dispatch_id === dispatchId);
  assert.ok(completed);
  assert.equal(completed.extra.output_valid, false);
  assert.equal(completed.extra.output_extraction, undefined);
  assert.equal(completed.extra.raw_output, undefined);
  assert.ok(Array.isArray(completed.extra.validation_errors) && completed.extra.validation_errors.some((m: string) => !m.includes('envelope candidate failed schema')), 'host bare invalid errors must be plain Ajv messages');
  assert.ok(!completed.extra.validation_errors.some((m: string) => m.includes('envelope candidate failed schema')), 'host bare invalid must not have envelope prefix');
});

test('verify tamper: raw deletion, digest mismatch, non-substring, unknown kind', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const fenced = `\`\`\`json\n${VALID_REVIEW}\n\`\`\``;
  const tmp = join(root, 'tmp-tamper.json');
  writeFileSync(tmp, fenced, 'utf8');
  completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  const runDir = join(root, '.fadeno', 'runs', runId);
  let events = readEvents(runDir).events as any[];
  let completed = events.find((e: any) => e.type === 'actor_completed' && e.extra.dispatch_id === dispatchId);
  const rawRel = completed.extra.raw_output as string;
  const rawAbs = join(runDir, rawRel);
  const rawContent = readFileSync(rawAbs);
  const eventsPath = join(runDir, 'events.jsonl');

  // 1. deletion
  rmSync(rawAbs);
  let verify = runVerify({ repoRoot: root, run: runId });
  let env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'fail');
  assert.match(env.detail, /raw output file is missing/);
  writeFileSync(rawAbs, rawContent);

  // 2. digest mismatch
  writeFileSync(rawAbs, Buffer.concat([rawContent, Buffer.from(' ')]));
  verify = runVerify({ repoRoot: root, run: runId });
  env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'fail');
  assert.match(env.detail, /sha256 mismatch/);
  writeFileSync(rawAbs, rawContent);

  // 3. non-substring
  const outRel = completed.extra.output as string;
  const outAbs = join(runDir, outRel);
  const origOut = readFileSync(outAbs, 'utf8');
  writeFileSync(outAbs, origOut + ' tampered');
  verify = runVerify({ repoRoot: root, run: runId });
  env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'fail');
  assert.match(env.detail, /not a contiguous substring/);
  writeFileSync(outAbs, origOut);

  // 4. unknown kind
  let jsonl = readFileSync(eventsPath, 'utf8');
  jsonl = jsonl.replace('"output_extraction":"fenced"', '"output_extraction":"unknown_kind"');
  writeFileSync(eventsPath, jsonl, 'utf8');
  verify = runVerify({ repoRoot: root, run: runId });
  env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'fail');
  assert.match(env.detail, /unknown output_extraction kind/);
});

test('verify tamper: extraction metadata on output that is not valid must fail', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  // First create a valid extraction, then tamper the event to mark output_valid false while keeping extraction
  const fenced = `\`\`\`json\n${VALID_REVIEW}\n\`\`\``;
  const tmp = join(root, 'tmp-invalid-ext.json');
  writeFileSync(tmp, fenced, 'utf8');
  completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  const runDir = join(root, '.fadeno', 'runs', runId);
  const eventsPath = join(runDir, 'events.jsonl');
  let jsonl = readFileSync(eventsPath, 'utf8');
  // Tamper: flip output_valid to false but keep extraction metadata
  jsonl = jsonl.replace('"output_valid":true', '"output_valid":false');
  writeFileSync(eventsPath, jsonl, 'utf8');
  const verify = runVerify({ repoRoot: root, run: runId });
  const env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.ok(env, 'envelope-extraction finding must exist');
  assert.equal(env.status, 'fail', 'extraction on invalid output must fail verification');
  assert.match(env.detail, /output_extraction present but output_valid is not true/);
});

test('verify tamper: host idempotent resubmit with same raw bytes remains ok', (t: TestContext) => {
  // Already covered by host fenced idempotent test, but assert verify still ok after idempotent
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const fenced = `\`\`\`json\n${VALID_REVIEW}\n\`\`\``;
  const tmp = join(root, 'tmp-idem.json');
  writeFileSync(tmp, fenced, 'utf8');
  completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  // second identical resubmit should be idempotent and verify should stay ok
  const second = completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  assert.equal(second.idempotent, true);
  const verify = runVerify({ repoRoot: root, run: runId });
  const env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'ok');
});

test('verify replay-only tamper: ambiguous raw with updated digest still fails extraction replay', (t: TestContext) => {
  // Create a valid extraction, then replace raw with an ambiguous multi-candidate text
  // that still contains the normalized output as a contiguous substring.
  // Updating byte count/sha to match should keep digest+substring checks passing,
  // but deterministic replay must fail with ambiguous.
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const fenced = `\`\`\`json\n${VALID_REVIEW}\n\`\`\``;
  const tmp = join(root, 'tmp-replay.json');
  writeFileSync(tmp, fenced, 'utf8');
  completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  const runDir = join(root, '.fadeno', 'runs', runId);
  const events = readEvents(runDir).events as any[];
  const completed = events.find((e: any) => e.type === 'actor_completed' && e.extra.dispatch_id === dispatchId);
  const rawRel = completed.extra.raw_output as string;
  const rawAbs = join(runDir, rawRel);
  const outRel = completed.extra.output as string;
  const outText = readFileSync(join(runDir, outRel), 'utf8');
  const eventsPath = join(runDir, 'events.jsonl');

  // Craft ambiguous raw: two distinct valid fenced blocks, first is the original valid payload
  // so outText remains a substring. Second is a different valid payload.
  const ambiguousRaw = `\`\`\`json\n${VALID_REVIEW}\n\`\`\`\n\`\`\`json\n${VALID2}\n\`\`\``;
  assert.ok(ambiguousRaw.includes(outText), 'ambiguous raw must still contain normalized output as substring');
  const newBytes = Buffer.from(ambiguousRaw, 'utf8');
  const newSha = createHash('sha256').update(newBytes).digest('hex');
  writeFileSync(rawAbs, newBytes);
  // Patch events.jsonl to update raw_output_bytes and raw_output_sha256 to match new raw
  let jsonl = readFileSync(eventsPath, 'utf8');
  // Replace the recorded bytes and sha256 for this extraction's raw_output
  // The event line contains "raw_output_bytes":<old>, "raw_output_sha256":"<old>"
  const oldBytes = completed.extra.raw_output_bytes as number;
  const oldSha = completed.extra.raw_output_sha256 as string;
  jsonl = jsonl.replace(`"raw_output_bytes":${oldBytes}`, `"raw_output_bytes":${newBytes.length}`);
  jsonl = jsonl.replace(`"raw_output_sha256":"${oldSha}"`, `"raw_output_sha256":"${newSha}"`);
  writeFileSync(eventsPath, jsonl, 'utf8');

  const verify = runVerify({ repoRoot: root, run: runId });
  const env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.ok(env, 'envelope-extraction finding must exist');
  assert.equal(env.status, 'fail', 'ambiguous replay must fail verification');
  assert.match(env.detail, /replay of extraction failed \(ambiguous\)/, `expected ambiguous replay failure, got ${env.detail}`);
});

test('verify tamper: missing raw_output_bytes fails', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const fenced = `\`\`\`json\n${VALID_REVIEW}\n\`\`\``;
  const tmp = join(root, 'tmp-missing-bytes.json');
  writeFileSync(tmp, fenced, 'utf8');
  completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  const runDir = join(root, '.fadeno', 'runs', runId);
  const eventsPath = join(runDir, 'events.jsonl');
  let jsonl = readFileSync(eventsPath, 'utf8');
  // Remove raw_output_bytes field entirely
  jsonl = jsonl.replace(/,"raw_output_bytes":\d+/, '');
  writeFileSync(eventsPath, jsonl, 'utf8');
  const verify = runVerify({ repoRoot: root, run: runId });
  const env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'fail');
  assert.match(env.detail, /raw_output_bytes must be a non-negative integer/);
});

test('verify tamper: non-integer raw_output_bytes fails', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const fenced = `\`\`\`json\n${VALID_REVIEW}\n\`\`\``;
  const tmp = join(root, 'tmp-bad-bytes.json');
  writeFileSync(tmp, fenced, 'utf8');
  completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  const runDir = join(root, '.fadeno', 'runs', runId);
  const eventsPath = join(runDir, 'events.jsonl');
  let jsonl = readFileSync(eventsPath, 'utf8');
  // Tamper to float
  jsonl = jsonl.replace(/"raw_output_bytes":\d+/, '"raw_output_bytes":3.14');
  writeFileSync(eventsPath, jsonl, 'utf8');
  let verify = runVerify({ repoRoot: root, run: runId });
  let env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'fail');
  assert.match(env.detail, /raw_output_bytes must be a non-negative integer/);

  // Also check incorrect integer value fails
  jsonl = readFileSync(eventsPath, 'utf8');
  // This jsonl currently has 3.14, replace with wrong integer 999
  jsonl = jsonl.replace(/"raw_output_bytes":3\.14/, '"raw_output_bytes":999');
  writeFileSync(eventsPath, jsonl, 'utf8');
  verify = runVerify({ repoRoot: root, run: runId });
  env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'fail');
  assert.match(env.detail, /raw_output_bytes 999 does not match actual/);
});

test('verify tamper: envelope_candidates missing or wrong fails', (t: TestContext) => {
  const { root, runId, dispatchId } = seedHostEnvelopeRun(t);
  const fenced = `\`\`\`json\n${VALID_REVIEW}\n\`\`\``;
  const tmp = join(root, 'tmp-candidates.json');
  writeFileSync(tmp, fenced, 'utf8');
  completeHostDispatch({ repoRoot: root, run: runId, dispatchId, output: tmp });
  const runDir = join(root, '.fadeno', 'runs', runId);
  const eventsPath = join(runDir, 'events.jsonl');
  let jsonl = readFileSync(eventsPath, 'utf8');
  // Remove envelope_candidates
  jsonl = jsonl.replace(/,"envelope_candidates":\d+/, '');
  writeFileSync(eventsPath, jsonl, 'utf8');
  let verify = runVerify({ repoRoot: root, run: runId });
  let env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'fail');
  assert.match(env.detail, /envelope_candidates must be a positive integer/);

  // Restore then set wrong count (should be 1, set to 99) -> replay candidates mismatch
  jsonl = readFileSync(eventsPath, 'utf8');
  // Need to re-add field? Simpler to recreate run and tamper with wrong value.
  const { root: root2, runId: runId2, dispatchId: d2 } = seedHostEnvelopeRun(t);
  writeFileSync(join(root2, 'tmp-candidates2.json'), fenced, 'utf8');
  // use same tmp? create new
  const tmp2 = join(root2, 'tmp-c2.json');
  writeFileSync(tmp2, fenced, 'utf8');
  completeHostDispatch({ repoRoot: root2, run: runId2, dispatchId: d2, output: tmp2 });
  const eventsPath2 = join(root2, '.fadeno', 'runs', runId2, 'events.jsonl');
  let jsonl2 = readFileSync(eventsPath2, 'utf8');
  jsonl2 = jsonl2.replace(/"envelope_candidates":1/, '"envelope_candidates":99');
  writeFileSync(eventsPath2, jsonl2, 'utf8');
  verify = runVerify({ repoRoot: root2, run: runId2 });
  env = verify.findings.find((f: any) => f.check === 'envelope-extraction');
  assert.equal(env.status, 'fail');
  assert.match(env.detail, /replay candidates 1 does not match recorded 99/);
});

test('engine: envelope_candidates counts pre-dedupe non-vacuous', (t: TestContext) => {
  // Duplicate identical blocks should report 2 candidates, single block 1 — proves dedupe is observable
  const singleCmd = ['node', '-e', `process.stdout.write(\`\\\`\\\`\\\`json\\n${VALID_REVIEW}\\n\\\`\\\`\\\`\\n\`)`];
  const { root: root1, runId: id1 } = seedEngineEnvelopeRun(t, singleCmd);
  runDrive({ repoRoot: root1, run: id1 });
  const ev1 = readEvents(join(root1, '.fadeno', 'runs', id1)).events as any[];
  const c1 = ev1.find((e: any) => e.type === 'actor_completed')!.extra.envelope_candidates;
  assert.equal(c1, 1, 'single fenced block should have 1 candidate');

  const dupCmd = ['node', '-e', `process.stdout.write(\`\\\`\\\`\\\`json\\n${VALID_REVIEW}\\n\\\`\\\`\\\`\\nAgain\\n\\\`\\\`\\\`json\\n${VALID_REVIEW}\\n\\\`\\\`\\\`\\n\`)`];
  const { root: root2, runId: id2 } = seedEngineEnvelopeRun(t, dupCmd);
  runDrive({ repoRoot: root2, run: id2 });
  const ev2 = readEvents(join(root2, '.fadeno', 'runs', id2)).events as any[];
  const c2 = ev2.find((e: any) => e.type === 'actor_completed')!.extra.envelope_candidates;
  assert.equal(c2, 2, 'duplicate identical blocks should report 2 candidates (pre-dedupe), proving dedupe observable');
});
