import assert from 'node:assert/strict';
import test from 'node:test';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractSchemaEnvelope } from '../src/lib/schema-envelope.ts';

const schemaPath = join(import.meta.dirname, '..', 'templates', 'common', 'fadeno', 'schemas', 'review-report.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true, verbose: true });
const validate = ajv.compile(schema) as (parsed: unknown) => boolean;

const VALID = JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'approve' });
const VALID2 = JSON.stringify({ reviewer: 'r2', summary: 's2', issues: [], verdict: 'approve' });
const BLOCKING = JSON.stringify({ reviewer: 'r', summary: 's', issues: [{ severity: 'blocking', title: 't' }], verdict: 'request_changes' });

function ensureSubstring(raw: string, payload: string): void {
  assert.ok(raw.includes(payload), `payload ${JSON.stringify(payload)} not substring of raw ${JSON.stringify(raw.slice(0, 200))}`);
}

test('BOM trimmed tier accepts valid payload and preserves substring', () => {
  const raw = '\uFEFF' + VALID;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'bom_trimmed');
  assert.equal(result.extraction.payload, VALID);
  ensureSubstring(raw, result.extraction.payload);
});

test('BOM tier trims surrounding whitespace', () => {
  const raw = '\uFEFF  \n\t ' + VALID + '  \n';
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'bom_trimmed');
  assert.equal(result.extraction.payload, VALID);
  ensureSubstring(raw, result.extraction.payload);
});

test('BOM tier with schema-invalid candidate returns schema_invalid', () => {
  const bad = JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'bad' });
  const raw = '\uFEFF' + bad;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_invalid');
});

test('fenced block with json info accepts', () => {
  const raw = `Here is report:\n\`\`\`json\n${VALID}\n\`\`\`\n`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'fenced');
  assert.equal(result.extraction.payload, VALID);
  ensureSubstring(raw, result.extraction.payload);
});

test('fenced block with bare fence (no info) accepts', () => {
  const raw = `\`\`\`\n${VALID}\n\`\`\`\n`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'fenced');
  ensureSubstring(raw, result.extraction.payload);
});

test('fenced block with tilde fence and CRLF preserves substring', () => {
  const raw = `Intro\r\n~~~json\r\n${VALID}\r\n~~~\r\nOutro`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'fenced');
  // payload should be substring of raw, even with CRLF
  ensureSubstring(raw, result.extraction.payload);
  assert.ok(result.extraction.payload.includes(VALID));
});

test('fenced CRLF multi-line preserves interior CR', () => {
  const pretty = JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'approve' }, null, 2);
  // pretty has \n; convert to CRLF
  const prettyCRLF = pretty.replace(/\n/g, '\r\n');
  const raw = `\`\`\`json\r\n${prettyCRLF}\r\n\`\`\``;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'fenced');
  ensureSubstring(raw, result.extraction.payload);
  // payload should still parse and validate
  assert.ok(JSON.parse(result.extraction.payload));
});

test('fenced block with ineligible info string is non-decisive', () => {
  const raw = `\`\`\`yaml\n${VALID}\n\`\`\`\n`;
  const result = extractSchemaEnvelope(raw, validate);
  // no fenced candidate, falls to embedded (which may find it)
  // With yaml fence, tier2 non-decisive, tier3 may still find embedded JSON
  // The raw contains the JSON object as embedded; it should be found as embedded
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'embedded');
});

test('two distinct valid fenced blocks -> ambiguous', () => {
  const raw = `\`\`\`json\n${VALID}\n\`\`\`\nSome text\n\`\`\`json\n${VALID2}\n\`\`\``;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
});

test('two byte-identical fenced blocks deduplicate to accept', () => {
  const raw = `\`\`\`json\n${VALID}\n\`\`\`\nAgain\n\`\`\`json\n${VALID}\n\`\`\``;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'fenced');
  assert.equal(result.extraction.candidates, 2);
});

test('fenced candidate that parses but fails schema -> schema_invalid and does not fall through to embedded', () => {
  const bad = JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'bad' });
  const raw = `\`\`\`json\n${bad}\n\`\`\`\nProse with ${VALID} embedded`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_invalid');
});

test('unclosed fence is non-decisive, falls to embedded', () => {
  // Exercise the closeIdx === -1 branch: opening fence with no matching close
  // must not be decisive, allowing the embedded tier to find a single valid JSON.
  const raw = `Intro\n\`\`\`json\nnot closed and no matching close\nAnd prose ${VALID} end`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true, `unclosed fence should fall through, got ${JSON.stringify(result)}`);
  assert.equal(result.extraction.kind, 'embedded');
  assert.equal(result.extraction.payload, VALID);
  ensureSubstring(raw, result.extraction.payload);
  // Ensure the scanner advanced correctly past the unclosed fence rather than
  // treating the whole tail as unbalanced.
  const rawTruncated = `Start\n\`\`\`json\n${VALID}`;
  const truncated = extractSchemaEnvelope(rawTruncated, validate);
  // rawTruncated has an opening fence without close and a valid JSON inside the
  // would-be body, but since fence is unclosed the tier is non-decisive and the
  // embedded scanner finds the JSON. It must not return ambiguous/unbalanced.
  assert.equal(truncated.ok, true);
  assert.equal(truncated.extraction.kind, 'embedded');
});

test('embedded tier finds single object in prose', () => {
  const raw = `Here is the report: ${VALID} thanks`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'embedded');
  ensureSubstring(raw, result.extraction.payload);
});

test('embedded tier accepts array', () => {
  const arr = JSON.stringify([{ reviewer: 'a', summary: 's', issues: [], verdict: 'approve' }]);
  const raw = `Result: ${arr} end`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'embedded');
  ensureSubstring(raw, result.extraction.payload);
});

test('embedded two distinct valid spans -> ambiguous', () => {
  const raw = `${VALID} and also ${VALID2}`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
});

test('embedded duplicate identical spans dedupe', () => {
  const raw = `${VALID} again ${VALID}`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.candidates, 2);
});

test('embedded ignores JSON inside string literals', () => {
  const outer = JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'approve' });
  // outer is valid; inner string that looks like JSON should not be extracted as candidate
  const raw = `Report ${outer} plus string " {"verdict":"approve"} " not counted`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'embedded');
  assert.equal(result.extraction.payload, outer);
});

test('embedded truncated JSON -> unbalanced', () => {
  const raw = `Start {"reviewer": "r", "summary": "s", "issues": [`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unbalanced');
});

test('embedded scalar not counted (needs object/array)', () => {
  const raw = `Answer is "42" and 123`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, false);
  // scalar 42 is not object/array, so no parsing candidate -> no_candidate
  assert.equal(result.reason, 'no_candidate');
});

test('fenced payload is not re-serialized and remains raw substring', () => {
  // Ensure ordering and whitespace preserved
  const ordered = `{"verdict":"approve","reviewer":"r","summary":"s","issues":[]}`;
  const raw = `\`\`\`json\n${ordered}\n\`\`\``;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.payload, ordered);
  ensureSubstring(raw, result.extraction.payload);
});

test('embedded reports schema_invalid with errors for unique parsing candidate failing schema', () => {
  const bad = JSON.stringify({ reviewer: 'r', summary: 's', issues: "not-array", verdict: 'approve' });
  const raw = `Report ${bad} end`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'schema_invalid');
  assert.ok(result.errors && result.errors.length > 0);
});

test('tier precedence: fenced decisive blocks embedded even if embedded also valid', () => {
  const raw = `\`\`\`json\n${VALID}\n\`\`\`\n And embedded ${VALID2} later`;
  const result = extractSchemaEnvelope(raw, validate);
  assert.equal(result.ok, true);
  assert.equal(result.extraction.kind, 'fenced');
  assert.equal(result.extraction.payload, VALID);
});

test('decisive tier with one valid and one invalid candidate must fail closed into repair (no guessing)', () => {
  const bad = JSON.stringify({ reviewer: 'r', summary: 's', issues: [], verdict: 'bad' });
  // Fenced tier: one valid, one schema-invalid -> must be schema_invalid, not success
  const fencedMixed = `\`\`\`json\n${VALID}\n\`\`\`\n\`\`\`json\n${bad}\n\`\`\``;
  const fencedResult = extractSchemaEnvelope(fencedMixed, validate);
  assert.equal(fencedResult.ok, false, 'mixed fenced tier should not extract the valid payload');
  assert.equal(fencedResult.reason, 'schema_invalid');
  assert.ok(fencedResult.errors && fencedResult.errors.length > 0, 'must supply Ajv errors for repair');

  // Embedded tier: one valid, one schema-invalid -> same fail-closed
  const embeddedMixed = `Report ${VALID} and also ${bad} end`;
  const embeddedResult = extractSchemaEnvelope(embeddedMixed, validate);
  assert.equal(embeddedResult.ok, false, 'mixed embedded tier should not extract the valid payload');
  assert.equal(embeddedResult.reason, 'schema_invalid');
  assert.ok(embeddedResult.errors && embeddedResult.errors.length > 0);

  // Ensure byte-identical duplicate of valid + invalid still fails (dedupe does not rescue)
  const duplicateValidMixed = `\`\`\`json\n${VALID}\n\`\`\`\n\`\`\`json\n${VALID}\n\`\`\`\n\`\`\`json\n${bad}\n\`\`\``;
  const dupResult = extractSchemaEnvelope(duplicateValidMixed, validate);
  assert.equal(dupResult.ok, false);
  assert.equal(dupResult.reason, 'schema_invalid');
});
