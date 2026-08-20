import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { KNOWN_CLI_COMMANDS } from '../src/cli.ts';
import { knownFlagsFor, suggestFlag, unknownFlagsFor } from '../src/commands/completion.ts';

/**
 * A flag belonging to one command must not be silently accepted by another.
 *
 * `parseArgs` runs strict, so a flag no command declares is already rejected.
 * The gap was narrower and much quieter: its option table is GLOBAL, so
 * `--repo` — declared for `dial` — parsed cleanly under `fadeno doctor`, was
 * ignored, and left its path as a stray positional. `fadeno doctor --repo
 * <other-repo>` therefore reported on the CURRENT repository while appearing
 * to inspect another one, and printed a full healthy report either way.
 *
 * That is the worst shape a bug can take here: not a wrong answer, but a
 * wrong answer that looks right. It was caught only by noticing the paths in
 * the output named somewhere other than the argument.
 */

test('a flag from another command is rejected, not ignored', () => {
  // The exact invocation that silently misreported.
  assert.deepEqual(unknownFlagsFor('doctor', undefined, ['repo']), ['--repo']);
  // And the ones doctor really takes are untouched.
  assert.deepEqual(unknownFlagsFor('doctor', undefined, ['codex', 'claude', 'help']), []);
});

test('a subcommand contributes its own flags without losing the parent\'s', () => {
  // `steering resolve --archetype` is valid; `steering --help` still is too.
  assert.deepEqual(unknownFlagsFor('steering', 'resolve', ['archetype']), []);
  assert.deepEqual(unknownFlagsFor('steering', 'resolve', ['help']), []);
  // A flag belonging to a DIFFERENT subcommand is still caught.
  assert.deepEqual(unknownFlagsFor('doctor', 'resolve', ['archetype']), ['--archetype']);
});

test('an unknown command accepts everything rather than nothing', () => {
  // The registry forgetting a command must not reject every flag that command
  // takes — that would be a worse failure than the one this prevents.
  assert.equal(knownFlagsFor('not-a-command'), null);
  assert.deepEqual(unknownFlagsFor('not-a-command', undefined, ['anything']), []);
});

test('every CLI command is in the registry, so validation is never skipped', () => {
  // The fallback above is a safety net, not a licence. If a command ships
  // without an entry, its flags stop being validated silently — so the
  // absence is asserted here rather than discovered later.
  const missing = [...KNOWN_CLI_COMMANDS].filter((name) => knownFlagsFor(name) == null);
  assert.deepEqual(missing, [], 'every command needs a completion.ts entry to be flag-validated');
});

test('a bad guess is worse than no guess', () => {
  // `--repo` is three edits from `--help`. Suggesting it sends someone to
  // verify a wrong lead; saying nothing sends them to the accepted list in
  // the same message.
  assert.equal(suggestFlag('doctor', undefined, '--repo'), null);
  // A real typo still gets caught.
  assert.equal(suggestFlag('doctor', undefined, '--claud'), '--claude');
  assert.equal(suggestFlag('doctor', undefined, '--codexx'), '--codex');
});

test('every flag a command reads is a flag the registry accepts', () => {
  // The registry was already incomplete before it became load-bearing —
  // `steering apply --claude` and `dial resolve --prompt-sha256` both worked
  // and were both absent from it. That cost nothing while the table only fed
  // shell completion; the moment it started validating, each gap became a
  // working invocation rejected. So the drift is asserted rather than trusted.
  //
  // Ground truth is what `cli.ts` actually READS: a `values.x` or
  // `values['x']` inside a command's own `case` block is that command
  // consuming that flag, whatever any help text claims.
  const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
  const caseRe = /^    case '([a-z][a-z-]*)': \{([\s\S]*?)^    \}/gm;
  const gaps: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(src)) !== null) {
    const command = m[1]!;
    const body = m[2]!;
    const accepted = knownFlagsFor(command);
    if (accepted == null) continue;
    const all = new Set(accepted);
    // Subcommands are dispatched two ways: `positionals[1] === 'x'` directly,
    // or hoisted into a local first (`const sub = positionals[1]` then
    // `sub === 'x'`). Both spellings are live, so both are matched — missing
    // one would make this tripwire report gaps that are not gaps.
    const subNames = [
      ...[...body.matchAll(/positionals\[1\] === '([a-z-]+)'/g)].map((x) => x[1]!),
      ...[...body.matchAll(/\bsub(?:command)? === '([a-z-]+)'/g)].map((x) => x[1]!),
    ];
    for (const sub of new Set(subNames)) {
      for (const flag of knownFlagsFor(command, sub) ?? []) all.add(flag);
    }
    const read = new Set(
      [...body.matchAll(/values\.([a-zA-Z][a-zA-Z0-9]*)|values\['([a-z][a-z0-9-]*)'\]/g)]
        .map((x) => `--${(x[1] ?? x[2])!.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`),
    );
    for (const flag of read) if (!all.has(flag)) gaps.push(`${command} reads ${flag}`);
  }
  assert.deepEqual(gaps, [], 'completion.ts must accept every flag cli.ts reads, or that flag is now rejected in production');
});
