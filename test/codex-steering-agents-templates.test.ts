import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { compileDialRef, parseDialRef, parseExecutorProfile } from '../src/lib/executors.ts';

const REPO = join(import.meta.dirname, '..');
const AGENTS_DIR = join(REPO, 'templates', 'codex', 'codex-steering-agents');
const CATALOG_PATH = join(REPO, 'templates', 'common', 'fadeno', 'executors.yaml');

/**
 * Regression guard for the drift that shipped `--host-executor native-worker`
 * (and `native-reviewer`/`native-judge`) into the static Codex bootstrap
 * agents. Those names were never declared anywhere — no catalog entry, no
 * registry, no source — leftovers from before horizon 7 replaced named
 * executors with dials. `runSteeringResolve` rejects an undeclared host
 * executor, and because these agents' own instructions say "on any resolver
 * error, stop and relay the instruction," a freshly bootstrapped Codex repo's
 * worker/reviewer/judge agents dead-stopped on every ordinary task.
 *
 * `fadeno init --codex` / `fadeno vendor` copy the files in
 * `templates/codex/codex-steering-agents/` into a user's `.codex/agents/`
 * byte-for-byte (see `src/commands/init.ts`), so nothing at emit time
 * re-validates the `--host-executor` name baked into their
 * `developer_instructions`. This test is what stands between a future edit
 * here and a repeat of that dead-stop: any `--host-executor <name>` in these
 * templates must name an executor the shipped starter catalog
 * (`templates/common/fadeno/executors.yaml`) actually resolves to a host
 * adapter, under the codex harness these agents run in. It deliberately does
 * not import anything from `src/commands/steering.ts`'s dynamic
 * `renderCodexHostAgent`/`renderCodexCommandBroker` templates, so it keeps
 * catching drift in the static files independent of that file's own state.
 */
test('static codex steering-agent templates never name an undeclared --host-executor', () => {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.toml'));
  assert.ok(
    files.length >= 3,
    `expected the worker/reviewer/judge bootstrap agents under ${AGENTS_DIR}, found: ${files.join(', ') || '(none)'}`,
  );

  const catalogText = readFileSync(CATALOG_PATH, 'utf8');
  const profile = parseExecutorProfile(catalogText, CATALOG_PATH, 'codex');

  for (const file of files) {
    const body = readFileSync(join(AGENTS_DIR, file), 'utf8');
    const names = [...body.matchAll(/--host-executor\s+([^\s`]+)/g)].map((m) => m[1]!);
    for (const name of names) {
      let declaredAsHost = false;
      try {
        const ref = parseDialRef(name, `${file} --host-executor value`);
        declaredAsHost = compileDialRef(ref, profile).spec.adapter === 'host';
      } catch {
        declaredAsHost = false;
      }
      assert.ok(
        declaredAsHost,
        `${file} passes --host-executor ${name}, which the shipped starter catalog does not resolve to a ` +
          'declared host executor under the codex harness — this is exactly the dead-stop drift this test guards against',
      );
    }
  }
});
