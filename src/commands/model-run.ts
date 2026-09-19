/**
 * The model runner is intentionally smaller than dispatch: resolve one
 * registered model, run its command lane in a throwaway directory, and return
 * the two streams. It does not prepare or record anything in the dispatch
 * ledger.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadLayeredProfile } from '../lib/config-layers.ts';
import {
  activeHarness,
  ExecutorProfileError,
  parseDialRef,
  PROMPT_FILE_PLACEHOLDER,
  resolveDelivery,
  resolveRegisteredModelRef,
  substitutePromptFile,
  withoutHarnessIdentity,
  type CompiledDelivery,
  type DialRef,
  type ExecutorProfile,
} from '../lib/executors.ts';
import { findRepoRoot } from '../lib/paths.ts';
import type { UserPathOptions } from '../lib/user-paths.ts';

export class ModelRunError extends Error {}

export interface ModelProcessRequest {
  /** The already-compiled argv, including the registered delivered id/effort. */
  argv: string[];
  /** The fresh scratch directory the harness must run in. */
  cwd: string;
  /** Environment with host and dispatch identity removed. */
  env: NodeJS.ProcessEnv;
  /** Exact prompt bytes for stdin, or null when argv names a prompt file. */
  stdin: Buffer | null;
  /** The exact prompt file path, or null for stdin delivery. */
  promptFile: string | null;
}

export interface ModelProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
}

/** Injectable process seam for command tests and harness fakes. */
export type ModelProcess = (request: ModelProcessRequest) => ModelProcessResult | Promise<ModelProcessResult>;

export interface ModelRunOptions {
  cwd?: string;
  repoRoot?: string;
  userPathOptions?: UserPathOptions;
  env?: NodeJS.ProcessEnv;
  /** Alias, provider/id, or delivered id, with optional @effort/on harness. */
  model?: string;
  /** Spelling used by the model-management commands; equivalent to `model`. */
  alias?: string;
  /** Optional separate harness spelling, matching the other model commands. */
  harness?: string | null;
  /** Prompt bytes supplied by the CLI or a direct caller. */
  prompt?: string | null;
  promptFile?: string | null;
  runProcess?: ModelProcess;
}

export interface ModelRunResult {
  /** The registered alias selected for this run. */
  model: string;
  /** The provider-facing id handed to the harness. */
  modelId: string;
  /** The effective effort handed to the harness. */
  effort: string;
  harness: string;
  command: string[];
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

function rootOf(opts: ModelRunOptions): string {
  return resolve(opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd()));
}

function loadProfile(repoRoot: string, opts: ModelRunOptions): ExecutorProfile {
  try {
    // This runner is outside a host session, but use the same layered loader
    // and ambient setup path as dispatch. The host argument only influences
    // host-candidate computation; the runner resolves a command below.
    return loadLayeredProfile(repoRoot, opts.userPathOptions, activeHarness(undefined, opts.userPathOptions)).profile;
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ModelRunError(err.message);
    throw err;
  }
}

function refFor(opts: ModelRunOptions, profile: ExecutorProfile): { ref: DialRef; alias: string } {
  if (opts.model != null && opts.alias != null && opts.model !== opts.alias) {
    throw new ModelRunError(`conflicting model references: "${opts.model}" vs "${opts.alias}".`);
  }
  const raw = (opts.model ?? opts.alias ?? '').trim();
  if (raw.length === 0) throw new ModelRunError('model reference is empty — pass a registered alias.');
  let ref: DialRef;
  try {
    ref = parseDialRef(raw, 'model reference');
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ModelRunError(err.message);
    throw err;
  }
  const requestedHarness = opts.harness?.trim() || undefined;
  if (opts.harness != null && requestedHarness == null) {
    throw new ModelRunError('harness is empty — pass a declared harness id or use "model on <harness>".');
  }
  if (requestedHarness != null) {
    if (ref.harness != null && ref.harness !== requestedHarness) {
      throw new ModelRunError(`model reference harness mismatch: "${ref.harness}" vs "${requestedHarness}".`);
    }
    ref = { ...ref, harness: requestedHarness };
  }
  try {
    const resolved = resolveRegisteredModelRef(ref, profile);
    return { ref: resolved.ref, alias: resolved.alias };
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ModelRunError(err.message);
    throw err;
  }
}

function readPrompt(opts: ModelRunOptions): string {
  const hasFile = opts.promptFile != null;
  const hasPrompt = opts.prompt != null;
  if (hasFile && hasPrompt) throw new ModelRunError('conflicting prompt inputs: use either a prompt or --prompt-file, not both.');
  if (hasFile) {
    const rawPath = opts.promptFile!;
    if (rawPath.trim().length === 0) throw new ModelRunError('--prompt-file needs a readable path.');
    const path = resolve(opts.cwd ?? process.cwd(), rawPath);
    if (!existsSync(path)) throw new ModelRunError(`--prompt-file ${rawPath}: no such file.`);
    try {
      const prompt = readFileSync(path, 'utf8');
      if (prompt.trim().length === 0) throw new ModelRunError(`--prompt-file ${rawPath}: prompt is empty.`);
      return prompt;
    } catch (err) {
      if (err instanceof ModelRunError) throw err;
      throw new ModelRunError(`--prompt-file ${rawPath}: could not read file — ${(err as Error).message}`);
    }
  }
  if (!hasPrompt || opts.prompt!.trim().length === 0) {
    throw new ModelRunError('prompt is empty — pass one positional prompt, pipe it on stdin, or use --prompt-file.');
  }
  return opts.prompt!;
}

function normalizeBytes(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function validateResult(result: ModelProcessResult): ModelProcessResult {
  if (!Number.isInteger(result.exitCode) && result.exitCode !== null) {
    throw new ModelRunError(`model harness returned an invalid exit status ${JSON.stringify(result.exitCode)}.`);
  }
  return result;
}

function defaultProcess(request: ModelProcessRequest): Promise<ModelProcessResult> {
  return new Promise<ModelProcessResult>((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.argv[0]!, request.argv.slice(1), {
        cwd: request.cwd,
        env: request.env,
        stdio: [request.stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      rejectPromise(new ModelRunError(`could not start resolved command "${request.argv[0]}": ${(err as Error).message}`));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(normalizeBytes(chunk)));
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(normalizeBytes(chunk)));
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      rejectPromise(new ModelRunError(`could not start resolved command "${request.argv[0]}": ${err.message}`));
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolvePromise({ exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    if (request.stdin != null && child.stdin != null) {
      child.stdin.on('error', () => {
        // A harness closing stdin early reports its outcome through close.
      });
      child.stdin.end(request.stdin);
    }
  });
}

function commandFor(delivery: CompiledDelivery): string[] {
  if (delivery.spec.adapter !== 'command') {
    throw new ModelRunError(
      `model "${delivery.model}" resolves to a host-only/non-command delivery on ${delivery.harness ?? 'no harness'}; ` +
        'fadeno model run requires a harness command lane.',
    );
  }
  if (delivery.harness == null) {
    throw new ModelRunError(`model "${delivery.model}" resolved without a command harness.`);
  }
  const command = delivery.spec.command;
  if (command.length === 0 || command[0]?.trim().length === 0) {
    throw new ModelRunError(`model "${delivery.model}" resolved to an invalid command — its executable is empty.`);
  }
  return command;
}

/** Run one registered model without creating any dispatch state. */
export async function runModelRun(opts: ModelRunOptions): Promise<ModelRunResult> {
  const repoRoot = rootOf(opts);
  const profile = loadProfile(repoRoot, opts);
  const { ref, alias } = refFor(opts, profile);
  const prompt = readPrompt(opts);
  let delivery: CompiledDelivery;
  try {
    // A direct model run always asks for the command lane. Passing the neutral
    // standalone host prevents a host-capable harness from being mistaken for
    // an in-session delivery while preserving resolveDelivery's compilation.
    delivery = resolveDelivery(ref, profile, 'standalone');
  } catch (err) {
    if (err instanceof ExecutorProfileError) throw new ModelRunError(err.message);
    throw err;
  }
  const command = commandFor(delivery);
  const harness = delivery.harness;
  if (harness == null) throw new ModelRunError(`model "${delivery.model}" resolved without a command harness.`);
  const scratch = (() => {
    try {
      return mkdtempSync(join(tmpdir(), 'fadeno-model-run-'));
    } catch (err) {
      throw new ModelRunError(`could not create model-run scratch directory: ${(err as Error).message}`);
    }
  })();
  let promptFile: string | null = null;
  let invokedArgv = command;
  let processResult: ModelProcessResult | null = null;
  try {
    const readsFile = command.some((part) => part.includes(PROMPT_FILE_PLACEHOLDER));
    if (readsFile) {
      promptFile = join(scratch, 'prompt.txt');
      try {
        writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });
      } catch (err) {
        throw new ModelRunError(`could not write model prompt scratch file: ${(err as Error).message}`);
      }
    }
    const argv = promptFile == null ? command : substitutePromptFile(command, promptFile);
    invokedArgv = argv;
    const env = withoutHarnessIdentity(opts.env ?? process.env);
    delete env.FADENO_DISPATCH_ID;
    env.PWD = scratch;
    const runProcess = opts.runProcess ?? defaultProcess;
    try {
      processResult = validateResult(await runProcess({
        argv,
        cwd: scratch,
        env,
        stdin: readsFile ? null : Buffer.from(prompt, 'utf8'),
        promptFile,
      }));
    } catch (err) {
      if (err instanceof ModelRunError) throw err;
      throw new ModelRunError(`could not start resolved command "${argv[0]}": ${(err as Error).message}`);
    }
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch (err) {
      if (processResult == null) throw new ModelRunError(`could not remove model-run scratch directory: ${(err as Error).message}`);
      throw new ModelRunError(`model ran, but could not remove scratch directory: ${(err as Error).message}`);
    }
  }
  if (processResult == null) throw new ModelRunError('model harness returned no result.');
  return {
    model: alias,
    modelId: delivery.modelId,
    effort: delivery.effectiveEffort,
    harness,
    command: invokedArgv,
    stdout: normalizeBytes(processResult.stdout),
    stderr: normalizeBytes(processResult.stderr),
    exitCode: processResult.exitCode,
    signal: processResult.signal,
  };
}

/** Singular spelling for callers that use the command name as the function. */
export const runModel = runModelRun;

/** Plural spelling matching `runModelsAdd` and `runModelsVerify`. */
export const runModelsRun = runModelRun;
