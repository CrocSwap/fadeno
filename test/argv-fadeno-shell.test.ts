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
 * The negatives matter as much: the predicate reads only the VALUES of the
 * flags that select permission (`--allowedTools`, `--sandbox`) plus the blanket
 * flags, so a restricted variant that DENIES Bash — or that picks
 * `--sandbox read-only` — must not read as capable, and a stray "Bash" or
 * "danger-full-access" inside some other flag's value must not either.
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
  // Three flags that open the shell without naming a tool at all — the first is
  // what the shipped claude lanes carry as of 2026-09-06.
  assert.equal(argvGrantsFadenoShell(['claude', '-p', '--dangerously-skip-permissions']), true);
  assert.equal(argvGrantsFadenoShell(['claude', '-p', '--permission-mode', 'bypassPermissions']), true);
  assert.equal(argvGrantsFadenoShell(['claude', '-p', '--permission-mode=bypassPermissions']), true);

  // The codex vocabulary. `--dangerously-bypass-approvals-and-sandbox` is what
  // the shipped codex lane carries as of 2026-09-06; the sandbox modes are the
  // spellings a user or project catalog may still pin, including the
  // `workspace-write` every install had before that date.
  assert.equal(
    argvGrantsFadenoShell([
      'codex', 'exec', '--model', 'gpt-5.6-sol', '--dangerously-bypass-approvals-and-sandbox', '-',
    ]),
    true,
    'the shipped codex lane',
  );
  assert.equal(argvGrantsFadenoShell(['codex', 'exec', '--sandbox', 'danger-full-access', '-']), true);
  assert.equal(argvGrantsFadenoShell(['codex', 'exec', '--sandbox=danger-full-access', '-']), true, '`=` form');
  assert.equal(argvGrantsFadenoShell(['codex', 'exec', '-s', 'danger-full-access', '-']), true, 'short flag');
  // The pre-2026-09-06 lane. `workspace-write` runs shell commands and writes
  // inside the workspace, which is all `fadeno` needs, so an install still on
  // the old catalog must not be reported as incapable. Widened deliberately —
  // see the predicate's doc comment for why the narrow answer was wrong.
  assert.equal(
    argvGrantsFadenoShell(['codex', 'exec', '--sandbox', 'workspace-write', '-']),
    true,
    'the codex lane every install carried before the posture change',
  );
  assert.equal(argvGrantsFadenoShell(['codex', 'exec', '-s', 'workspace-write', '-']), true, 'short flag');
});

test('argvGrantsFadenoShell: reads the permission flags\' values and nothing else', () => {
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

  // The codex half has to draw the same line the claude half does: a mode that
  // genuinely restricts must not read as capable, or the widening above would
  // have turned the predicate into "is this argv codex-shaped".
  assert.equal(
    argvGrantsFadenoShell(['codex', 'exec', '--sandbox', 'read-only', '-']),
    false,
    'read-only cannot write the ledger, so it cannot run fadeno',
  );
  assert.equal(argvGrantsFadenoShell(['codex', 'exec', '-s', 'read-only', '-']), false, 'short flag');
  assert.equal(argvGrantsFadenoShell(['codex', 'exec', '--sandbox=read-only', '-']), false, '`=` form');
  assert.equal(
    argvGrantsFadenoShell(['codex', 'exec', '--model', 'gpt-5.6-sol', '-']),
    false,
    'no sandbox flag at all — `codex exec` defaults to read-only',
  );
  // Flag-awareness, the codex mirror of the `--append-system-prompt` case: the
  // mode counts only as the value of the flag that SELECTS it.
  assert.equal(
    argvGrantsFadenoShell(['codex', 'exec', '-c', 'sandbox_permissions=["danger-full-access"]', '-']),
    false,
    'a config override is not the sandbox flag',
  );
  assert.equal(
    argvGrantsFadenoShell(['codex', 'exec', '--sandbox', 'read-only', '--model', 'workspace-write', '-']),
    false,
    'the mode token in another flag\'s value is not a grant',
  );
  assert.equal(
    argvGrantsFadenoShell(['codex', 'exec', '--sandbox', '--model', 'danger-full-access', '-']),
    false,
    '`--sandbox` is not variadic; it does not reach past the next flag',
  );
});
