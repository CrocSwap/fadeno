import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { parseExecutorProfile, parseSnapshotDocument, serializeSnapshot, ExecutorProfileError } from '../src/lib/executors.ts';
import { loadLayeredProfile } from '../src/lib/config-layers.ts';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempRepo } from './helpers.ts';
import { seedToolRepo } from './tool-helpers.ts';
import { runToolRun } from '../src/commands/tool-run.ts';
import { stringify as stringifyYaml } from 'yaml';

/** Helper to parse catalog text with harness standalone */
function parseCatalog(text: string, source = 'test') {
  return parseExecutorProfile(text, source, 'standalone');
}
function parseSnapshot(text: string, source = 'test snapshot') {
  return parseSnapshotDocument(text, source);
}

// Strict registry accept/reject table at both catalog and snapshot parse boundaries
const validTools = [
  { name: 'test_runner', command: ['npm', 'test'], timeout_ms: 300000 },
  { name: 'lint', command: ['npm', 'run', 'lint'], timeout: 60 },
  { name: 'my_tool', command: ['node', '-e', 'process.exit(0)'] },
];

const rejectCases: Array<{ doc: string; msg: string }> = [
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  bad:\n    command: npm test\n`, msg: 'bare string' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  bad:\n    command: []\n`, msg: 'empty argv' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  bad:\n    command: ['npm', '']\n`, msg: 'empty part' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  bad:\n    command: ['npm', '   ']\n`, msg: 'whitespace-only part' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  bad:\n    command: ['npm', 'test {placeholder}']\n`, msg: 'interpolation brace' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  bad:\n    command: ['npm', 'test \$HOME']\n`, msg: 'dollar' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  bad:\n    command: ['npm', 'test \`backtick\`']\n`, msg: 'backtick' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  bad:\n    command: ['npm', 'test\n']\n`, msg: 'newline' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  BadName:\n    command: ['npm', 'test']\n`, msg: 'non-bare name' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  good:\n    command: ['npm', 'test']\n    unknown: 123\n`, msg: 'unknown key' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  good:\n    command: ['npm', 'test']\n    timeout_ms: 0\n`, msg: 'timeout_ms 0' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  good:\n    command: ['npm', 'test']\n    timeout_ms: -1\n`, msg: 'timeout_ms -1' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  good:\n    command: ['npm', 'test']\n    timeout_ms: 1.5\n`, msg: 'timeout_ms float' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  good:\n    command: ['npm', 'test']\n    timeout: 0\n`, msg: 'timeout 0' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  good:\n    command: ['npm', 'test']\n    timeout: 1.5\n`, msg: 'timeout float' },
  { doc: `schema_version: 3\nmodels: {}\nroutes: {}\ntools:\n  good:\n    command: ['npm', 'test']\n    timeout: 5\n    timeout_ms: 5000\n`, msg: 'both timeouts' },
];

for (const { doc, msg } of rejectCases) {
  test(`registry catalog rejects ${msg}`, () => {
    assert.throws(() => parseCatalog(doc), (err) => err instanceof ExecutorProfileError);
  });
  test(`registry snapshot rejects ${msg}`, () => {
    // Build snapshot text that includes same tool error via serialized snapshot? Instead directly test parseSnapshotDocument with similar structure
    const snapshotDoc = doc.replace('schema_version: 3', 'snapshot_version: 3').replace('models:', 'executors:\n  dummy: {adapter: command, command: [echo, hi]}\nmodels:');
    // Simpler: construct minimal snapshot with tools entry mimicking catalog error
    // For snapshot, executors is required, so we need to craft snapshot that fails on tools
    // We'll build a snapshot text manually with tools having same error
    let snap = `snapshot_version: 3\nexecutors:\n  dummy: {adapter: command, command: [echo, hi]}\ntools:\n`;
    // Extract tool block from doc
    const toolBlock = doc.split('tools:\n')[1];
    if (toolBlock) {
      snap += toolBlock;
      assert.throws(() => parseSnapshot(snap), (err) => err instanceof ExecutorProfileError);
    } else {
      assert.throws(() => parseSnapshot(snap), (err) => err instanceof ExecutorProfileError);
    }
  });
}

test('registry accepts valid tools', () => {
  let doc = `schema_version: 3\nmodels: {a: {provider: dummy, id: a, effort: xhigh}}\nroutes: {standalone: {dummy: {host: true}}}\ntools:\n`;
  for (const t of validTools) {
    doc += `  ${t.name}:\n    command: [${t.command.map((c) => JSON.stringify(c)).join(', ')}]\n`;
    if ((t as any).timeout_ms) doc += `    timeout_ms: ${(t as any).timeout_ms}\n`;
    if ((t as any).timeout) doc += `    timeout: ${(t as any).timeout}\n`;
  }
  const profile = parseCatalog(doc);
  for (const t of validTools) {
    assert.ok(profile.tools[t.name]);
    assert.deepEqual(profile.tools[t.name]!.command, t.command);
  }
  // Ensure timeout seconds converted to ms
  assert.equal(profile.tools['lint']!.timeoutMs, 60000);
});

test('registry snapshot round-trip preserves tools', () => {
  const doc = `schema_version: 3
models:
  luna: {provider: dummy, id: gpt-5.6-luna, effort: xhigh}
routes:
  standalone:
    dummy: {host: true}
tools:
  test_runner: {command: [npm, test], timeout_ms: 300000}
  lint: {command: [npm, run, lint], timeout: 60}
`;
  const profile = parseCatalog(doc);
  const snapshotText = serializeSnapshot(profile, []);
  const parsed = parseSnapshot(snapshotText);
  assert.deepEqual(parsed.tools['test_runner']!.command, ['npm', 'test']);
  assert.equal(parsed.tools['test_runner']!.timeoutMs, 300000);
  assert.equal(parsed.tools['lint']!.timeoutMs, 60000);
  // Snapshot parse enforces same predicates (whitespace etc.) – already tested above
});

/** A user-scoped catalog carrying one tool, isolated from the developer's own. */
function userScopeWithTool(t: TestContext, tools: Record<string, unknown>): { env: Record<string, string | undefined> } {
  const configHome = tempRepo(t);
  mkdirSync(join(configHome, 'fadeno'), { recursive: true });
  writeFileSync(join(configHome, 'fadeno', 'executors.yaml'), stringifyYaml({ schema_version: 3, tools }));
  return { env: { ...process.env, FADENO_CONFIG_HOME: configHome } };
}

test('tool layering: the builtin catalog ships no tools, and a project catalog that is not self-contained keeps the user tool', (t) => {
  const root = tempRepo(t);
  const userScope = userScopeWithTool(t, { user_tool: { command: ['echo', 'user'] } });

  // Builtin alone: the shipped catalog documents `tools:` by example only.
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  const builtinOnly = loadLayeredProfile(root, { env: { ...process.env, FADENO_CONFIG_HOME: tempRepo(t) } }, 'standalone');
  assert.deepEqual(Object.keys(builtinOnly.profile.tools), [], 'builtin ships no bound tools');

  // Project catalog without models+routes: layering stays on, so all three merge.
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    tools: { project_tool: { command: ['echo', 'project'] } },
  }));
  const layered = loadLayeredProfile(root, userScope, 'standalone');
  assert.equal(layered.selfContained, false);
  assert.deepEqual(layered.layers, ['builtin', 'user', 'project']);
  assert.deepEqual(layered.profile.tools['user_tool']!.command, ['echo', 'user'], 'the user tool survives layering');
  assert.deepEqual(layered.profile.tools['project_tool']!.command, ['echo', 'project']);
});

test('tool layering: a self-contained project catalog suppresses the user tool entirely', (t) => {
  const root = tempRepo(t);
  const userScope = userScopeWithTool(t, { user_tool: { command: ['echo', 'user'] } });
  mkdirSync(join(root, '.fadeno'), { recursive: true });
  writeFileSync(join(root, '.fadeno', 'executors.yaml'), stringifyYaml({
    schema_version: 3,
    models: { custom: { provider: 'dummy', id: 'custom', effort: 'xhigh' } },
    routes: { standalone: { dummy: { host: true } } },
    tools: { project_tool: { command: ['echo', 'project'] } },
  }));

  const layered = loadLayeredProfile(root, userScope, 'standalone');
  assert.equal(layered.selfContained, true);
  assert.deepEqual(layered.layers, ['project']);
  assert.deepEqual(Object.keys(layered.profile.tools), ['project_tool']);
  assert.equal(layered.profile.tools['user_tool'], undefined, 'a self-contained project catalog suppresses the user tool');
});

test('a project-registered tool is the binding a run executes', (t) => {
  const setup = seedToolRepo(t, { project_tool: { command: ['node', '-e', 'process.exit(0)'] } }, [
    { id: 'test', kind: 'tool_call', tool: 'project_tool', output: 'TestResult' },
  ]);
  const result = runToolRun({ repoRoot: setup.root, run: setup.runId });
  assert.equal(result.tool, 'project_tool');
  assert.equal(result.status, 'passed');
  const snapshot = parseSnapshotDocument(readFileSync(join(setup.runDir, 'profile.yaml'), 'utf8'), 'profile.yaml');
  assert.deepEqual(snapshot.tools['project_tool']!.command, ['node', '-e', 'process.exit(0)']);
});

test('snapshot parse enforces same whitespace rejection as catalog', () => {
  const catalogDoc = `schema_version: 3
models:
  dummy: {provider: dummy, id: a, effort: xhigh}
routes:
  standalone:
    dummy: {host: true}
tools:
  bad:
    command: ['npm', '   ']
`;
  assert.throws(() => parseCatalog(catalogDoc), /empty or whitespace/);
  const snapshotDoc = `snapshot_version: 3
executors:
  dummy: {adapter: command, command: [echo, hi]}
tools:
  bad:
    command: ['npm', '   ']
`;
  assert.throws(() => parseSnapshot(snapshotDoc), /empty or whitespace/);
});
