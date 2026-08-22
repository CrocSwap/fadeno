#!/usr/bin/env node
/**
 * Tamper matrix — the pre-schema-freeze adversarial pass over real run traces.
 *
 * `docs/experimental/next-protocol.md` requires that for each dogfood run we
 * verify the happy trace AND eight named tampered fixtures, and says plainly:
 * do not freeze schemas until `verify` catches every consequential
 * inconsistency. A happy trace verifying clean proves nothing about that — it
 * only proves the checks do not fire on honest input.
 *
 * So this takes real, completed run directories, makes one targeted mutation
 * per fixture on a COPY, and asserts that `fadeno verify` fails and that the
 * check which should have caught it is among the failures. A tamper that
 * verifies clean is reported as UNCAUGHT rather than quietly passing — that is
 * the outcome worth knowing about, and the reason this is a script you can
 * re-run rather than a paragraph in a commit message.
 *
 * Usage:
 *   node scripts/tamper-matrix.mjs <run-dir> [<run-dir> ...]
 *   node scripts/tamper-matrix.mjs --json <run-dir>
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'src', 'cli.ts');

// ---------------------------------------------------------------- helpers

const readEvents = (dir) =>
  readFileSync(join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

const writeEvents = (dir, events) =>
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

/**
 * Mutate one event matching `pick`; returns false when the run has none.
 *
 * Command dispatches are preferred over host ones. A host dispatch carries its
 * own request/start/receipt lifecycle, and those checks are strict enough to
 * catch a mutated executor or attempt first — which would leave
 * `executor-bindings` and `actor-attempts`, the checks these fixtures exist to
 * test, unexercised. Falls back to whatever the run has.
 */
function mutateEvent(dir, pick, mutate) {
  const events = readEvents(dir);
  const isHost = (e) => typeof e.dispatch_id === 'string' && e.dispatch_id.startsWith('hd-');
  let at = events.findIndex((e) => pick(e) && !isHost(e));
  if (at === -1) at = events.findIndex(pick);
  if (at === -1) return false;
  mutate(events[at], events, at);
  writeEvents(dir, events);
  return true;
}

/**
 * Paths that a completion receipt claims as its output. Four receipts since
 * rc.61: the executor delivered it, the kernel ran the tool, the host recorded
 * the tool's result by hand, the engine reduced a map's parts into it.
 */
const RECEIPT_TYPES = new Set(['actor_completed', 'tool_completed', 'tool_recorded', 'collective_assembled']);
function receiptedOutputs(events) {
  return new Set(
    events
      .filter((e) => RECEIPT_TYPES.has(e.type))
      .map((e) => e.output)
      .filter((o) => typeof o === 'string' && o !== ''),
  );
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Replace an artifact's bytes AND fix every digest the ledger holds for it. */
function forgeArtifact(dir, events, rel, bytes) {
  writeFileSync(join(dir, rel), bytes);
  for (const e of events) {
    if (e.type === 'artifact_created' && e.artifact === rel) {
      e.sha256 = sha256(bytes);
      e.bytes = Buffer.byteLength(bytes);
    }
    if (RECEIPT_TYPES.has(e.type) && e.output === rel && typeof e.output_sha256 === 'string') {
      e.output_sha256 = sha256(bytes);
      if (typeof e.output_bytes === 'number') e.output_bytes = Buffer.byteLength(bytes);
    }
  }
}

/**
 * An artifact that exists on disk.
 *
 * Preference order matters: an artifact a RECEIPT claims, produced by a COMMAND
 * delivery, is the case the checks are meant to cover. An artifact no receipt
 * claims is a weaker trace — see the `unreceipted-artifact-renamed` fixture,
 * which targets exactly that case on purpose — and picking one by accident
 * would make a fixture look like it failed when it simply had nothing to
 * anchor on.
 */
function pickArtifact(dir, { receipted = true } = {}) {
  const events = readEvents(dir);
  const outputs = receiptedOutputs(events);
  const usable = (e) =>
    e.type === 'artifact_created' &&
    typeof e.artifact === 'string' &&
    existsSync(join(dir, e.artifact)) &&
    outputs.has(e.artifact) === receipted;
  const isHost = (e) => typeof e.dispatch_id === 'string' && e.dispatch_id.startsWith('hd-');
  return events.find((e) => usable(e) && !isHost(e)) ?? events.find(usable) ?? null;
}

// ---------------------------------------------------------------- fixtures
//
// `expect` names the check that SHOULD catch the mutation. Any one of the
// listed ids failing counts as caught: several mutations are visible to more
// than one check and which one fires first is not the property under test.

const FIXTURES = [
  {
    id: 'artifact-bytes-changed',
    what: 'artifact bytes changed without updating its manifest digest',
    expect: ['artifact-digests'],
    apply(dir) {
      const created = pickArtifact(dir);
      if (!created) return null;
      const path = join(dir, created.artifact);
      // A single trailing space: decision-irrelevant by any human reading, and
      // exactly the edit a digest check exists to refuse.
      writeFileSync(path, readFileSync(path, 'utf8') + ' ');
      return `appended one space to ${created.artifact}`;
    },
  },
  {
    id: 'artifact-deleted',
    what: 'an artifact file deleted while its manifest still claims it',
    expect: ['artifacts-exist'],
    apply(dir) {
      const created = pickArtifact(dir);
      if (!created) return null;
      unlinkSync(join(dir, created.artifact));
      return `deleted ${created.artifact}`;
    },
  },
  {
    id: 'event-deleted',
    what: 'an event removed from the middle of the ledger',
    expect: ['events-seq'],
    apply(dir) {
      const events = readEvents(dir);
      if (events.length < 4) return null;
      const at = Math.floor(events.length / 2);
      const [dropped] = events.splice(at, 1);
      writeEvents(dir, events);
      return `dropped seq ${dropped.seq} (${dropped.type})`;
    },
  },
  {
    id: 'gate-result-changed',
    what: 'a recorded gate result flipped away from what its artifact says',
    expect: ['gate-coherence'],
    apply(dir) {
      let note = null;
      const ok = mutateEvent(
        dir,
        (e) => e.type === 'gate_evaluated' && (e.result === 'pass' || e.result === 'fail'),
        (e) => {
          const from = e.result;
          e.result = from === 'pass' ? 'fail' : 'pass';
          note = `gate ${e.condition}: recorded ${from} → ${e.result}`;
        },
      );
      return ok ? note : null;
    },
    // The failing check is named per-condition (`gate-tests_pass`), so accept
    // any id that starts with `gate-`.
    matches: (failed) => failed.some((id) => id.startsWith('gate-')),
  },
  {
    id: 'conflicting-decision',
    what: 'a second, conflicting resolution appended for one decision',
    expect: ['named-decisions'],
    apply(dir) {
      const events = readEvents(dir);
      const resolved = events.find((e) => e.type === 'decision_resolved');
      if (!resolved) return null;
      const last = events[events.length - 1];
      const other = resolved.option === 'approve' ? 'reject' : 'approve';
      events.push({
        ...resolved,
        option: other,
        seq: (last.seq ?? events.length) + 1,
        feedback: 'appended by tamper-matrix',
      });
      writeEvents(dir, events);
      return `${resolved.decision_id}: added a second resolution "${other}" beside "${resolved.option}"`;
    },
  },
  {
    id: 'binding-without-evidence',
    what: 'a dispatch re-attributed to another executor with no override event',
    expect: ['executor-bindings'],
    apply(dir) {
      let note = null;
      const ok = mutateEvent(
        dir,
        (e) => e.type === 'actor_dispatched' && typeof e.executor === 'string',
        (e) => {
          const from = e.executor;
          e.executor = `${from}-impostor`;
          note = `${e.dispatch_id ?? e.actor_call_id}: executor ${from} → ${e.executor}, no executor_override event added`;
        },
      );
      return ok ? note : null;
    },
  },
  {
    id: 'attempt-without-reason',
    what: 'an attempt ordinal incremented with no reason for the new attempt',
    expect: ['actor-attempts'],
    apply(dir) {
      let note = null;
      const ok = mutateEvent(
        dir,
        (e) => e.type === 'actor_dispatched' && e.attempt === 1,
        (e) => {
          e.attempt = 2;
          delete e.attempt_reason;
          note = `${e.dispatch_id ?? e.actor_call_id}: attempt 1 → 2, attempt_reason removed`;
        },
      );
      return ok ? note : null;
    },
  },
  {
    id: 'conflict-round-relabelled',
    what: 'a merge_conflict round whose prior failure no longer says merge_conflict',
    expect: ['merge-conflict-rounds'],
    apply(dir) {
      let note = null;
      const ok = mutateEvent(
        dir,
        (e) => e.type === 'actor_failed' && e.reason === 'merge_conflict',
        (e) => {
          e.reason = 'exit_nonzero';
          note = `${e.actor_call_id} attempt ${e.attempt}: actor_failed reason merge_conflict → exit_nonzero`;
        },
      );
      return ok ? note : null;
    },
  },
  {
    id: 'terminal-projection-disagrees',
    what: 'run.yaml projects a status the events do not support',
    expect: ['terminal-status', 'terminal-events'],
    apply(dir) {
      const path = join(dir, 'run.yaml');
      const raw = readFileSync(path, 'utf8');
      if (!/^status:\s*completed\s*$/m.test(raw)) return null;
      writeFileSync(path, raw.replace(/^status:\s*completed\s*$/m, 'status: failed'));
      return 'run.yaml status: completed → failed, run_completed event untouched';
    },
  },
  {
    id: 'legacy-event-name',
    what: 'a pre-0.3 event name inside a current-format ledger',
    expect: ['event-vocabulary'],
    apply(dir) {
      let note = null;
      const ok = mutateEvent(
        dir,
        (e) => e.type === 'artifact_created',
        (e) => {
          e.type = 'artifact_written';
          note = `${e.artifact}: artifact_created → artifact_written (the pre-0.3 spelling) in a 0.3 ledger`;
        },
      );
      return ok ? note : null;
    },
  },
  {
    id: 'unknown-event-name',
    what: 'an event renamed to a name in no vocabulary at all',
    // The generalization of the fixture above, and the reason it needed a
    // separate answer: `event-vocabulary` can only refuse names it knows, and
    // a name nothing recognizes was silently dropped from every artifact check
    // while the receipt still claimed the delivery. Caught now by anchoring on
    // the receipt (`receipt-output-manifests`) rather than on any list of names.
    expect: ['receipt-output-manifests'],
    apply(dir) {
      const target = pickArtifact(dir, { receipted: true });
      if (!target) return null;
      const events = readEvents(dir);
      const at = events.findIndex((e) => e.type === 'artifact_created' && e.artifact === target.artifact);
      events[at].type = 'artifact_kreated';
      writeEvents(dir, events);
      return `${target.artifact}: artifact_created → artifact_kreated (a name no reader knows)`;
    },
  },
  {
    id: 'unreceipted-artifact-renamed',
    what: 'the same rename, on an artifact no completion receipt claims',
    // Was a KNOWN GAP until rc.61. Two classes of artifact carried no
    // completion receipt, so nothing anchored them and either could be renamed
    // out of the audit: a tool result recorded by hand with
    // `fadeno tool-complete` (only `artifact_created`), and an engine-assembled
    // collective — the artifact a gate reads. Both are receipted now
    // (`tool_recorded`, `collective_assembled`), and on a trace written since,
    // this fixture finds nothing to mutate: that "n/a" is the closure, measured.
    // A trace that still carries an unreceipted artifact is a trace whose
    // writer predates the receipts; verify refuses it outright
    // (`collective-provenance` / `tool-artifact-receipts`), so the baseline
    // guard in the runner reports it before any fixture runs.
    expect: ['receipt-output-manifests'],
    apply(dir) {
      const target = pickArtifact(dir, { receipted: false });
      if (!target) return { na: 'every artifact on this trace is claimed by a receipt' };
      const events = readEvents(dir);
      const at = events.findIndex((e) => e.type === 'artifact_created' && e.artifact === target.artifact);
      events[at].type = 'artifact_kreated';
      writeEvents(dir, events);
      return `${target.artifact} (no receipt claims it): artifact_created → artifact_kreated`;
    },
  },
  {
    id: 'collective-renamed',
    what: 'the manifest of an assembled collective renamed out of the vocabulary',
    // The receipt is what anchors the collective: whatever the manifest event
    // is called, the output the receipt claims must be manifested.
    expect: ['receipt-output-manifests'],
    apply(dir) {
      const events = readEvents(dir);
      const receipt = events.find((e) => e.type === 'collective_assembled');
      if (!receipt) return null;
      const at = events.findIndex((e) => e.type === 'artifact_created' && e.artifact === receipt.output);
      if (at === -1) return null;
      events[at].type = 'artifact_kreated';
      writeEvents(dir, events);
      return `${receipt.output}: artifact_created → artifact_kreated`;
    },
  },
  {
    id: 'collective-receipt-dropped',
    what: 'the collective_assembled receipt deleted, leaving the pre-rc.61 shape',
    // Deleting the receipt must not be a way back to the unanchored state:
    // presence is checked from the playbook snapshot, so a collective on a map
    // step with no receipt is refused.
    expect: ['collective-provenance'],
    apply(dir) {
      const events = readEvents(dir);
      const at = events.findIndex((e) => e.type === 'collective_assembled');
      if (at === -1) return null;
      const [receipt] = events.splice(at, 1);
      writeEvents(dir, events);
      return `removed the collective_assembled receipt for ${receipt.output}`;
    },
  },
  {
    id: 'collective-forged',
    what: 'a collective rewritten with one part dropped, every digest fixed to match',
    // The sharpest one. The bytes, the manifest digest, and the receipt digest
    // all agree with each other after this — only the reduction from the
    // receipted parts disagrees, which is the thing a gate's input needs to be
    // held to. `artifact-digests` cannot see it; `collective-provenance` can.
    expect: ['collective-provenance'],
    apply(dir) {
      const events = readEvents(dir);
      const receipt = events.find((e) => e.type === 'collective_assembled');
      if (!receipt || !Array.isArray(receipt.parts) || receipt.parts.length === 0) return null;
      if (!existsSync(join(dir, receipt.output))) return null;
      let parts;
      try { parts = JSON.parse(readFileSync(join(dir, receipt.output), 'utf8')); } catch { return null; }
      if (!Array.isArray(parts) || parts.length === 0) return null;
      const forged = `${JSON.stringify(parts.slice(0, -1), null, 2)}\n`;
      forgeArtifact(dir, events, receipt.output, forged);
      writeEvents(dir, events);
      return `${receipt.output}: dropped the last of ${parts.length} part(s); manifest and receipt digests updated to match`;
    },
  },
  {
    id: 'recorded-tool-renamed',
    what: 'the manifest of a host-recorded tool result renamed out of the vocabulary',
    expect: ['receipt-output-manifests'],
    apply(dir) {
      const events = readEvents(dir);
      const receipt = events.find((e) => e.type === 'tool_recorded');
      if (!receipt) return null;
      const at = events.findIndex((e) => e.type === 'artifact_created' && e.artifact === receipt.output);
      if (at === -1) return null;
      events[at].type = 'artifact_kreated';
      writeEvents(dir, events);
      return `${receipt.output}: artifact_created → artifact_kreated`;
    },
  },
  {
    id: 'recorded-tool-receipt-dropped',
    what: 'the tool_recorded receipt deleted, leaving the pre-rc.61 shape',
    expect: ['tool-artifact-receipts'],
    apply(dir) {
      const events = readEvents(dir);
      const at = events.findIndex((e) => e.type === 'tool_recorded');
      if (at === -1) return null;
      const [receipt] = events.splice(at, 1);
      writeEvents(dir, events);
      return `removed the tool_recorded receipt for ${receipt.output}`;
    },
  },
  {
    id: 'recorded-tool-forged',
    what: 'a host-recorded tool result rewritten with its manifest digest fixed, receipt left alone',
    // The manifest can be made to agree with forged bytes; the receipt the host
    // signed when it recorded the result still names the original digest.
    expect: ['tool-artifact-receipts'],
    apply(dir) {
      const events = readEvents(dir);
      const receipt = events.find((e) => e.type === 'tool_recorded');
      if (!receipt || !existsSync(join(dir, receipt.output))) return null;
      const forged = readFileSync(join(dir, receipt.output), 'utf8') + ' ';
      writeFileSync(join(dir, receipt.output), forged);
      for (const e of events) {
        if (e.type === 'artifact_created' && e.artifact === receipt.output) { e.sha256 = sha256(forged); e.bytes = Buffer.byteLength(forged); }
      }
      writeEvents(dir, events);
      return `${receipt.output}: appended one space, manifest digest updated, receipt untouched`;
    },
  },
  {
    id: 'invalid-output-escape-hatch',
    what: 'a delivered receipt marked output_valid: false to excuse a missing manifest',
    expect: ['receipt-output-manifests'],
    apply(dir) {
      const events = readEvents(dir);
      const at = events.findIndex(
        (e) => e.type === 'actor_completed' && e.output_valid === true && typeof e.actor_call_id === 'string',
      );
      if (at === -1) return null;
      const receipt = events[at];
      // Claim the delivery failed validation AND remove the manifest, which is
      // what the claim would look like if it were true. Only honest if a later
      // attempt supersedes it — and none does.
      receipt.output_valid = false;
      const artifactAt = events.findIndex((e) => e.type === 'artifact_created' && e.artifact === receipt.output);
      if (artifactAt !== -1) events[artifactAt].type = 'artifact_kreated';
      writeEvents(dir, events);
      return `${receipt.actor_call_id}: output_valid true → false with no repair attempt, manifest removed`;
    },
  },
  {
    id: 'unversioned-without-legacy',
    what: 'an unversioned ledger read without --legacy',
    expect: [],
    expectRefusal: true,
    apply(dir) {
      const path = join(dir, 'run.yaml');
      const raw = readFileSync(path, 'utf8');
      if (!/^schema_version:/m.test(raw)) return null;
      writeFileSync(path, raw.replace(/^schema_version:.*$/m, '').replace(/\n{3,}/g, '\n\n'));
      return 'removed schema_version from run.yaml';
    },
  },
];

// ---------------------------------------------------------------- runner

function verify(root, runId) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, 'verify', runId], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const failedChecks = (out) =>
  out
    .split('\n')
    .map((line) => /^\s*(FAIL|fail)\s+(\S+)/.exec(line))
    .filter(Boolean)
    .map((m) => m[2]);

function runFixture(sourceDir, runId, fixture) {
  const root = mkdtempSync(join(tmpdir(), 'fadeno-tamper-'));
  try {
    const dest = join(root, '.fadeno', 'runs', runId);
    cpSync(sourceDir, dest, { recursive: true });
    const applied = fixture.apply(dest);
    if (applied == null) return { status: 'n/a', note: 'run carries no material for this fixture' };
    if (typeof applied === 'object') return { status: 'n/a', note: applied.na };
    const note = applied;

    const { code, out } = verify(root, runId);
    const failed = failedChecks(out);

    if (fixture.expectRefusal) {
      const refused = code !== 0 && failed.length === 0 && /--legacy|compatibility mode/i.test(out);
      return refused
        ? { status: 'caught', note, by: 'refused to read the ledger at all' }
        : { status: code === 0 ? 'UNCAUGHT' : 'caught', note, by: refused ? '' : failed.join(', ') || 'non-zero exit' };
    }

    if (code === 0) return { status: 'UNCAUGHT', note, by: 'verify reported no failures' };

    const matched = fixture.matches ? fixture.matches(failed) : failed.some((id) => fixture.expect.includes(id));
    return matched
      ? { status: 'caught', note, by: failed.join(', ') }
      : { status: 'caught-elsewhere', note, by: failed.join(', ') };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- main

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const runDirs = args.filter((a) => !a.startsWith('--'));

if (runDirs.length === 0) {
  console.error('Usage: node scripts/tamper-matrix.mjs [--json] <run-dir> [<run-dir> ...]');
  process.exit(2);
}

const results = [];
let uncaught = 0;
let baselineFailures = 0;

function baselineVerify(sourceDir, runId) {
  const root = mkdtempSync(join(tmpdir(), 'fadeno-tamper-'));
  try {
    cpSync(sourceDir, join(root, '.fadeno', 'runs', runId), { recursive: true });
    const { code, out } = verify(root, runId);
    return { code, failed: failedChecks(out) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const dir of runDirs) {
  const runId = basename(dir);
  if (!existsSync(join(dir, 'events.jsonl'))) {
    console.error(`skip ${runId}: no events.jsonl`);
    continue;
  }
  if (!asJson) console.log(`\n=== ${runId} ===`);
  // A trace that fails verify untouched proves nothing tampered: every fixture
  // would be "caught" by a failure that was already there. Say so instead.
  const baseline = baselineVerify(dir, runId);
  if (baseline.code !== 0) {
    results.push({ run: runId, fixture: '(baseline)', status: 'BASELINE', note: `untampered trace fails verify: ${baseline.failed.join(', ') || 'non-zero exit'}` });
    baselineFailures += 1;
    if (!asJson) console.log(`  SKIP baseline                       untampered trace fails verify: ${baseline.failed.join(', ') || 'non-zero exit'} — fixtures not run`);
    continue;
  }
  for (const fixture of FIXTURES) {
    const res = runFixture(dir, runId, fixture);
    results.push({ run: runId, fixture: fixture.id, ...res });
    if (res.status === 'UNCAUGHT') uncaught += 1;
    if (!asJson) {
      const mark = { caught: 'ok  ', 'caught-elsewhere': 'ok? ', 'n/a': 'n/a ', UNCAUGHT: 'MISS' }[res.status];
      console.log(`  ${mark} ${fixture.id.padEnd(30)} ${res.note ?? ''}`);
      if (res.by) console.log(`       caught by: ${res.by}`);
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ uncaught, baselineFailures, results }, null, 2));
} else {
  const caught = results.filter((r) => r.status === 'caught').length;
  const elsewhere = results.filter((r) => r.status === 'caught-elsewhere').length;
  const na = results.filter((r) => r.status === 'n/a').length;
  const skipped = baselineFailures > 0 ? `, ${baselineFailures} trace(s) skipped because they fail verify untampered` : '';
  console.log(
    `\ntamper matrix: ${caught} caught by the expected check, ${elsewhere} caught by another check, ` +
      `${na} not applicable, ${uncaught} UNCAUGHT${skipped}`,
  );
}

process.exit(uncaught > 0 || baselineFailures > 0 ? 1 : 0);
