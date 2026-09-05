import assert from 'node:assert/strict';
import test from 'node:test';
import { argvGrantsFadenoShell } from '../src/lib/executors.ts';

/**
 * The one-list-two-consumers guard behind `fadeno models --json`'s
 * `fadeno_capable` column.
 *
 * When the base claude lane traded `--allowedTools "Bash(fadeno:*)"` for the
 * wider bare `Bash` rule, a predicate that only matched the scoped substring
 * would have reported every anthropic delivery as `fadeno_capable: false` while
 * the argv could in fact run the whole fadeno family — a silent wrong answer of
 * exactly the shape this project keeps finding. Every spelling that grants is
 * read here, in one place, and every one is pinned.
 *
 * The negatives matter as much: the predicate reads only `--allowedTools`
 * VALUES (plus the two blanket flags), so a restricted variant that DENIES Bash
 * must not read as capable, and a stray "Bash" inside some other flag's value
 * must not either.
 */
test('argvGrantsFadenoShell: every documented way an argv grants the shell', () => {
  // The shipped lanes. `--allowedTools` takes a comma- or space-separated list
  // of rules, and a BARE tool name is the documented match-all rule, so the
  // bare token has to be found inside a multi-rule value too.
  assert.equal(
    argvGrantsFadenoShell(['claude', '-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash']),
    true,
    'the shipped bare rule',
  );
  // The vendor documents `Bash(*)` as EQUIVALENT to a bare `Bash`, so a catalog
  // that writes the other spelling is no less capable.
  assert.equal(argvGrantsFadenoShell(['claude', '--allowedTools', 'Bash(*)']), true, 'the equivalent spelling');
  assert.equal(
    argvGrantsFadenoShell(['claude', '-p', '--allowedTools', 'Bash(fadeno:*)']),
    true,
    'the scoped rule a user catalog may still pin',
  );
  assert.equal(argvGrantsFadenoShell(['claude', '--allowedTools', 'Edit,Bash']), true, 'comma-separated list');
  assert.equal(argvGrantsFadenoShell(['claude', '--allowedTools', 'Bash Edit']), true, 'space-separated list');
  assert.equal(argvGrantsFadenoShell(['claude', '--allowedTools', 'Edit Bash']), true, 'not only the first rule');
  // The `=` form of the flag, and the kebab spelling `claude --help` documents
  // beside the camel one.
  assert.equal(argvGrantsFadenoShell(['claude', '--allowedTools=Bash']), true, '`=` form');
  assert.equal(argvGrantsFadenoShell(['claude', '--allowed-tools', 'Bash']), true, 'kebab spelling');
  assert.equal(argvGrantsFadenoShell(['claude', '--allowed-tools=Edit,Bash']), true, 'kebab `=` form');
  // The flag is variadic: values run until the next `--` flag, so a rule in the
  // second value position counts.
  assert.equal(
    argvGrantsFadenoShell(['claude', '--allowedTools', 'Edit', 'Bash', '--permission-mode', 'acceptEdits']),
    true,
    'variadic values',
  );
  // Two flags that open the shell without naming a tool at all.
  assert.equal(argvGrantsFadenoShell(['claude', '-p', '--dangerously-skip-permissions']), true);
  assert.equal(argvGrantsFadenoShell(['claude', '-p', '--permission-mode', 'bypassPermissions']), true);
  assert.equal(argvGrantsFadenoShell(['claude', '-p', '--permission-mode=bypassPermissions']), true);
});

test('argvGrantsFadenoShell: reads `--allowedTools` values and nothing else', () => {
  assert.equal(
    argvGrantsFadenoShell(['claude', '-p', '--permission-mode', 'acceptEdits']),
    false,
    'acceptEdits auto-approves EDITS; it does not open the shell',
  );
  // THE regression this walk exists for. A project that wants a tighter posture
  // declares its own variant, and `--disallowedTools Bash` is the natural shape
  // of it — `claude --help` gives that flag the identical value grammar. A
  // predicate that scanned every argv part read this argv as CAPABLE.
  assert.equal(
    argvGrantsFadenoShell(['claude', '-p', '--permission-mode', 'acceptEdits', '--disallowedTools', 'Bash']),
    false,
    'a DENY rule is not a grant',
  );
  assert.equal(argvGrantsFadenoShell(['claude', '--disallowed-tools', 'Bash']), false, 'kebab deny spelling');
  assert.equal(
    argvGrantsFadenoShell(['claude', '-p', '--append-system-prompt', 'Prefer Bash, not Python']),
    false,
    'prose in another flag\'s value is not a permission rule',
  );
  assert.equal(
    argvGrantsFadenoShell(['claude', '--allowedTools', 'Edit', '--disallowedTools', 'Bash']),
    false,
    'variadic collection stops at the next flag',
  );
  // A scoped grant for some OTHER command must not read as capable.
  assert.equal(argvGrantsFadenoShell(['claude', '--allowedTools', 'Bash(git *)']), false);
  assert.equal(argvGrantsFadenoShell(['claude', '--allowedTools', 'Bash(npm run test:*)']), false);
  assert.equal(argvGrantsFadenoShell(['claude', '--allowedTools', 'Edit,Read']), false);
  assert.equal(argvGrantsFadenoShell(['claude', '--allowedTools']), false, 'the flag with no value');
  assert.equal(argvGrantsFadenoShell([]), false);
  // Pre-existing narrowness, pinned so widening it is a deliberate act: this
  // predicate is Claude-shaped and says nothing about codex's OS sandbox.
  assert.equal(
    argvGrantsFadenoShell(['codex', 'exec', '--sandbox', 'workspace-write', '-']),
    false,
    'not a claim about codex — see the doc comment',
  );
});
