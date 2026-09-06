/**
 * Everything Fadeno does with a process's own output streams, and every place
 * it admits it kept less than all of them.
 *
 * Two mechanisms live here and they are not the same mechanism, which is the
 * point of keeping them adjacent:
 *
 * - **Diagnostics** (contract 1.4) — opt-in only (`--diagnostics` or
 *   `FADENO_DIAGNOSTICS=1`), bounded to 32 KiB / 500 lines per stream,
 *   head+tail sampling with a single verbatim marker, machine-local only,
 *   never ledger-committed, never gating.
 * - **The executor transcript** — always on, the only copy of bytes that no
 *   longer reach the terminal, bounded far higher, and pointed at by a path
 *   rather than relayed. See the section below for why the two ceilings differ.
 */

export const DIAGNOSTICS_MAX_BYTES = 32 * 1024;
export const DIAGNOSTICS_MAX_LINES = 500;

export function diagnosticsTruncationMarker(stream: 'stdout' | 'stderr'): string {
  return `\n…[fadeno diagnostics truncated: ${stream} exceeded 32 KiB / 500 lines]…\n`;
}

export function truncateDiagnostics(text: string, stream: 'stdout' | 'stderr'): string {
  return sampleHeadTail(text, {
    maxBytes: DIAGNOSTICS_MAX_BYTES,
    maxLines: DIAGNOSTICS_MAX_LINES,
    marker: diagnosticsTruncationMarker(stream),
  });
}

/**
 * Head+tail sampling with a single verbatim marker between the halves.
 *
 * Extracted from `truncateDiagnostics` so the executor transcript and the
 * terminal excerpt below bound themselves with the same arithmetic. One
 * sampler means one place where "this is a sample" can be got wrong, and the
 * marker is a parameter precisely because a sample must name where the rest
 * of it went — which differs per caller.
 */
export function sampleHeadTail(
  text: string,
  opts: { maxBytes: number; maxLines: number; marker: string },
): string {
  const { maxBytes, maxLines, marker } = opts;
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

// ---------------------------------------------------------------------------
// The executor's own transcript: retained always, relayed never
// ---------------------------------------------------------------------------
//
// A dispatch used to write the executor's entire stderr to the terminal
// unbounded. A Codex director reported the cost on dispatch 782b7751: a 7 KB
// report arrived alongside ~127,000 output tokens of executor chatter, and for
// a host agent that lands in a context window and pushes out the thing it was
// asked for.
//
// The obvious fix — print less — is the one this line has already refused
// twice. 7c7a0f6 moved relay-fidelity findings off stderr because a finding
// nobody reads is not a finding; 828dbcf did the same for discarded output.
// So stderr is at once "lost when you need it" and "flooding when you do not",
// and a fix that only knows about one of those recreates the other.
//
// The two are reconciled by asking WHOSE bytes they are. Fadeno's own notices
// — relay fidelity, discarded output, concurrent writes, merge status — are
// decision-changing, small, and already travel either in-band on stdout or as
// discrete `onEcho` lines; none of them pass through the executor's stderr
// buffer, so bounding that buffer cannot reach them. What is left in it is a
// third party's diagnostic noise, which the kernel cannot classify and must
// not relay wholesale.
//
// So: the transcript is RETAINED to a path and the path is printed, the bytes
// are printed only when the caller has no working result to go on, and every
// sample says it is a sample and where the rest of it is.

/**
 * Ceiling on the retained stderr transcript.
 *
 * Deliberately not `DIAGNOSTICS_MAX_BYTES`, and the difference is a claim
 * about copies rather than taste. A `--diagnostics` snapshot samples streams
 * that ALSO reached the terminal, so 32 KiB costs nothing — the bytes it drops
 * were printed. The transcript exists because those bytes are no longer
 * printed, which makes it the only copy; sampling it at 32 KiB would destroy
 * evidence a caller had before this change and call that a fix. Retention is
 * justified by there being something to lose (b35643e), one layer down.
 *
 * Still bounded, because "only copy" is not "unbounded write": 4 MiB is about
 * eight times the largest transcript this line has produced (~127k output
 * tokens ≈ 0.5 MB) and a runaway executor cannot fill a disk one dispatch at a
 * time. When the ceiling does bite, the file says so in its own body and
 * `ExecutorTranscript.truncated` says so to every reader.
 */
export const TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
export const TRANSCRIPT_MAX_LINES = 100_000;

/**
 * What may reach the terminal inline, and only when the caller cannot act
 * without it. Sized against the failure it exists to prevent: ~1k tokens
 * worst case, against the ~127k tokens that started this.
 */
export const INLINE_STDERR_MAX_BYTES = 4 * 1024;
export const INLINE_STDERR_MAX_LINES = 40;

/** Where an executor's stderr went, and whether all of it got there. */
export interface ExecutorTranscript {
  /** Repo-relative path of the retained transcript; null when retention failed. */
  path: string | null;
  /** Bytes the executor wrote to stderr, before any sampling. */
  bytes: number;
  /** The retained file is a head+tail sample rather than the whole stream. */
  truncated: boolean;
  /** Why there is no path, when there is none. Null on success. */
  note: string | null;
}

/** Nothing was captured, so there is nothing to point at. */
export const NO_EXECUTOR_TRANSCRIPT: ExecutorTranscript = {
  path: null,
  bytes: 0,
  truncated: false,
  note: null,
};

export function transcriptTruncationMarker(): string {
  return (
    `\n…[fadeno transcript truncated: the executor's stderr exceeded ` +
    `${TRANSCRIPT_MAX_BYTES / (1024 * 1024)} MiB / ${TRANSCRIPT_MAX_LINES} lines; ` +
    `what follows the marker is the tail. This file is a head+tail sample — a floor, not the set]…\n`
  );
}

/** Bound a transcript for retention on disk. */
export function truncateTranscript(text: string): string {
  return sampleHeadTail(text, {
    maxBytes: TRANSCRIPT_MAX_BYTES,
    maxLines: TRANSCRIPT_MAX_LINES,
    marker: transcriptTruncationMarker(),
  });
}

/**
 * The one line that says an executor's stderr exists and where it is.
 *
 * Echoed on every dispatch that produced any, success included — it is the
 * substitute for the bytes, so it cannot be conditional on the outcome. Not
 * prefixed `dispatch: executor`, which `cli.ts` reserves for the failure
 * diagnosis a clean run must not print.
 */
export function executorTranscriptNotice(transcript: ExecutorTranscript): string | null {
  if (transcript.bytes === 0) return null;
  if (transcript.path == null) {
    return (
      `executor stderr: ${transcript.bytes} bytes could NOT be retained ` +
      `(${transcript.note ?? 'reason unrecorded'}); a bounded excerpt is all that survives this process.`
    );
  }
  return (
    `executor stderr: ${transcript.bytes} bytes → ${transcript.path}` +
    (transcript.truncated ? ' (a head+tail sample; a floor, not the set)' : '')
  );
}

/**
 * The terminal excerpt, for a caller with nothing else to go on.
 *
 * Returns null when there is nothing worth the space: a dispatch that worked
 * and whose transcript is safely on disk has already been told where it is.
 * Never returns silently-truncated bytes — the marker names the sample AND the
 * path, because a truncation that does not say where the rest went is the same
 * class of bug as everything else on this line.
 */
export function renderExecutorStderr(opts: {
  stderr: string;
  transcript: ExecutorTranscript;
  /**
   * The caller has no usable result, so the excerpt earns its space: a
   * non-zero exit, a signal, a spawn failure, or exit 0 with no report.
   */
  actionable: boolean;
}): string | null {
  const { stderr, transcript } = opts;
  if (stderr.length === 0) {
    // Said out loud rather than left blank. A failure diagnosis that points
    // "above" at nothing reads as output that scrolled away, and "it looked
    // and found nothing" must never render the same as "nobody looked".
    return opts.actionable ? 'executor stderr: none — the executor wrote nothing to stderr.\n' : null;
  }
  // It worked and the bytes are on disk: the notice line already said where.
  if (!opts.actionable && transcript.path != null) return null;

  const rest = transcript.path == null
    ? `retention FAILED (${transcript.note ?? 'reason unrecorded'}), so the rest of it is gone`
    : transcript.truncated
      ? `the transcript at ${transcript.path} holds a head+tail sample of all ${transcript.bytes} bytes — itself a floor, not the set`
      : `all ${transcript.bytes} bytes are at ${transcript.path}`;
  const marker = `\n…[fadeno excerpt: a head+tail sample of the executor's stderr, not the set — ${rest}]…\n`;
  const body = sampleHeadTail(stderr, {
    maxBytes: INLINE_STDERR_MAX_BYTES,
    maxLines: INLINE_STDERR_MAX_LINES,
    marker,
  });
  // A stream small enough to survive the sample verbatim is still not the
  // whole story a reader needs: say where the file is either way.
  const trailer = body.includes(marker) ? '' : `\n…[fadeno: ${rest}]…\n`;
  return `${body.endsWith('\n') ? body : `${body}\n`}${trailer}`;
}
