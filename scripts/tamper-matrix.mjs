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
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'dist', 'cli.js');

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

/** Paths that a completion receipt claims as its output. */
function receiptedOutputs(events) {
  return new Set(
    events
      .filter((e) => e.type === 'actor_completed' || e.type === 'tool_completed')
      .map((e) => e.output)
      .filter((o) => typeof o === 'string' && o !== ''),
  );
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
    // KNOWN GAP, and a structural one rather than a missing check. Two classes
    // of artifact carry no completion receipt at all, so there is nothing for
    // `receipt-output-manifests` to anchor on and either can be renamed out of
    // the audit:
    //
    //   1. A tool result recorded by hand with `fadeno tool-complete`, which
    //      emits ONLY artifact_created — no tool_dispatched, no tool_completed
    //      — so three tool checks skip as well. The manual path produces a
    //      materially weaker trace than `fadeno tool-run`.
    //   2. An engine-ASSEMBLED collective (`artifacts/parts/<step>.json`),
    //      built by reducing a map's member parts. Each member's own part is
    //      receipted; the collective the gate then reads is not.
    //
    // (2) is the sharper one: `gate no_blocking_issues` evaluates the
    // collective, so the artifact a gate depends on is the artifact with the
    // weakest provenance in the ledger.
    //
    // Closing either means emitting a receipt where none exists today, which
    // changes what a command writes — a call to make deliberately before the
    // schema freeze, not as a side effect of a fixture.
    knownGap: true,
    expect: ['receipt-output-manifests'],
    apply(dir) {
      const target = pickArtifact(dir, { receipted: false });
      if (!target) return null;
      const events = readEvents(dir);
      const at = events.findIndex((e) => e.type === 'artifact_created' && e.artifact === target.artifact);
      events[at].type = 'artifact_kreated';
      writeEvents(dir, events);
      return `${target.artifact} (no receipt claims it): artifact_created → artifact_kreated`;
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
    const note = fixture.apply(dest);
    if (note == null) return { status: 'n/a', note: 'run carries no material for this fixture' };

    const { code, out } = verify(root, runId);
    const failed = failedChecks(out);

    if (fixture.expectRefusal) {
      const refused = code !== 0 && failed.length === 0 && /--legacy|compatibility mode/i.test(out);
      return refused
        ? { status: 'caught', note, by: 'refused to read the ledger at all' }
        : { status: code === 0 ? 'UNCAUGHT' : 'caught', note, by: refused ? '' : failed.join(', ') || 'non-zero exit' };
    }

    if (code === 0) {
      return fixture.knownGap
        ? { status: 'gap', note, by: 'verify reported no failures (known, tracked above)' }
        : { status: 'UNCAUGHT', note, by: 'verify reported no failures' };
    }
    if (fixture.knownGap) {
      return { status: 'gap-closed', note, by: `${failed.join(', ')} — this fixture is marked knownGap; drop the marker` };
    }

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
if (!existsSync(CLI)) {
  console.error(`No build at ${CLI}. Run \`npm run build\` first.`);
  process.exit(2);
}

const results = [];
let uncaught = 0;

for (const dir of runDirs) {
  const runId = basename(dir);
  if (!existsSync(join(dir, 'events.jsonl'))) {
    console.error(`skip ${runId}: no events.jsonl`);
    continue;
  }
  if (!asJson) console.log(`\n=== ${runId} ===`);
  for (const fixture of FIXTURES) {
    const res = runFixture(dir, runId, fixture);
    results.push({ run: runId, fixture: fixture.id, ...res });
    if (res.status === 'UNCAUGHT') uncaught += 1;
    if (!asJson) {
      const mark = { caught: 'ok  ', 'caught-elsewhere': 'ok? ', 'n/a': 'n/a ', gap: 'GAP ', 'gap-closed': 'NEW ', UNCAUGHT: 'MISS' }[res.status];
      console.log(`  ${mark} ${fixture.id.padEnd(30)} ${res.note ?? ''}`);
      if (res.by) console.log(`       caught by: ${res.by}`);
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ uncaught, results }, null, 2));
} else {
  const caught = results.filter((r) => r.status === 'caught').length;
  const elsewhere = results.filter((r) => r.status === 'caught-elsewhere').length;
  const na = results.filter((r) => r.status === 'n/a').length;
  const gaps = results.filter((r) => r.status === 'gap').length;
  const closed = results.filter((r) => r.status === 'gap-closed').length;
  console.log(
    `\ntamper matrix: ${caught} caught by the expected check, ${elsewhere} caught by another check, ` +
      `${na} not applicable, ${gaps} known gap(s), ${closed} known gap(s) now closed, ${uncaught} UNCAUGHT`,
  );
}

process.exit(uncaught > 0 ? 1 : 0);
