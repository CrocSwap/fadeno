import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { HostDispatchError, readHostDispatchRequest } from '../lib/host-dispatch.ts';
import { HostWorkspaceError, readHostWorkspaceState } from '../lib/host-workspace.ts';
import { findRepoRoot } from '../lib/paths.ts';
import { sha256Hex } from '../lib/artifact-manifest.ts';

export class DispatchPromptError extends Error {}

export interface DispatchPromptOptions {
  run: string;
  dispatchId: string;
  cwd?: string;
  repoRoot?: string;
}

export interface DispatchPromptResult {
  run: string;
  dispatchId: string;
  promptPath: string;
  promptSha256: string;
  /** Exact prompt bytes read from the immutable snapshot. */
  prompt: Buffer;
  /** Canonical envelope: header + immutable ids + prompt bytes. */
  envelope: Buffer;
  workspaceMode: 'shared' | 'isolated';
  workspace: string | null;
  baseCommit: string | null;
}

/**
 * Emit the canonical engine delivery envelope for a host dispatch request.
 *
 * The envelope is the exact bytes a coordinator delivers to a host agent:
 *
 *   # Fadeno engine step assignment
 *
 *   run: <run>
 *   dispatch_id: <dispatch-id>
 *
 *   <recorded prompt bytes>
 *
 * The run and dispatch_id are immutable identities from the ledger, not
 * caller-supplied text. The prompt bytes are the recorded snapshot verbatim,
 * not re-rendered. The method authenticates the snapshot's sha256 against the
 * request's prompt_sha256 so a tampered prompt cannot be delivered as
 * immutable.
 */
export function runDispatchPrompt(opts: DispatchPromptOptions): DispatchPromptResult {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? findRepoRoot(cwd);
  const run = opts.run?.trim();
  const dispatchId = opts.dispatchId?.trim();
  if (!run || !dispatchId) {
    throw new DispatchPromptError('dispatch-prompt needs <run> and <dispatch-id>.');
  }

  let lookup;
  try {
    lookup = readHostDispatchRequest({ run, dispatchId, repoRoot, cwd });
  } catch (err) {
    if (err instanceof HostDispatchError) throw new DispatchPromptError(err.message);
    throw err;
  }

  const request = lookup.request;
  // Resolve prompt file relative to runDir, with traversal guard
  const runAbsolute = resolve(lookup.runDir);
  const promptRel = request.promptPath;
  if (isAbsolute(promptRel)) {
    throw new DispatchPromptError(`prompt snapshot must be run-relative, not absolute: ${promptRel}`);
  }
  const promptAbs = resolve(runAbsolute, promptRel);
  const rel = relative(runAbsolute, promptAbs).split('\\').join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new DispatchPromptError(`prompt snapshot escapes its run directory: ${promptRel}`);
  }
  // Immutable snapshots may not traverse a symlink, even one whose current
  // target remains inside the run. Otherwise retargeting it after this check
  // would change the bytes represented by the recorded path.
  let cursor = runAbsolute;
  try {
    for (const segment of rel.split('/')) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) {
        throw new DispatchPromptError(`prompt snapshot traverses a symlink: ${promptRel}`);
      }
    }
    const realRel = relative(realpathSync(runAbsolute), realpathSync(promptAbs)).split('\\').join('/');
    if (realRel === '..' || realRel.startsWith('../') || isAbsolute(realRel)) {
      throw new DispatchPromptError(`prompt snapshot escapes its run directory: ${promptRel}`);
    }
  } catch (err) {
    if (err instanceof DispatchPromptError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DispatchPromptError(`prompt snapshot is missing: ${promptRel}`);
    }
    throw new DispatchPromptError(`cannot inspect prompt snapshot ${promptRel}: ${(err as Error).message}`);
  }

  let promptBytes: Buffer;
  try {
    promptBytes = readFileSync(promptAbs);
  } catch (err) {
    throw new DispatchPromptError(`cannot read prompt snapshot ${promptRel}: ${(err as Error).message}`);
  }
  const computed = sha256Hex(promptBytes);
  if (computed !== request.promptSha256) {
    throw new DispatchPromptError(
      `prompt snapshot sha256 mismatch for ${dispatchId}: expected ${request.promptSha256}, got ${computed} (prompt at ${promptRel})`,
    );
  }

  let workspaceMode: 'shared' | 'isolated' = 'shared';
  let workspace: string | null = null;
  let baseCommit: string | null = null;
  try {
    const prepared = readHostWorkspaceState(repoRoot, lookup.runId, request.dispatchId);
    if (prepared != null) {
      workspaceMode = 'isolated';
      workspace = resolve(repoRoot, prepared.workspace);
      baseCommit = prepared.base_commit;
    }
  } catch (err) {
    if (err instanceof HostWorkspaceError) {
      workspaceMode = 'shared';
      workspace = null;
      baseCommit = null;
    } else {
      throw err;
    }
  }

  const header = (() => {
    if (workspaceMode === 'isolated' && workspace != null) {
      return Buffer.from(
        `# Fadeno engine step assignment\n\nrun: ${lookup.runId}\ndispatch_id: ${request.dispatchId}\nworkspace_mode: isolated\nworkspace: ${workspace}\n\nAll repository reads and writes for this assignment must occur in the workspace above; do not read or modify the shared checkout.\n\n`,
        'utf8',
      );
    }
    return Buffer.from(
      `# Fadeno engine step assignment\n\nrun: ${lookup.runId}\ndispatch_id: ${request.dispatchId}\n\n`,
      'utf8',
    );
  })();
  const envelope = Buffer.concat([header, promptBytes]);

  return {
    run: lookup.runId,
    dispatchId,
    promptPath: promptRel,
    promptSha256: computed,
    prompt: promptBytes,
    envelope,
    workspaceMode,
    workspace,
    baseCommit,
  };
}
