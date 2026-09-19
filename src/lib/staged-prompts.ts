/**
 * Expiring prompt handoffs for harnesses that hide the prompt from hooks.
 *
 * This is deliberately not part of the dispatch ledger. A host stages the
 * plaintext before it calls Codex, then the spawn hook consumes the record
 * once and passes the bytes to the normal dispatch path. The token is bound
 * to the repository and claimed with an atomic rename, so a copied token,
 * replay, or concurrent consumer can never attach another prompt.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const STAGED_PROMPTS_DIR = join('.fadeno', 'local', 'staged-prompts');
export const STAGED_PROMPT_TTL_MS = 10 * 60 * 1000;
export const STAGED_TASK_DEFAULT_NAME = 'prompt';
export const STAGED_TASK_SLUG_MAX = 48;
export const STAGED_TASK_TOKEN_LENGTH = 16;
const TOKEN_RE = new RegExp(`^[a-z0-9]{${STAGED_TASK_TOKEN_LENGTH}}$`);
const STAGED_TASK_RE = new RegExp(`^([a-z0-9](?:[a-z0-9_]*[a-z0-9])?)_([a-z0-9]{${STAGED_TASK_TOKEN_LENGTH}})$`);
const CLAIM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class StagedPromptError extends Error {}

export interface StagedPromptResult {
  token: string;
  taskName: string;
  /** The Codex-safe semantic slug carried by taskName. */
  name: string;
  expiresAt: string;
}

export interface ConsumedPrompt {
  token: string;
  taskName: string;
  /** The Codex-safe semantic slug carried by taskName. */
  name: string;
  prompt: string;
}

export interface ClaimedPrompt extends ConsumedPrompt {
  /** Opaque handle used only to finalize or roll back this claim. */
  claimId: string;
}

interface StagedPromptFile {
  version: 1;
  token: string;
  name: string;
  repoKey: string;
  prompt: string;
  createdAt: number;
  expiresAt: number;
}

export function repositoryKey(repoRoot: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(repoRoot));
  } catch {
    canonical = resolve(repoRoot);
  }
  return createHash('sha256').update(canonical).digest('hex');
}

function tokenPath(repoRoot: string, token: string): string {
  return join(resolve(repoRoot), STAGED_PROMPTS_DIR, `${token}.json`);
}

function claimPath(repoRoot: string, token: string, claimId: string): string {
  return `${tokenPath(repoRoot, token)}.claimed-${claimId}`;
}

function validToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Convert a human dispatch label into Codex's lowercase task-name alphabet. */
export function semanticTaskSlug(name: string | null | undefined): string {
  const normalized = (name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, STAGED_TASK_SLUG_MAX)
    .replace(/_+$/g, '');
  return normalized || STAGED_TASK_DEFAULT_NAME;
}

export interface StagedTaskParts {
  name: string;
  token: string;
}

export function parseStagedTaskName(taskName: string): StagedTaskParts {
  const match = STAGED_TASK_RE.exec(taskName);
  if (match == null) throw new StagedPromptError(`invalid staged task_name "${taskName}"`);
  return { name: match[1]!, token: match[2]! };
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Scratch cleanup is best effort. A record that cannot be claimed is never
    // treated as a usable prompt, so deletion failure cannot cause attachment.
  }
}

function invalidStagedPrompt(taskName: string, detail: string): StagedPromptError {
  return new StagedPromptError(`staged prompt "${taskName}" is ${detail}`);
}

function validRecord(parsed: Partial<StagedPromptFile>, parts: StagedTaskParts, repoRoot: string, now: number): parsed is StagedPromptFile {
  return (
    parsed.version === 1 &&
    parsed.token === parts.token &&
    parsed.name === parts.name &&
    validToken(parsed.token) &&
    parsed.repoKey === repositoryKey(repoRoot) &&
    typeof parsed.prompt === 'string' &&
    parsed.prompt.trim().length > 0 &&
    typeof parsed.createdAt === 'number' &&
    Number.isFinite(parsed.createdAt) &&
    typeof parsed.expiresAt === 'number' &&
    Number.isFinite(parsed.expiresAt) &&
    parsed.expiresAt > now
  );
}

/** Remove expired or abandoned claim files without touching ledger evidence. */
export function cleanupStagedPrompts(repoRoot: string, now: number = Date.now()): number {
  const dir = join(resolve(repoRoot), STAGED_PROMPTS_DIR);
  if (!existsSync(dir)) return 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      chmodSync(path, 0o600);
    } catch {
      // A file that cannot be made private is removed below if it is stale;
      // otherwise consumption will fail closed rather than expose it.
    }
    if (entry.includes('.claimed-')) {
      let abandoned = false;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StagedPromptFile>;
        abandoned = typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now;
      } catch {
        abandoned = true;
      }
      if (abandoned) {
        removeQuietly(path);
        removed += 1;
      }
      continue;
    }
    if (!entry.endsWith('.json')) continue;
    let expired = false;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StagedPromptFile>;
      expired = typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= now;
    } catch {
      expired = true;
    }
    if (expired) {
      removeQuietly(path);
      removed += 1;
    }
  }
  return removed;
}

/** Store plaintext in repository-local scratch and return its Codex task name. */
export function stagePrompt(repoRoot: string, prompt: string, name?: string | null, now: number = Date.now()): StagedPromptResult {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new StagedPromptError('empty prompt: nothing to stage.');
  }
  const root = resolve(repoRoot);
  cleanupStagedPrompts(root, now);
  const semanticName = semanticTaskSlug(name);
  const expiresAt = now + STAGED_PROMPT_TTL_MS;
  const dir = join(root, STAGED_PROMPTS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomBytes(STAGED_TASK_TOKEN_LENGTH / 2).toString('hex');
    if (!validToken(token)) continue;
    const path = tokenPath(root, token);
    const record: StagedPromptFile = {
      version: 1,
      token,
      name: semanticName,
      repoKey: repositoryKey(root),
      prompt,
      createdAt: now,
      expiresAt,
    };
    // The token is random, but exclusive creation also prevents a theoretical
    // collision from overwriting another host's staged task.
    try {
      writeFileSync(path, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { token, taskName: `${semanticName}_${token}`, name: semanticName, expiresAt: new Date(expiresAt).toISOString() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new StagedPromptError('could not create a unique staged prompt token; try again.');
}

/**
 * Atomically claim and consume a staged prompt. The bytes are returned only
 * after repository, shape, and expiry checks; every failure is non-attachable.
 */
export function claimStagedPrompt(repoRoot: string, taskName: string, now: number = Date.now()): ClaimedPrompt {
  if (typeof taskName !== 'string' || taskName.length === 0) throw new StagedPromptError('no staged task_name was supplied');
  const parts = parseStagedTaskName(taskName);
  const token = parts.token;
  cleanupStagedPrompts(repoRoot, now);
  const path = tokenPath(repoRoot, token);
  if (!existsSync(path)) throw new StagedPromptError(`staged prompt "${taskName}" is missing, expired, already consumed, or belongs to another repository`);

  const claimId = randomUUID();
  const claimed = claimPath(repoRoot, token, claimId);
  try {
    renameSync(path, claimed);
  } catch {
    throw new StagedPromptError(`staged prompt "${taskName}" is missing, expired, already consumed, or belongs to another repository`);
  }

  let parsed: StagedPromptFile;
  try {
    parsed = JSON.parse(readFileSync(claimed, 'utf8')) as StagedPromptFile;
  } catch {
    removeQuietly(claimed);
    throw invalidStagedPrompt(taskName, 'malformed and cannot be used');
  }
  if (!validRecord(parsed, parts, repoRoot, now)) {
    removeQuietly(claimed);
    throw invalidStagedPrompt(taskName, 'malformed, expired, or belongs to another repository');
  }
  return { token, taskName, name: parsed.name, prompt: parsed.prompt, claimId };
}

function claimParts(taskName: string, claimId: string): StagedTaskParts {
  const parts = parseStagedTaskName(taskName);
  if (!CLAIM_ID_RE.test(claimId)) throw new StagedPromptError(`invalid staged prompt claim for "${taskName}"`);
  return parts;
}

function claimedPathAndParts(repoRoot: string, taskName: string, claimId: string): { parts: StagedTaskParts; path: string; record: StagedPromptFile } {
  const parts = claimParts(taskName, claimId);
  const path = claimPath(repoRoot, parts.token, claimId);
  let record: StagedPromptFile;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as StagedPromptFile;
  } catch {
    throw new StagedPromptError(`staged prompt "${taskName}" claim is missing or malformed`);
  }
  if (
    record.version !== 1 ||
    record.token !== parts.token ||
    record.name !== parts.name ||
    record.repoKey !== repositoryKey(repoRoot) ||
    typeof record.prompt !== 'string' ||
    record.prompt.trim().length === 0 ||
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.expiresAt)
  ) {
    throw new StagedPromptError(`staged prompt "${taskName}" claim is malformed or belongs to another repository`);
  }
  return { parts, path, record };
}

/** Permanently consume a previously claimed staged prompt after handoff succeeds. */
export function finalizeStagedPrompt(repoRoot: string, taskName: string, claimId: string): void {
  const { path: claimed } = claimedPathAndParts(repoRoot, taskName, claimId);
  if (!existsSync(claimed)) throw new StagedPromptError(`staged prompt "${taskName}" claim is missing or already finalized`);
  try {
    rmSync(claimed);
  } catch {
    throw new StagedPromptError(`staged prompt "${taskName}" could not be finalized; retry the same staged task`);
  }
}

/** Restore a claim to its original deterministic task token after a failed handoff. */
export function rollbackStagedPrompt(repoRoot: string, taskName: string, claimId: string): void {
  const { parts, path: claimed } = claimedPathAndParts(repoRoot, taskName, claimId);
  const original = tokenPath(repoRoot, parts.token);
  if (!existsSync(claimed)) throw new StagedPromptError(`staged prompt "${taskName}" claim is missing or already finalized`);
  if (existsSync(original)) throw new StagedPromptError(`staged prompt "${taskName}" could not be restored; retry the same staged task`);
  try {
    // Node has no portable rename-without-replace primitive. A hard link is
    // exclusive at the destination, and removing the claim afterward keeps a
    // racing consumer from ever seeing two usable task records.
    linkSync(claimed, original);
    unlinkSync(claimed);
  } catch {
    throw new StagedPromptError(`staged prompt "${taskName}" could not be restored; retry the same staged task`);
  }
}

/** Backwards-compatible one-shot consume for direct callers outside the hook handshake. */
export function consumeStagedPrompt(repoRoot: string, taskName: string, now: number = Date.now()): ConsumedPrompt {
  const claimed = claimStagedPrompt(repoRoot, taskName, now);
  try {
    finalizeStagedPrompt(repoRoot, taskName, claimed.claimId);
    return { token: claimed.token, taskName: claimed.taskName, name: claimed.name, prompt: claimed.prompt };
  } catch (error) {
    try {
      rollbackStagedPrompt(repoRoot, taskName, claimed.claimId);
    } catch {
      // Keep the opaque claim around for bounded cleanup if rollback itself is unavailable.
    }
    if (error instanceof StagedPromptError) throw error;
    throw new StagedPromptError(`staged prompt "${taskName}" could not be finalized; retry the same staged task`);
  }
}
