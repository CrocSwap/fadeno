import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(evalRoot, '..');
const args = parseArgs(process.argv.slice(2));
for (const name of ['fixture', 'treatment', 'host', 'repetition', 'fadeno-commit']) {
  if (!args[name]) throw new Error(`Missing --${name}`);
}
const fixtureDir = join(evalRoot, 'fixtures', args.fixture);
const treatmentPath = join(evalRoot, 'treatments', `${args.treatment}.md`);
if (!existsSync(join(fixtureDir, 'repo')) || !existsSync(treatmentPath)) throw new Error('Unknown fixture or treatment');
try { execFileSync('git', ['cat-file', '-e', `${args['fadeno-commit']}^{commit}`], { cwd: repoRoot, stdio: 'ignore' }); }
catch { throw new Error(`Fadeno commit is not a locally available commit: ${args['fadeno-commit']}`); }
const expected = JSON.parse(await readFile(join(fixtureDir, 'oracle', 'expected.json'), 'utf8'));
const treatmentText = await readFile(treatmentPath, 'utf8');
const treatmentVersion = treatmentText.match(/v(\d+)/)?.[1] ?? 'unversioned';
const stamp = new Date().toISOString().replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
const runRoot = resolve(args.out ?? join(evalRoot, 'results', `${stamp}-${args.fixture}-${args.treatment}-${args.host}-r${args.repetition}`));
if (existsSync(runRoot)) throw new Error(`Run root already exists: ${runRoot}`);
await mkdir(runRoot, { recursive: true });
const workspace = join(runRoot, 'workspace');
await cp(join(fixtureDir, 'repo'), workspace, { recursive: true, errorOnExist: true });
if (args.treatment.startsWith('fadeno-')) {
  await mkdir(join(workspace, '.fadeno'));
  const archive = spawnSync('git', ['archive', '--format=tar', `${args['fadeno-commit']}:templates/common/fadeno`], { cwd: repoRoot });
  if (archive.status !== 0) throw new Error(`Could not archive Fadeno definitions at ${args['fadeno-commit']}: ${archive.stderr}`);
  const extracted = spawnSync('tar', ['-xf', '-', '-C', join(workspace, '.fadeno')], { input: archive.stdout });
  if (extracted.status !== 0) throw new Error(`Could not extract pinned Fadeno definitions: ${extracted.stderr}`);
}
await mkdir(join(runRoot, 'raw-artifacts'));
const task = await readFile(join(fixtureDir, 'task.md'), 'utf8');
const pin = args.treatment.startsWith('fadeno-') ? `\n\nPinned Fadeno definitions were seeded from commit ${args['fadeno-commit']}. Confirm the host capability is pinned to the same commit before executing.\n` : '';
const agentInput = `${task.trim()}\n\n---\n\n${args.treatment === 'plain-prompt' ? '' : treatmentText.trim()}${pin}\n`;
await writeFile(join(runRoot, 'agent-input.md'), agentInput);
const metadata = {
  fixture_id: args.fixture,
  fixture_version: expected.fixture_version,
  treatment: args.treatment,
  treatment_version: treatmentVersion,
  host: args.host,
  host_version: args['host-version'] ?? null,
  model: args.model ?? null,
  fadeno_commit: args['fadeno-commit'],
  repetition: Number(args.repetition),
  started_at: new Date().toISOString(),
  fixture_expected_outcome: expected.expected_task_outcome,
  forbidden_path_hashes: await hashesFor(join(fixtureDir, 'repo'), expected.forbidden_paths ?? []),
  notes: 'Place host transcript and optional raw-artifacts/host-metadata.json here. Do not alter metadata after session start.'
};
await writeFile(join(runRoot, 'run-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(runRoot);

function parseArgs(tokens) {
  const result = {};
  for (let i = 0; i < tokens.length; i += 1) {
    if (!tokens[i].startsWith('--')) throw new Error(`Unexpected argument: ${tokens[i]}`);
    result[tokens[i].slice(2)] = tokens[++i];
  }
  return result;
}

async function hashesFor(root, paths) {
  const values = {};
  for (const relative of paths) values[relative] = await treeFingerprint(join(root, relative));
  return values;
}

async function treeFingerprint(path) {
  if (!existsSync(path)) return null;
  const info = await stat(path);
  if (info.isFile()) return (await readFile(path)).toString('base64');
  const entries = await readdir(path, { withFileTypes: true });
  return Object.fromEntries(await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => [entry.name, await treeFingerprint(join(path, entry.name))])));
}
