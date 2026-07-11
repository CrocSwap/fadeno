import { readdir, readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const validOnly = args.includes('--valid-only');
const directoryIndex = args.indexOf('--results-dir');
const explicitPaths = args.filter((argument, index) => argument !== '--valid-only' && argument !== '--results-dir' && index !== directoryIndex + 1);
const discoveredPaths = directoryIndex === -1 ? [] : await findResults(args[directoryIndex + 1]);
const paths = [...explicitPaths, ...discoveredPaths].sort();
if (!paths.length) throw new Error('Provide result.yaml files or --results-dir <directory>');
const loaded = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
const results = validOnly ? loaded.filter(result => result.infrastructure_status === 'valid_run') : loaded;
const byTreatment = groupBy(results, result => result.treatment);
const summary = Object.fromEntries(Object.entries(byTreatment).map(([treatment, rows]) => [treatment, {
  runs: rows.length,
  infrastructure_statuses: counts(rows.map(row => row.infrastructure_status)),
  task_outcomes: counts(rows.map(row => row.task_outcome)),
  checks: vectors(rows, 'checks'),
  workflow_claimed: vectors(rows, 'workflow_claimed'),
  workflow_observed: vectors(rows, 'workflow_observed'),
  trace: vectors(rows, 'trace'),
  cost: vectors(rows, 'cost')
}]));
console.log(JSON.stringify({ generated_at: new Date().toISOString(), results: summary, note: 'Raw vectors only; no composite score.' }, null, 2));

function groupBy(values, key) { return values.reduce((groups, value) => { const group = String(key(value)); (groups[group] ??= []).push(value); return groups; }, {}); }
function counts(values) { return Object.fromEntries(Object.entries(groupBy(values, String)).map(([value, group]) => [value, group.length])); }
function vectors(rows, key) { const fields = new Set(rows.flatMap(row => Object.keys(row[key] ?? {}))); return Object.fromEntries([...fields].sort().map(field => [field, rows.map(row => row[key]?.[field] ?? null)])); }

async function findResults(directory) {
  if (!directory) throw new Error('--results-dir requires a directory');
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return findResults(path);
    return entry.isFile() && entry.name === 'result.yaml' ? [path] : [];
  }));
  return nested.flat();
}
