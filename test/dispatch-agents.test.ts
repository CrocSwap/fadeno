import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { runPlugin } from '../src/commands/plugin.ts';
import { exists, read, tempRepo } from './helpers.ts';

// Dispatch proxy agents (loadouts-and-dispatch.md, "Claude Code integration"):
// one per archetype, Bash-only, haiku, relaying the task prompt verbatim to
// `fadeno dispatch --archetype <a> --prompt-file <path>`.
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

test('dispatch proxy templates exist with Bash-only, haiku frontmatter', () => {
  for (const archetype of ARCHETYPES) {
    const { frontmatter } = splitFrontmatter(agentSource(archetype));
    assert.match(frontmatter, new RegExp(`^name: dispatch-${archetype}$`, 'm'));
    // Exactly `tools: Bash` — the proxy must not carry any other tool, and
    // exactly `model: haiku` — the proxy does no thinking, don't pay frontier
    // rates to babysit a subprocess.
    const tools = frontmatter.match(/^tools:.*$/gm);
    assert.deepEqual(tools, ['tools: Bash'], `dispatch-${archetype} tools must be exactly Bash`);
    const model = frontmatter.match(/^model:.*$/gm);
    assert.deepEqual(model, ['model: haiku'], `dispatch-${archetype} model must be exactly haiku`);
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
      new RegExp(`MUST BE USED for ${archetype}-shaped subtasks when a Fadeno loadout is active`),
    );
  }
});

test('dispatch proxy bodies relay the prompt file verbatim through fadeno dispatch', () => {
  for (const archetype of ARCHETYPES) {
    const { body } = splitFrontmatter(agentSource(archetype));
    // 1. Verbatim prompt capture to a unique file under .fadeno/local/prompts/.
    assert.match(body, /\.fadeno\/local\/prompts\//);
    assert.match(body, /ENTIRE task prompt/);
    assert.match(body, /verbatim/i);
    // 2. The fixed CLI contract.
    assert.match(
      body,
      new RegExp(`fadeno dispatch --archetype ${archetype} --prompt-file`),
    );
    // 3. Verbatim relay of the stdout report as the final response.
    assert.match(body, /stdout report \*\*verbatim\*\* as your final response/);
    // 4. No native fallback on failure — silent provider substitution is a
    //    stated non-goal.
    assert.match(body, /Do NOT (attempt|perform) the (task|review|evaluation) (yourself|yourself as)/);
    assert.match(body, /non-goal/);
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
    // Byte-identical to the template source — the plugin is generated, not a
    // hand-maintained copy.
    assert.equal(read(outDir, rel), agentSource(archetype));
  }
  // The existing role subagents still ship beside them.
  assert.ok(exists(outDir, 'agents/worker.md'));
  assert.ok(exists(outDir, 'agents/reviewer.md'));
  assert.ok(exists(outDir, 'agents/judge.md'));
});
