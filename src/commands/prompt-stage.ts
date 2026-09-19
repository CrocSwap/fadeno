/**
 * The public two-phase handoff for Codex prompts. Stage stores only expiring
 * scratch; consume is used by the Codex hook to recover the bytes before the
 * normal host- or command-lane dispatch path runs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findRepoRoot } from '../lib/paths.ts';
import {
  claimStagedPrompt,
  consumeStagedPrompt,
  finalizeStagedPrompt,
  rollbackStagedPrompt,
  stagePrompt,
  type ClaimedPrompt,
  type ConsumedPrompt,
  type StagedPromptResult,
} from '../lib/staged-prompts.ts';

export class PromptStageError extends Error {}

export interface PromptStageOptions {
  cwd?: string;
  repoRoot?: string;
  /** Human label; it is slugged into Codex's task_name alphabet. */
  name?: string | null;
  prompt?: string | null;
  promptFile?: string | null;
  now?: number;
}

export interface PromptConsumeOptions {
  cwd?: string;
  repoRoot?: string;
  taskName: string;
  now?: number;
}

export interface PromptClaimOptions {
  cwd?: string;
  repoRoot?: string;
  taskName: string;
  now?: number;
}

export interface PromptClaimFinalizeOptions {
  cwd?: string;
  repoRoot?: string;
  taskName: string;
  claimId: string;
}

function repositoryRoot(opts: { cwd?: string; repoRoot?: string }): string {
  return resolve(opts.repoRoot ?? findRepoRoot(opts.cwd ?? process.cwd()));
}

/** Stage prompt bytes without creating a dispatch, worktree, or ledger row. */
export function runPromptStage(opts: PromptStageOptions = {}): StagedPromptResult {
  if (opts.promptFile != null && opts.promptFile.trim() !== '') {
    const path = resolve(opts.cwd ?? process.cwd(), opts.promptFile);
    if (!existsSync(path)) throw new PromptStageError(`--prompt-file ${opts.promptFile}: no such file.`);
    return stagePrompt(repositoryRoot(opts), readFileSync(path, 'utf8'), opts.name, opts.now);
  }
  if (typeof opts.prompt === 'string') return stagePrompt(repositoryRoot(opts), opts.prompt, opts.name, opts.now);
  throw new PromptStageError('no prompt: pass --prompt-file <path> or pipe the prompt on stdin.');
}

/** Consume one exact Codex task name and return its staged plaintext. */
export function runPromptConsume(opts: PromptConsumeOptions): ConsumedPrompt {
  return consumeStagedPrompt(repositoryRoot(opts), opts.taskName, opts.now);
}

/** Claim one staged task without deleting it; the caller must finalize or roll back. */
export function runPromptClaim(opts: PromptClaimOptions): ClaimedPrompt {
  return claimStagedPrompt(repositoryRoot(opts), opts.taskName, opts.now);
}

/** Finalize a successful staged handoff. */
export function runPromptFinalize(opts: PromptClaimFinalizeOptions): void {
  finalizeStagedPrompt(repositoryRoot(opts), opts.taskName, opts.claimId);
}

/** Restore a staged task after a downstream handoff failure. */
export function runPromptRollback(opts: PromptClaimFinalizeOptions): void {
  rollbackStagedPrompt(repositoryRoot(opts), opts.taskName, opts.claimId);
}
