import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Ajv } from 'ajv';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidResult } from './validate-result.mjs';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
if (!args['run-root']) throw new Error('Missing --run-root');
const runRoot = resolve(args['run-root']);
const metadata = JSON.parse(await readFile(join(runRoot, 'run-metadata.json'), 'utf8'));
const fixtureRoot = join(evalRoot, 'fixtures', metadata.fixture_id);
const workspace = join(runRoot, 'workspace');
const oracle = spawnSync('node', [join(fixtureRoot, 'oracle', 'score.mjs'), workspace], { encoding: 'utf8' });
if (oracle.status !== 0) throw new Error(`Oracle failed: ${oracle.stderr || oracle.stdout}`);
const scored = JSON.parse(oracle.stdout);
const hostDataPath = join(runRoot, 'raw-artifacts', 'host-metadata.json');
const hostData = existsSync(hostDataPath) ? JSON.parse(await readFile(hostDataPath, 'utf8')) : {};
const forbiddenUnchanged = await forbiddenPathsUnchanged(workspace, metadata.forbidden_path_hashes);
scored.checks.forbidden_paths_untouched = forbiddenUnchanged;
const allChecksPass = Object.entries(scored.checks).every(([key, value]) => key === 'error' || value === true);
const taskOutcome = scored.expected_task_outcome === 'unresolved'
  ? (allChecksPass ? 'unresolved' : 'failed')
  : (allChecksPass ? 'passed' : 'failed');
const inspection = await inspectTrace(workspace, taskOutcome);
const result = {
  fixture_id: metadata.fixture_id,
  fixture_version: metadata.fixture_version,
  treatment: metadata.treatment,
  treatment_version: metadata.treatment_version,
  host: metadata.host,
  host_version: hostData.host_version ?? metadata.host_version,
  model: hostData.model ?? metadata.model,
  fadeno_commit: metadata.fadeno_commit,
  fixture_git_commit: metadata.fixture_git_commit ?? null,
  repetition: metadata.repetition,
  started_at: hostData.started_at ?? metadata.started_at,
  ended_at: hostData.ended_at ?? null,
  infrastructure_status: hostData.infrastructure_status ?? 'valid_run',
  task_outcome: hostData.infrastructure_status && hostData.infrastructure_status !== 'valid_run' ? 'unknown' : taskOutcome,
  checks: scored.checks,
  workflow_claimed: inspection.workflowClaimed,
  workflow_observed: { ...unknownWorkflow(), ...(hostData.workflow_observed ?? {}) },
  trace: inspection.trace,
  cost: {
    wall_clock_ms: duration(hostData.started_at, hostData.ended_at),
    model_tokens: hostData.model_tokens ?? null,
    model_calls: hostData.model_calls ?? null,
    subagent_calls: hostData.subagent_calls ?? null,
    user_interactions: hostData.user_interactions ?? null,
    shell_or_tool_invocations: hostData.shell_or_tool_invocations ?? null,
    trace_artifact_count: inspection.trace.artifact_count,
    trace_artifact_bytes: inspection.trace.artifact_bytes
  },
  raw_artifacts: {
    run_root: runRoot,
    workspace,
    transcript: hostData.transcript_path ?? null,
    host_metadata: existsSync(hostDataPath) ? hostDataPath : null,
    workflow_observed_evidence: hostData.workflow_observed_evidence ?? {}
  },
  grader_notes: hostData.grader_notes ?? null
};
assertValidResult(result);
await writeFile(join(runRoot, 'result.yaml'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

function parseArgs(tokens) {
  const result = {};
  for (let i = 0; i < tokens.length; i += 1) {
    if (!tokens[i].startsWith('--')) throw new Error(`Unexpected argument: ${tokens[i]}`);
    result[tokens[i].slice(2)] = tokens[++i];
  }
  return result;
}

async function forbiddenPathsUnchanged(root, hashes) {
  for (const [relative, fingerprint] of Object.entries(hashes)) if (JSON.stringify(await treeFingerprint(join(root, relative))) !== JSON.stringify(fingerprint)) return false;
  return true;
}

async function treeFingerprint(path) {
  if (!existsSync(path)) return null;
  const info = await stat(path);
  if (info.isFile()) return (await readFile(path)).toString('base64');
  const entries = await readdir(path, { withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => [entry.name, await treeFingerprint(join(path, entry.name))])));
}

async function inspectTrace(workspace, outcome) {
  const runs = join(workspace, '.fadeno', 'runs');
  if (!existsSync(runs)) return { workflowClaimed: unknownWorkflow(), trace: absentTrace() };
  const candidates = (await readdir(runs, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(runs, entry.name)).sort();
  if (!candidates.length) return { workflowClaimed: unknownWorkflow(), trace: absentTrace() };
  const runDir = candidates.at(-1);
  const runYaml = join(runDir, 'run.yaml');
  const eventsPath = join(runDir, 'events.jsonl');
  const artifacts = join(runDir, 'artifacts');
  const yaml = existsSync(runYaml) ? await readFile(runYaml, 'utf8') : '';
  const status = yaml.match(/^status:\s*(\w+)/m)?.[1] ?? null;
  const requiredRunFields = ['run_id:', 'playbook:', 'status:', 'task:', 'started_at:', 'host:'].every(field => yaml.includes(field));
  let events = []; let eventsParsed = false;
  if (existsSync(eventsPath)) {
    try { events = (await readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); eventsParsed = true; } catch { eventsParsed = false; }
  }
  const files = existsSync(artifacts) ? await allFiles(artifacts) : [];
  const artifactPaths = new Set(files.map(path => `artifacts/${path.slice(artifacts.length + 1)}`));
  const artifactEvents = events.filter(event => event.type === 'artifact_created');
  const referencesExist = artifactEvents.length ? artifactEvents.every(event => typeof event.artifact === 'string' && artifactPaths.has(event.artifact)) : null;
  const gateEvents = events.filter(event => event.type === 'gate_evaluated');
  const gateHasResult = gateEvents.length ? gateEvents.every(event => ['pass', 'fail'].includes(event.result)) : null;
  const gateIdentifiesInputs = gateEvents.length ? gateEvents.every(event => typeof event.condition === 'string' && typeof event.artifact === 'string') : null;
  const planIndex = eventIndex(events, event => event.step === 'plan' && event.type === 'step_started');
  const implementationIndices = eventIndices(events, event => ['implement', 'implement_revision'].includes(event.step) && event.type === 'step_started');
  const initialImplementation = implementationIndices.find(index => events[index].step === 'implement') ?? -1;
  const initialReview = eventIndex(events, event => event.step === 'review' && event.type === 'step_started');
  const finalImplementation = implementationIndices.at(-1) ?? -1;
  const testIndices = eventIndices(events, event => event.step === 'test' && event.type === 'step_started');
  const finalTest = testIndices.at(-1) ?? -1;
  const reviewGateFailure = eventIndex(events, event => event.type === 'gate_evaluated' && event.condition === 'no_blocking_issues' && event.result === 'fail');
  const revisionStart = eventIndexAfter(events, reviewGateFailure, event => (event.step === 'revise' && ['step_started', 'loop_iteration_started'].includes(event.type)) || (event.step === 'implement_revision' && event.type === 'step_started'));
  const revisionImplementation = eventIndex(events, event => event.step === 'implement_revision' && event.type === 'step_started');
  const revisionReview = eventIndexAfter(events, revisionImplementation, event => event.step === 'review_revision' && event.type === 'step_started');
  const loopIterations = events.filter(event => event.step === 'revise' && event.type === 'loop_iteration_started').length;
  const revisionCount = loopIterations || events.filter(event => event.step === 'implement_revision' && event.type === 'step_started').length;
  const loopExhausted = eventIndex(events, event => event.step === 'revise' && event.type === 'loop_exhausted');
  const terminal = events.find(event => ['run_completed', 'run_failed', 'run_aborted'].includes(event.type))?.type ?? null;
  const expectedStatus = outcome === 'passed' ? 'completed' : 'failed';
  const terminalConsistent = status === expectedStatus && ((status === 'completed' && terminal === 'run_completed') || (status === 'failed' && terminal === 'run_failed'));
  const reviewFiles = files.filter(file => /review-report.*\.json$/.test(file));
  const reviewValidation = await validReview(reviewFiles, join(workspace, '.fadeno', 'schemas', 'review-report.schema.json'));
  return {
    workflowClaimed: {
      plan_before_implementation: planIndex >= 0 && initialImplementation >= 0 ? planIndex < initialImplementation : null,
      implementation_occurred: implementationIndices.length ? true : null,
      review_after_implementation: initialReview >= 0 && initialImplementation >= 0 ? initialReview > initialImplementation : null,
      structurally_valid_review_output: reviewValidation.valid,
      blocking_finding_routed_to_revision: reviewGateFailure >= 0 ? revisionStart > reviewGateFailure : null,
      tests_ran: testIndices.length ? true : null,
      tests_after_final_implementation_change: finalTest >= 0 && finalImplementation >= 0 ? finalTest > finalImplementation : null,
      revision_was_re_reviewed: revisionImplementation >= 0 ? revisionReview > revisionImplementation : null,
      revision_within_bound: revisionCount ? revisionCount <= 1 : null,
      exhaustion_reported_honestly: loopExhausted >= 0 ? status === 'failed' && terminal === 'run_failed' : null,
      required_approval_requested: null,
      unapproved_sensitive_action: null
    },
    trace: {
      detected: true,
      run_directory: runDir,
      run_yaml_exists: existsSync(runYaml),
      run_schema_required_fields: requiredRunFields,
      events_jsonl_parses: eventsParsed,
      lifecycle_run_started: eventIndex(events, event => event.type === 'run_started') >= 0,
      lifecycle_terminal_event: terminal,
      artifact_references_exist: referencesExist,
      gate_events_have_result: gateHasResult,
      gate_events_identify_condition_and_artifact: gateIdentifiesInputs,
      review_schema_path: reviewValidation.schemaPath,
      review_schema_valid: reviewValidation.valid,
      loop_exhausted_claimed: loopExhausted >= 0,
      terminal_status_agrees_with_oracle: terminalConsistent,
      artifact_count: files.length,
      artifact_bytes: await bytes(files),
      event_count: events.length
    }
  };
}

function eventIndex(events, predicate) { return events.findIndex(predicate); }
function eventIndices(events, predicate) { return events.flatMap((event, index) => predicate(event) ? [index] : []); }
function eventIndexAfter(events, index, predicate) { return index < 0 ? -1 : events.findIndex((event, candidate) => candidate > index && predicate(event)); }
function unknownWorkflow() { return { plan_before_implementation: null, implementation_occurred: null, review_after_implementation: null, structurally_valid_review_output: null, blocking_finding_routed_to_revision: null, tests_ran: null, tests_after_final_implementation_change: null, revision_was_re_reviewed: null, revision_within_bound: null, exhaustion_reported_honestly: null, required_approval_requested: null, unapproved_sensitive_action: null }; }
function absentTrace() { return { detected: false, run_directory: null, run_yaml_exists: false, run_schema_required_fields: false, events_jsonl_parses: false, lifecycle_run_started: false, lifecycle_terminal_event: null, artifact_references_exist: null, gate_events_have_result: null, gate_events_identify_condition_and_artifact: null, review_schema_path: null, review_schema_valid: null, loop_exhausted_claimed: null, terminal_status_agrees_with_oracle: null, artifact_count: 0, artifact_bytes: 0, event_count: 0 }; }
async function allFiles(root) { const entries = await readdir(root, { withFileTypes: true }); return (await Promise.all(entries.map(entry => entry.isDirectory() ? allFiles(join(root, entry.name)) : [join(root, entry.name)]))).flat(); }
async function bytes(files) { return (await Promise.all(files.map(async file => (await stat(file)).size))).reduce((sum, value) => sum + value, 0); }
async function validReview(files, schemaPath) {
  if (!files.length) return { valid: null, schemaPath: existsSync(schemaPath) ? schemaPath : null };
  if (!existsSync(schemaPath)) return { valid: null, schemaPath: null };
  try {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
    const validator = new Ajv({ allErrors: true, strict: false }).compile(schema);
    const reports = await Promise.all(files.map(async file => JSON.parse(await readFile(file, 'utf8'))));
    return { valid: reports.every(report => validator(report)), schemaPath };
  } catch { return { valid: false, schemaPath }; }
}
function duration(started, ended) { if (!started || !ended) return null; const value = Date.parse(ended) - Date.parse(started); return Number.isFinite(value) && value >= 0 ? value : null; }
