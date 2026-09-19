/**
 * Codex agent files — the archetype vocabulary, and nothing else.
 *
 * Codex has no plugin-shipped agents: a custom agent is a user-scoped TOML in
 * `$CODEX_HOME/agents/`, so `$fadeno-host` reconciles them on first use (the
 * narrow CLI operation is also reused by `fadeno setup --codex`). Without them
 * `agent_type` is not a parameter of Codex's spawn tool at all — measured on
 * 0.153.4, where a spawn with no agent files in reach reports "this tool has no
 * `agent_type` parameter" and every subagent starts as `default`. A host that
 * cannot name an archetype cannot ask Fadeno for one, so on Codex these files
 * are what makes the host lane reachable.
 *
 * **They declare no model and no effort, deliberately.** An earlier Fadeno
 * materialized agent files that carried the dial's model, and 0.7 deleted them
 * because Codex resolves a file's `model` LAST and lets it win: a file written
 * for yesterday's dial silently overrode today's, and nothing said so. The
 * precedence that made that a trap makes the opposite safe — state no model in
 * the file, and the value the spawn passes is the value that runs. Measured:
 * with `name`/`description`/`developer_instructions` and no `model`, a spawn
 * carrying `model` and `reasoning_effort` reached the subagent with both
 * intact, and `SubagentStart` reported the spawned model rather than the
 * parent's.
 *
 * So a file here is a NAME, not a routing decision. The dial stays the only
 * thing that decides which model does the work, and it stays live.
 */

/** Marks a file as Fadeno's to rewrite and to sweep. Must start the file. */
export const CODEX_AGENT_MARKER = '# fadeno:managed';

/** How a Codex agent file spells an archetype: `fadeno-worker`, never a bare `worker`. */
export function codexAgentName(archetype: string): string {
  return `fadeno-${archetype}`;
}

export function codexAgentFilename(archetype: string): string {
  return `${codexAgentName(archetype)}.toml`;
}

/** TOML basic-string escaping, for the two values that carry prose. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One archetype's agent file. `description` is what the host reads when it
 * chooses; `developer_instructions` is the floor the agent starts from, and it
 * stays deliberately thin — the dispatch contract arrives at `SubagentStart`
 * and says everything that actually binds. What lives here is only what must
 * be true before Fadeno has spoken: that a spawn without a contract is not a
 * dispatch, and should be reported as one that was not.
 */
export function codexAgentFile(archetype: string, description: string): string {
  return [
    `${CODEX_AGENT_MARKER} archetype=${archetype}`,
    '# Fadeno writes this file. It states no model and no reasoning effort on',
    '# purpose: on Codex a file\'s model WINS over the one a spawn passes, so a',
    '# model here would override the dial with whatever was true when it was',
    '# written. Change routing with `fadeno dial`, never by editing this file.',
    '',
    `name = ${tomlString(codexAgentName(archetype))}`,
    `description = ${tomlString(description)}`,
    'developer_instructions = """',
    `You are the \`${archetype}\` archetype of a Fadeno dispatch.`,
    '',
    'Fadeno delivers your dispatch contract as developer context when you start:',
    'it says where to work, what you own, and what your final message must',
    'contain. Follow it. It is the authority on all three, over anything you',
    'infer from the task itself.',
    '',
    'If no `## Fadeno dispatch` contract reached you, you were spawned outside',
    'Fadeno: do the task as asked, work in the directory you were started in,',
    'commit nothing, and say plainly in your report that you had no contract.',
    '"""',
    '',
  ].join('\n');
}

/** Whether a TOML agent file declares a model — the only way one overrides a dial. */
export function declaresModel(text: string): boolean {
  return /^\s*model\s*=\s*["']/m.test(text);
}

/** Whether Fadeno wrote this file, and so may rewrite or remove it. */
export function isManagedAgentFile(text: string): boolean {
  return text.startsWith(CODEX_AGENT_MARKER);
}
