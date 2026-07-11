import Ajv2020 from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const evalRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(await readFile(joinSchema(), 'utf8'));
const validator = new Ajv2020({ allErrors: true }).compile(schema);

export function assertValidResult(result) {
  if (!validator(result)) throw new Error(`Invalid evaluation result: ${validator.errors.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Provide a result.yaml path');
  assertValidResult(JSON.parse(await readFile(process.argv[2], 'utf8')));
  console.log('valid');
}

function joinSchema() { return resolve(evalRoot, 'schemas', 'eval-result.schema.json'); }
