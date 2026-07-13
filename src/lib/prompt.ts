import type { DownstreamNote, SchemaKind } from './prompt-resolve.ts';

/**
 * Pure Markdown rendering of a resolved step assignment. No filesystem, no
 * `process`, no clock — the command layer supplies bytes, hashes, and schema
 * text. Output is LF-only with exactly one trailing newline.
 */

export interface PromptInputFile {
  path: string;
  byActor: string | null;
  isSelf: boolean;
  bytes: number;
  sha256: string;
  /** Fenced content when `--inline`; otherwise null. */
  content: string | null;
}

export interface PromptInput {
  artifact: string;
  producedBy: string | null;
  invocation: number | null;
  isAssembledAggregate: boolean;
  aggregatePath: string | null;
  files: PromptInputFile[];
}

export interface PromptOutputView {
  path: string;
  mediaType: string;
  schemaKind: SchemaKind | null;
  instructions: string | null;
  collectiveType: string;
  memberType: string;
  isMap: boolean;
}

export interface PromptContext {
  runId: string;
  playbookName: string;
  schemaVersion: string;
  task: string;
  step: string;
  kind: string;
  actor: string | null;
  otherMembers: string[];
  iteration: number | null;
  maxIterations: number | null;
  invocation: number;
  loopOwner: string | null;
  purpose: string | null;
  inputs: PromptInput[];
  output: PromptOutputView;
  downstream: DownstreamNote | null;
  policies: Record<string, unknown> | null;
  /** Canonical (key-sorted) schema text for a typed output, else null. */
  schemaText: string | null;
  inline: boolean;
}

/** Recursive key-sort JSON with 2-space indent and LF newlines. */
export function canonicalJson(value: unknown): string {
  return canonical(value, 0);
}

function canonical(value: unknown, depth: number): string {
  const pad = '  '.repeat(depth);
  const inner = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => inner + canonical(item, depth + 1));
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    if (keys.length === 0) return '{}';
    const items = keys.map((key) => `${inner}${JSON.stringify(key)}: ${canonical((value as Record<string, unknown>)[key], depth + 1)}`);
    return `{\n${items.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

/** Fence wide enough to enclose `content`: max(3, longest backtick run + 1). */
export function fenceFor(content: string): string {
  let longest = 0;
  const runs = content.match(/`+/g);
  if (runs) for (const run of runs) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function blockquote(text: string): string[] {
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line.trim()}`));
}

function renderPolicyValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ')}]`;
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function attribution(file: PromptInputFile): string {
  if (file.isSelf) return ' — produced by you';
  if (file.byActor) return ` — produced by \`${file.byActor}\``;
  return '';
}

function renderInputs(ctx: PromptContext): string[] {
  const lines: string[] = ['## Inputs', ''];
  if (ctx.inputs.length === 0) {
    lines.push('No declared inputs; work from the task and constraints below.');
    return lines;
  }
  ctx.inputs.forEach((input, index) => {
    const producer =
      input.producedBy == null
        ? 'produced upstream'
        : input.invocation == null
          ? `produced by step \`${input.producedBy}\``
          : `produced by step \`${input.producedBy}\` (invocation ${input.invocation})`;
    lines.push(`${index + 1}. ${input.artifact} — ${producer}`);
    if (input.files.length === 0) {
      lines.push('   - (no file recorded at the cutoff)');
    }
    for (const file of input.files) {
      lines.push(`   - \`${file.path}\` — ${file.bytes} bytes, sha256 ${file.sha256}${attribution(file)}`);
      if (file.content != null) {
        const fence = fenceFor(file.content);
        lines.push(`${fence}`, file.content.replace(/\n$/, ''), `${fence}`);
      }
    }
    if (input.isAssembledAggregate && input.aggregatePath) {
      lines.push(`   - assembled aggregate (not re-listed): \`${input.aggregatePath}\` — the gate-evaluated ${input.artifact} array.`);
    }
    lines.push('');
  });
  lines.pop();
  return lines;
}

function renderConstraints(ctx: PromptContext): string[] {
  const lines: string[] = ['## Execution constraints', ''];
  if (ctx.output.isMap && ctx.actor) {
    const others = ctx.otherMembers.length > 0 ? ctx.otherMembers.map((m) => `\`${m}\``).join(', ') : '(none)';
    lines.push(
      `- Map step: perform only the \`${ctx.actor}\` member. The other members (${others}) are handled separately — do not coordinate with them or produce their outputs.`,
    );
  }
  if (ctx.policies) {
    const keys = Object.keys(ctx.policies).sort();
    if (keys.length > 0) {
      const rendered = keys.map((key) => `${key} = ${renderPolicyValue(ctx.policies![key])}`).join('; ');
      lines.push(`- Policies (advisory unless enforced by hooks/CI): ${rendered}.`);
    }
  }
  if (ctx.loopOwner && ctx.iteration != null) {
    const bound = ctx.maxIterations != null ? ` of at most ${ctx.maxIterations}` : '';
    lines.push(
      `- This step is body of loop \`${ctx.loopOwner}\`, iteration ${ctx.iteration}${bound}. Write this generation's artifact; never overwrite an earlier generation.`,
    );
  }
  lines.push(
    '- You may read the repository, but must not modify `run.yaml`, `events.jsonl`, prompt snapshots under `artifacts/prompts/`, or any artifact other than your declared output below.',
  );
  return lines;
}

function renderOutput(ctx: PromptContext): string[] {
  const out = ctx.output;
  const lines: string[] = ['## Output contract', ''];
  if (out.isMap) {
    lines.push(`- Collective output: ${out.collectiveType}. Your output: ${out.memberType}.`);
  } else {
    lines.push(`- Output: ${out.collectiveType || out.memberType}.`);
  }
  lines.push(`- Write exactly one artifact to \`${out.path}\`.`);
  lines.push(`- Media type: ${out.mediaType}.`);

  if (out.schemaKind && ctx.schemaText != null) {
    lines.push('- Emit JSON only — no prose, no code fences around it — conforming to this schema:');
    lines.push('', '```json', ctx.schemaText, '```', '');
    lines.push(`- Self-check before finishing: \`fadeno validate ${out.path} --schema ${out.schemaKind}\`.`);
  } else if (out.instructions != null) {
    lines.push(`- ${out.instructions}`);
  } else {
    lines.push('- Produce one self-contained markdown document.');
  }

  if (ctx.downstream) {
    let note = `- Downstream: gate \`${ctx.downstream.gateStep}\` computes \`${ctx.downstream.condition}\` from ${out.collectiveType || out.memberType}.`;
    if (out.schemaKind === 'review-report') note += ' A `blocking`-severity issue fails it.';
    if (out.isMap) note += ' The coordinator first assembles all map members into one array.';
    lines.push(note);
  }
  return lines;
}

/** Render the exact prompt text for a resolved step assignment. */
export function renderStepPrompt(ctx: PromptContext): string {
  const lines: string[] = [];
  lines.push('# Fadeno step assignment', '');
  lines.push('## Task', '', ctx.task, '');

  lines.push('## Assignment', '');
  lines.push(`- run: ${ctx.runId}`);
  lines.push(`- playbook: ${ctx.playbookName} (schema_version ${ctx.schemaVersion})`);
  lines.push(`- step: ${ctx.step} (${ctx.kind})`);
  lines.push(`- actor: ${ctx.actor ?? '(unassigned)'}`);
  if (ctx.output.isMap && ctx.actor) {
    const others = ctx.otherMembers.length > 0 ? ctx.otherMembers.join(', ') : '(none)';
    lines.push(`- map member: ${ctx.actor} (other members: ${others})`);
  }
  if (ctx.loopOwner && ctx.iteration != null) {
    const bound = ctx.maxIterations != null ? ` of ${ctx.maxIterations}` : '';
    lines.push(`- iteration: ${ctx.iteration}${bound}`);
  }
  lines.push(`- invocation: ${ctx.invocation}`);
  if (ctx.purpose) {
    lines.push('', ...blockquote(ctx.purpose));
  }
  lines.push('');

  lines.push(...renderInputs(ctx), '');
  lines.push(...renderConstraints(ctx), '');
  lines.push(...renderOutput(ctx), '');

  lines.push('## Completion protocol', '');
  lines.push('- Produce exactly the one declared artifact above; write nothing else.');
  lines.push('- Do not modify the run ledger (`run.yaml`, `events.jsonl`) or any prompt snapshot.');
  lines.push('- Keep all commentary inside the artifact; emit no other prose.');
  lines.push('- If your harness cannot write files, return only the artifact body for the coordinator to save.');

  return `${lines.join('\n')}\n`;
}
