import { readFile } from 'node:fs/promises';

if (!process.argv.slice(2).length) throw new Error('Provide one or more result.yaml files');
const results = await Promise.all(process.argv.slice(2).map(async path => JSON.parse(await readFile(path, 'utf8'))));
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
