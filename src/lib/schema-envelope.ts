/**
 * Pure, deterministic extraction of a schema-valid JSON payload from noisy
 * executor output. No filesystem, no clock — used by engine command path and
 * host dispatch path before any model schema_repair retry.
 */

export type EnvelopeKind = 'bom_trimmed' | 'fenced' | 'embedded';

export interface EnvelopeExtraction {
  kind: EnvelopeKind;
  /** Exact contiguous substring of the decoded raw text. Never re-serialized. */
  payload: string;
  /** Parse-successful candidates at the decisive tier, after byte-identical dedupe. */
  candidates: number;
}

export type EnvelopeResult =
  | { ok: true; extraction: EnvelopeExtraction; parsed: unknown }
  | { ok: false; reason: 'no_candidate' | 'ambiguous' | 'schema_invalid' | 'unbalanced'; errors?: string[] };

function ajvErrorMessages(validate: (parsed: unknown) => boolean): string[] {
  const maybe = validate as unknown as { errors?: Array<{ message?: string }> | null };
  if (maybe.errors && Array.isArray(maybe.errors) && maybe.errors.length > 0) {
    return maybe.errors.map((e) => {
      const err = e as unknown as Record<string, unknown>;
      const msg = typeof err.message === 'string' ? err.message : String(err.message ?? '');
      const instancePath = typeof err.instancePath === 'string' ? err.instancePath : '';
      const schemaPath = typeof err.schemaPath === 'string' ? err.schemaPath : '';
      if (instancePath) return `${instancePath} ${msg}`.trim();
      if (schemaPath) return `${msg} (${schemaPath})`;
      return msg;
    });
  }
  return [];
}

function dedupe(payloads: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of payloads) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function tryParseObjectOrArray(text: string): unknown | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const first = trimmed[0];
  if (first !== '{' && first !== '[') return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract a schema-valid envelope from raw executor output.
 *
 * Precondition (caller-enforced): whole-text JSON.parse failed and a schema
 * validator is available. This function itself does not check that precondition;
 * callers must gate on it. Whole text that parses but fails schema is semantic
 * invalidity and must not reach this function.
 */
export function extractSchemaEnvelope(
  raw: string,
  validate: (parsed: unknown) => boolean,
): EnvelopeResult {
  // Tier 1: BOM + whitespace
  const bomResult = tryBomTier(raw, validate);
  if (bomResult !== null) return bomResult;

  // Tier 2: Fenced blocks
  const fencedResult = tryFencedTier(raw, validate);
  if (fencedResult !== null) return fencedResult;

  // Tier 3: Embedded balanced spans (only if tier 2 had no parsing candidate)
  return tryEmbeddedTier(raw, validate);
}

function tryBomTier(
  raw: string,
  validate: (parsed: unknown) => boolean,
): EnvelopeResult | null {
  if (raw.length === 0 || raw.charCodeAt(0) !== 0xfeff) return null;
  // Strip exactly one leading BOM and surrounding whitespace per spec.
  const trimmed = raw.slice(1).trim();
  if (trimmed.length === 0) return null;
  const parsed = tryParseObjectOrArray(trimmed);
  if (parsed === null) return null;
  // This tier is decisive (had a parsing candidate)
  if (validate(parsed)) {
    return { ok: true, extraction: { kind: 'bom_trimmed', payload: trimmed, candidates: 1 }, parsed };
  }
  const errors = ajvErrorMessages(validate);
  return { ok: false, reason: 'schema_invalid', errors: errors.length > 0 ? errors : undefined };
}

function selectUniqueValidCandidate(
  payloads: string[],
  validate: (parsed: unknown) => boolean,
): { validating: Array<{ payload: string; parsed: unknown }>; schemaErrors?: string[]; uniqueCount: number; invalidCount: number } {
  const unique = dedupe(payloads);
  const validating: Array<{ payload: string; parsed: unknown }> = [];
  let schemaErrors: string[] | undefined;
  let invalidCount = 0;
  for (const candidate of unique) {
    const parsed = tryParseObjectOrArray(candidate);
    if (parsed === null) continue;
    if (validate(parsed)) {
      validating.push({ payload: candidate, parsed });
    } else {
      invalidCount += 1;
      if (schemaErrors == null) {
        const errs = ajvErrorMessages(validate);
        if (errs.length > 0) schemaErrors = errs;
      }
    }
  }
  return { validating, schemaErrors, uniqueCount: unique.length, invalidCount };
}

function tryFencedTier(
  raw: string,
  validate: (parsed: unknown) => boolean,
): EnvelopeResult | null {
  const lines = raw.split('\n');
  const parsingCandidates: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.replace(/\r$/, '').trim();
    const fenceMatch = trimmed.match(/^([`~]{3,})(.*)$/);
    if (!fenceMatch) {
      i += 1;
      continue;
    }
    const marker = fenceMatch[1]!;
    const info = fenceMatch[2]!.trim();
    const markerChar = marker[0]!;
    const markerLen = marker.length;
    const eligible = info === '' || info.toLowerCase() === 'json';
    let closeIdx = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const closeTrimmed = lines[j]!.replace(/\r$/, '').trim();
      if (
        closeTrimmed.length >= markerLen &&
        closeTrimmed[0] === markerChar &&
        /^([`~]+)$/.test(closeTrimmed) &&
        closeTrimmed.split('').every((c) => c === markerChar)
      ) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx === -1) {
      i += 1;
      continue;
    }
    if (!eligible) {
      i = closeIdx + 1;
      continue;
    }
    const bodyLines = lines.slice(i + 1, closeIdx);
    const body = bodyLines.join('\n').trim();
    if (body.length === 0) {
      i = closeIdx + 1;
      continue;
    }
    const parsed = tryParseObjectOrArray(body);
    if (parsed !== null) {
      parsingCandidates.push(body);
    }
    i = closeIdx + 1;
  }

  if (parsingCandidates.length === 0) return null;

  const { validating, schemaErrors, invalidCount } = selectUniqueValidCandidate(parsingCandidates, validate);
  if (validating.length === 0) return { ok: false, reason: 'schema_invalid', errors: schemaErrors };
  if (validating.length > 1) return { ok: false, reason: 'ambiguous' };
  // Frozen no-guessing contract: a decisive tier that contains both a
  // schema-valid and a schema-invalid parsing candidate must fail closed
  // into model repair rather than choosing the valid payload.
  if (invalidCount > 0) return { ok: false, reason: 'schema_invalid', errors: schemaErrors };
  const winner = validating[0]!;
  return { ok: true, extraction: { kind: 'fenced', payload: winner.payload, candidates: parsingCandidates.length }, parsed: winner.parsed };
}

function tryEmbeddedTier(
  raw: string,
  validate: (parsed: unknown) => boolean,
): EnvelopeResult {
  const candidates: string[] = [];
  let inString = false;
  let escapeNext = false;
  let depth = 0;
  let startIdx = -1;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;

    if (inString) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{' || ch === '[') {
      if (depth === 0) {
        startIdx = i;
        depth = 1;
      } else {
        depth += 1;
      }
      continue;
    }

    if (ch === '}' || ch === ']') {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && startIdx !== -1) {
        const span = raw.slice(startIdx, i + 1);
        candidates.push(span);
        startIdx = -1;
      }
    }
  }

  if (depth !== 0) {
    return { ok: false, reason: 'unbalanced' };
  }

  if (candidates.length === 0) return { ok: false, reason: 'no_candidate' };

  const parsingCandidates: string[] = [];
  for (const span of candidates) {
    const parsed = tryParseObjectOrArray(span);
    if (parsed !== null) parsingCandidates.push(span);
  }

  if (parsingCandidates.length === 0) return { ok: false, reason: 'no_candidate' };

  const { validating, schemaErrors: schemaErrors2, invalidCount } = selectUniqueValidCandidate(parsingCandidates, validate);
  if (validating.length > 1) return { ok: false, reason: 'ambiguous' };
  if (validating.length === 0) return { ok: false, reason: 'schema_invalid', errors: schemaErrors2 };
  if (invalidCount > 0) return { ok: false, reason: 'schema_invalid', errors: schemaErrors2 };

  const winner = validating[0]!;
  return { ok: true, extraction: { kind: 'embedded', payload: winner.payload, candidates: parsingCandidates.length }, parsed: winner.parsed };
}
