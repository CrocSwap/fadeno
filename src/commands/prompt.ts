import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sha256Hex } from '../lib/artifact-manifest.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { SchemaSet, validateFile } from '../lib/playbook-validate.ts';
import { canonicalJson, renderStepPrompt, type PromptContext, type PromptInput } from '../lib/prompt.ts';
import {
  PromptResolveError,
  resolveStepPlan,
  type Playbook,
  type ResolutionPlan,
  type Selection,
} from '../lib/prompt-resolve.ts';
import {
  readEventsStrict,
  resolveRun,
  RUN_LEDGER_SCHEMA_VERSION,
  RunLedgerError,
} from '../lib/run-ledger.ts';
import { LedgerWriteError, LedgerWriter } from '../lib/run-ledger-write.ts';

export class PromptError extends Error {}

export interface PromptOptions {
  run: string;
  step: string;
  actor?: string;
  iteration?: number;
  inline?: boolean;
  /** Record a snapshot + `prompt_assembled` event (default true). */
  record?: boolean;
  cwd?: string;
  repoRoot?: string;
  /** Injectable clock for the recorded event only; never in the prompt body. */
  now?: Date;
}

export interface PromptResult {
  prompt: string;
  sha256: string;
  promptPath: string | null;
  recorded: 'created' | 'reused' | 'preview';
  plan: ResolutionPlan;
}

function locatePlaybook(repoRoot: string, name: string): string {
  const dir = join(repoRoot, '.fadeno', 'playbooks');
  for (const candidate of [`${name}.yaml`, `${name}.yml`]) {
    const path = join(dir, candidate);
    if (existsSync(path)) return path;
  }
  throw new PromptError(`Playbook "${name}" not found in ${dir}.`);
}

/**
 * Assemble the deterministic prompt for a run step, recording it by default as
 * an immutable snapshot + `prompt_assembled` manifest event. Returns data only;
 * `cli.ts` prints. Pure resolution and rendering live in `lib/prompt-resolve.ts`
 * and `lib/prompt.ts`; this layer owns the filesystem and the record decision.
 */
export function runPrompt(opts: PromptOptions): PromptResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const run = resolveRun(repoRoot, opts.run);
  const runDir = run.dir;

  // Strictest version gate of all commands — including previews. Input
  // resolution follows current-format rules only; a silently different
  // preview on a legacy ledger is exactly what the compatibility policy
  // forbids, so there is no --legacy here.
  if (run.schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
    throw new PromptError(
      run.schemaVersion == null
        ? `run "${run.runId}" is a legacy ledger (run.yaml has no schema_version); ` +
            'prompt assembly reads only current-format ledgers. Create a new run with `fadeno new-run`.'
        : `run "${run.runId}" has ledger schema_version "${run.schemaVersion}"; ` +
            `this fadeno reads "${RUN_LEDGER_SCHEMA_VERSION}".`,
    );
  }

  let events;
  try {
    events = readEventsStrict(runDir);
  } catch (err) {
    if (err instanceof RunLedgerError) throw new PromptError(err.message);
    throw err;
  }

  if (run.playbook == null) {
    throw new PromptError(`run "${run.runId}" has no playbook recorded in run.yaml.`);
  }
  const playbookPath = locatePlaybook(repoRoot, run.playbook);
  const playbookBytes = readFileSync(playbookPath);
  let playbook: Playbook;
  try {
    const parsed = parseYaml(playbookBytes.toString('utf8'));
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('playbook is not a mapping');
    }
    playbook = parsed as Playbook;
  } catch (err) {
    throw new PromptError(`could not parse playbook ${run.playbook}: ${(err as Error).message}`);
  }

  const schemas = new SchemaSet(join(repoRoot, '.fadeno', 'schemas'));
  const validation = validateFile(playbookPath, schemas, 'playbook');
  const errorIssues = validation.issues.filter((issue) => issue.severity === 'error');
  if (errorIssues.length > 0) {
    const detail = errorIssues.map((issue) => `${issue.path || '/'}: ${issue.message}`).join('; ');
    throw new PromptError(`playbook ${run.playbook} is invalid; fix it before assembling a prompt: ${detail}`);
  }

  const sel: Selection = {
    step: opts.step,
    actor: opts.actor ?? null,
    iteration: opts.iteration ?? null,
  };

  let plan: ResolutionPlan;
  try {
    plan = resolveStepPlan(playbook, events, sel);
  } catch (err) {
    if (err instanceof PromptResolveError) throw new PromptError(err.message);
    throw err;
  }

  const inputs: PromptInput[] = plan.inputs.map((input) => {
    const files = input.files.map((file) => {
      const abs = join(runDir, file.path);
      if (!existsSync(abs)) {
        const producer = input.producedBy ?? 'an upstream step';
        throw new PromptError(`input file "${file.path}" for ${input.artifact} (produced by ${producer}) is missing on disk.`);
      }
      const bytes = readFileSync(abs);
      return {
        path: file.path,
        byActor: file.byActor,
        isSelf: file.isSelf,
        bytes: bytes.length,
        sha256: sha256Hex(bytes),
        content: opts.inline ? bytes.toString('utf8') : null,
      };
    });
    return {
      artifact: input.artifact,
      producedBy: input.producedBy,
      invocation: input.invocation,
      isAssembledAggregate: input.isAssembledAggregate,
      aggregatePath: input.aggregatePath,
      files,
    };
  });

  let schemaText: string | null = null;
  if (plan.output.schemaKind) {
    const schemaFile = join(repoRoot, '.fadeno', 'schemas', `${plan.output.schemaKind}.schema.json`);
    if (existsSync(schemaFile)) {
      schemaText = canonicalJson(JSON.parse(readFileSync(schemaFile, 'utf8')));
    }
  }

  const policies =
    playbook.policies && typeof playbook.policies === 'object' && !Array.isArray(playbook.policies)
      ? (playbook.policies as Record<string, unknown>)
      : null;

  const ctx: PromptContext = {
    runId: run.runId,
    playbookName: typeof playbook.name === 'string' ? playbook.name : run.playbook,
    schemaVersion: playbook.schema_version != null ? String(playbook.schema_version) : '?',
    task: run.task ?? '',
    step: opts.step,
    kind: plan.kind,
    actor: plan.actor,
    otherMembers: plan.otherMembers,
    iteration: plan.iteration,
    maxIterations: plan.maxIterations,
    invocation: plan.invocation,
    loopOwner: plan.loopOwner,
    purpose: plan.purpose,
    inputs,
    output: plan.output,
    downstream: plan.downstream,
    policies,
    schemaText,
    inline: Boolean(opts.inline),
  };

  const prompt = renderStepPrompt(ctx);
  const promptSha = sha256Hex(prompt);

  const record = opts.record !== false;
  const terminal = run.status != null && run.status !== 'running';
  const previewOnly = !record || terminal || plan.cutoffLine == null;

  if (previewOnly) {
    return { prompt, sha256: promptSha, promptPath: null, recorded: 'preview', plan };
  }

  let name = opts.step;
  if (plan.actor) name += `--${plan.actor}`;
  if (plan.iteration != null) name += `--v${plan.iteration + 1}`;
  name += `--n${plan.invocation}`;
  const promptRel = `artifacts/prompts/${name}.md`;
  const promptAbs = join(runDir, 'artifacts', 'prompts', `${name}.md`);

  if (existsSync(promptAbs)) {
    const existing = readFileSync(promptAbs, 'utf8');
    if (existing !== prompt) {
      throw new PromptError(`existing prompt snapshot ${promptRel} differs from the newly assembled bytes; refusing to overwrite.`);
    }
    return { prompt, sha256: promptSha, promptPath: promptRel, recorded: 'reused', plan };
  }

  mkdirSync(dirname(promptAbs), { recursive: true });
  writeFileSync(promptAbs, prompt, 'utf8');

  const now = opts.now ?? new Date();
  const manifest = {
    type: 'prompt_assembled',
    step: opts.step,
    actor: plan.actor,
    iteration: plan.iteration,
    invocation: plan.invocation,
    cutoff_line: plan.cutoffLine,
    inputs: inputs.flatMap((input) =>
      input.files.map((file) => ({
        artifact: input.artifact,
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
        produced_by: file.byActor,
      })),
    ),
    output_path: plan.output.path,
    playbook_sha256: sha256Hex(playbookBytes),
    prompt_sha256: promptSha,
    prompt_path: promptRel,
    manifest_version: 1,
  };
  let writer: LedgerWriter;
  try {
    writer = new LedgerWriter(runDir);
  } catch (err) {
    if (err instanceof LedgerWriteError) throw new PromptError(err.message);
    throw err;
  }
  writer.append(manifest, now);

  return { prompt, sha256: promptSha, promptPath: promptRel, recorded: 'created', plan };
}
