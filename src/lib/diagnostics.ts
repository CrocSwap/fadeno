/**
 * Bounded opt-in process output diagnostics helpers.
 *
 * Contract 1.4: opt-in only (`--diagnostics` or `FADENO_DIAGNOSTICS=1`), bounded to
 * 32 KiB / 500 lines per stream, head+tail sampling with a single verbatim marker,
 * machine-local only, never ledger-committed, never gating.
 */

export const DIAGNOSTICS_MAX_BYTES = 32 * 1024;
export const DIAGNOSTICS_MAX_LINES = 500;

export function diagnosticsTruncationMarker(stream: 'stdout' | 'stderr'): string {
  return `\n…[fadeno diagnostics truncated: ${stream} exceeded 32 KiB / 500 lines]…\n`;
}

export function truncateDiagnostics(text: string, stream: 'stdout' | 'stderr'): string {
  const maxBytes = DIAGNOSTICS_MAX_BYTES;
  const maxLines = DIAGNOSTICS_MAX_LINES;
  const marker = diagnosticsTruncationMarker(stream);
  const byteLen = Buffer.byteLength(text, 'utf8');
  const lines = text.split('\n');
  const lineCount = text === '' ? 0 : lines.length;
  if (byteLen <= maxBytes && lineCount <= maxLines) return text;

  // Reserve one rendered line for the marker. Selecting disjoint line ranges
  // first means the byte fallback cannot accidentally violate the line cap.
  // A one-line stream is split by bytes directly so both ends remain visible.
  const contentLineBudget = Math.min(lineCount, maxLines - 1);
  const headLineCount = lineCount === 1 ? 0 : Math.floor(contentLineBudget / 2);
  const tailLineCount = lineCount === 1 ? 0 : contentLineBudget - headLineCount;
  const headSource = lineCount === 1 ? text : lines.slice(0, headLineCount).join('\n');
  const tailSource = lineCount === 1 ? text : lines.slice(lineCount - tailLineCount).join('\n');
  const contentByteBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  const headBudget = Math.floor(contentByteBudget / 2);
  const tailBudget = contentByteBudget - headBudget;
  const head = utf8Prefix(headSource, headBudget);
  const tail = utf8Suffix(tailSource, tailBudget);
  return head + marker + tail;
}

function utf8Prefix(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function utf8Suffix(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString('utf8');
}

export function isDiagnosticsEnabled(opts: { diagnostics?: boolean | null }): boolean {
  if (opts.diagnostics === true) return true;
  return process.env.FADENO_DIAGNOSTICS === '1';
}
