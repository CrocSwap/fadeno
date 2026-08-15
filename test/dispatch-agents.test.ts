import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runPlugin, stampHookVersion, stampSurfaceVersion } from '../src/commands/plugin.ts';
import { packageVersion } from '../src/lib/paths.ts';
import { exists, read, tempRepo } from './helpers.ts';

// Dispatch proxy agents (loadouts-and-dispatch.md, "Claude Code integration"):
// one per archetype, Bash-only, sonnet, relaying the task prompt verbatim to
// `fadeno dispatch --archetype <a> --prompt-file <path>` in one Bash call.
const ARCHETYPES = ['worker', 'reviewer', 'judge'] as const;

const agentsTplDir = join(import.meta.dirname, '..', 'templates', 'claude', 'claude-agents');

function agentSource(archetype: string): string {
  return readFileSync(join(agentsTplDir, `dispatch-${archetype}.md`), 'utf8');
}

/** Split an agent markdown file into its YAML frontmatter block and body. */
function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, 'agent file has no frontmatter block');
  return { frontmatter: m![1]!, body: m![2]! };
}

test('dispatch proxy templates exist with Bash-only, sonnet frontmatter', () => {
  for (const archetype of ARCHETYPES) {
    const { frontmatter } = splitFrontmatter(agentSource(archetype));
    assert.match(frontmatter, new RegExp(`^name: dispatch-${archetype}$`, 'm'));
    // Exactly `tools: Bash` — the proxy must not carry any other tool, and
    // exactly `model: sonnet` — the 2026-08-12 dogfood A/B caught haiku
    // defecting on the relay contract (did the task itself, dropped the
    // prompt's first line, asserted unwritten evidence); sonnet relayed
    // flawlessly and a proxy turn is only a few relay tokens.
    const tools = frontmatter.match(/^tools:.*$/gm);
    assert.deepEqual(tools, ['tools: Bash'], `dispatch-${archetype} tools must be exactly Bash`);
    const model = frontmatter.match(/^model:.*$/gm);
    assert.deepEqual(model, ['model: sonnet'], `dispatch-${archetype} model must be exactly sonnet`);
  }
});

test('dispatch proxy descriptions carry the archetype routing phrases', () => {
  for (const archetype of ARCHETYPES) {
    const { frontmatter } = splitFrontmatter(agentSource(archetype));
    const desc = frontmatter.match(/^description:.*$/m)?.[0];
    assert.ok(desc, `dispatch-${archetype} has no description`);
    assert.match(desc!, /use proactively/i);
    assert.match(
      desc!,
      new RegExp(`MUST BE USED for ${archetype}-shaped subtasks when Fadeno dials are active`),
    );
  }
});

test('dispatch proxy bodies relay the prompt file verbatim through fadeno dispatch', () => {
  for (const archetype of ARCHETYPES) {
    const { body } = splitFrontmatter(agentSource(archetype));
    // 1. Verbatim prompt relay (the kernel owns the snapshot file now).
    assert.match(body, /\.fadeno\/local\/prompts\//);
    assert.match(body, /ENTIRE task prompt/);
    assert.match(body, /verbatim/i);
    // 2. The fixed CLI contract: bare `fadeno` + stdin heredoc (so the
    //    `Bash(fadeno:*)` permission rule matches), with the plugin-root
    //    spelling as the documented not-on-PATH retry.
    assert.match(
      body,
      new RegExp(`fadeno dispatch --archetype ${archetype} --tag ${archetype}-<slug> <<'FADENO_PROMPT'`),
    );
    // The tag is the whole recovery story after a kill: the kernel's id echo
    // rides a stderr stream the harness discards along with a timed-out call,
    // so the only handle that survives is the one the proxy chose itself.
    assert.match(body, new RegExp(`fadeno dispatches --output tag:${archetype}-<slug> --wait 120`));
    assert.match(body, /the same tag you launched with|the tag you launched with/);
    assert.match(body, /CLAUDE_PLUGIN_ROOT/, 'proxies must document the bundled-CLI retry');
    // 3. Verbatim relay of the stdout report as the final response.
    assert.match(body, /stdout report \*\*verbatim\*\* as your final response/);
    // 4. No native fallback on failure — silent provider substitution is a
    //    stated non-goal.
    assert.match(body, /Do NOT (attempt|perform) the (task|review|evaluation)\s+yourself/);
    assert.match(body, /non-goal/);
    // 5. Single-call contract with the long tool timeout — shell variables
    //    don't persist across Bash calls, and the 2-minute default kills
    //    long-reasoning executors mid-flight.
    assert.match(body, /ONE Bash call/);
    assert.match(body, /`timeout` parameter to `600000`/);
    // 6. Honest reporting: the proxy never asserts kernel-side effects.
    assert.match(body, /Never assert that\s+evidence was logged/);
    // 7. Non-verification is stated, not left to instinct. A proxy holds one
    //    permitted command and never sees the repo, so it cannot confirm any
    //    change an executor claims to have made. Relaying that claim bare
    //    reads as the proxy vouching for it. The carve-out exists because
    //    step 3's "do not annotate" otherwise forbids saying so.
    assert.match(body, /no\s+tools to verify/);
    assert.match(body, /single line/);
    // 8. A live dispatch is never amended or re-dispatched by the proxy.
    //    Observed 2026-08-14 as correct emergent behaviour; specified here so
    //    it survives a model swap or a body regeneration.
    assert.match(body, /do NOT re-dispatch and do NOT fold the/);
    assert.match(body, /races the first on the same files/);
    assert.match(body, /caller's call, never yours/);
    // Permission-boundary note stays loud.
    assert.match(body, /outside this harness's permission fences/);
  }
});

test('plugin generation emits the dispatch proxies alongside the role subagents', (t) => {
  const root = tempRepo(t);
  const { outDir } = runPlugin({ cwd: root, outDir: join(root, 'plugin') });
  for (const archetype of ARCHETYPES) {
    const rel = `agents/dispatch-${archetype}.md`;
    assert.ok(exists(outDir, rel), `plugin output missing ${rel}`);
    // Identical to the template source modulo the deterministic version stamp
    // — the plugin is generated, not a hand-maintained copy.
    assert.equal(read(outDir, rel), stampSurfaceVersion(agentSource(archetype)));
  }
  // The existing role subagents still ship beside them.
  assert.ok(exists(outDir, 'agents/worker.md'));
  assert.ok(exists(outDir, 'agents/reviewer.md'));
  assert.ok(exists(outDir, 'agents/judge.md'));
});

test('plugin generation stamps the steering hook with the package version', (t) => {
  const root = tempRepo(t);
  const { outDir } = runPlugin({ cwd: root, outDir: join(root, 'plugin') });
  const template = readFileSync(
    join(import.meta.dirname, '..', 'templates', 'claude', 'hooks', 'dispatch-steering.mjs'),
    'utf8',
  );
  // The template keeps the placeholder; only emitted copies name a build. The
  // hook is loaded once per session from a version-keyed cache, so its evidence
  // rows are the only way to tell which generation a mid-upgrade row came from.
  assert.ok(template.includes("const HOOK_VERSION = 'dev';"));
  const emitted = read(outDir, 'hooks/dispatch-steering.mjs');
  assert.ok(emitted.includes(`const HOOK_VERSION = '${packageVersion()}';`));
  assert.ok(!emitted.includes("HOOK_VERSION = 'dev'"));
  // Identical to the template modulo that deterministic stamp.
  assert.equal(emitted, stampHookVersion(template));
});

test('plugin surface descriptions carry the version stamp', (t) => {
  const root = tempRepo(t);
  const { outDir } = runPlugin({ cwd: root, outDir: join(root, 'plugin') });
  const stamp = ` [fadeno ${packageVersion()}]`;
  for (const rel of [
    'agents/dispatch-worker.md',
    'agents/worker.md',
    'skills/runner/SKILL.md',
    'skills/driver/SKILL.md',
  ]) {
    const description = read(outDir, rel).match(/^description:.*$/m)?.[0];
    assert.ok(description?.endsWith(stamp), `${rel} description must end with "${stamp}"`);
  }
});
