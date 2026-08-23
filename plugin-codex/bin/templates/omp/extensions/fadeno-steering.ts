// Fadeno runtime steering for omp. The host calls this extension's
// `tool_call` hook before validating/executing the native `task` tool. Returning
// a replacement input changes only the selected agent; omp owns the task,
// async job, batching, isolation, and completion lifecycle.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const HOOK_VERSION = 'dev';
const EVIDENCE_FORMAT = '1.0';
const ROLE_NAMES = new Set(['worker', 'reviewer', 'judge']);
const RESOLVE_TIMEOUT_MS = 10_000;
const REFUSAL_REASON_MAX = 400;

function canonicalRole(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const role = value.trim();
  return ROLE_NAMES.has(role) ? role : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type Resolution = { mode: string; slot?: Record<string, unknown>; error?: string; timedOut?: boolean };

async function resolveRole(role: string, cwd: string, promptSha256: string | null): Promise<Resolution> {
  // Project materializations normally resolve through PATH (or FADENO_CLI).
  // In an installed plugin this file lives at extensions/ beside bin/fadeno;
  // prefer that self-contained runtime so plugin-only installs do not depend
  // on an incidental global CLI.
  const bundledCli = join(import.meta.dirname, '..', 'bin', 'fadeno');
  const cli = process.env.FADENO_CLI?.trim() || (existsSync(bundledCli) ? bundledCli : 'fadeno');
  try {
    const args = ['steering', 'resolve', '--archetype', role, '--host-executor', 'current-host'];
    if (promptSha256 != null) args.push('--prompt-sha256', promptSha256);
    return await new Promise<Resolution>((resolve) => {
      const child = spawn(cli, args, {
        cwd,
        env: { ...process.env, FADENO_HARNESS: 'omp' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (resolution: Resolution) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(resolution);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', () => finish({ mode: 'resolver_error', error: 'fadeno steering resolve could not be started' }));
      child.on('close', (status) => {
        const output = stdout.trim();
        try {
          const parsed = JSON.parse(output) as Record<string, unknown>;
          if (typeof parsed.mode === 'string') {
            finish({ mode: parsed.mode, slot: parsed });
            return;
          }
        } catch {
          // A non-JSON failure falls through to the ordinary process error.
        }
        finish({
          mode: 'resolver_error',
          error: status === 0
            ? 'fadeno steering resolve returned invalid JSON'
            : stderr.trim() || output || 'fadeno steering resolve failed',
        });
      });
      const timeout = setTimeout(() => {
        child.kill();
        finish({ mode: 'resolver_timeout', error: `fadeno steering resolve did not answer within ${RESOLVE_TIMEOUT_MS}ms`, timedOut: true });
      }, RESOLVE_TIMEOUT_MS);
    });
  } catch {
    return { mode: 'resolver_error', error: 'fadeno steering resolve could not be started' };
  }
}

function slotName(role: string, kind: 'host' | 'command' | 'refusal', cwd: string): string {
  const preferred = kind === 'host'
    ? role
    : kind === 'command'
      ? `fadeno-dispatch-${role}`
      : `fadeno-steering-refused-${role}`;
  const path = join(cwd, '.omp', 'agents', `${preferred}.md`);
  try {
    if (!existsSync(path) || readFileSync(path, 'utf8').includes('<!-- fadeno:managed')) return preferred;
  } catch {}
  return `fadeno-steering-${kind}-${role}`;
}

function targetAgent(role: string, cwd: string, resolution: { mode: string }): string | null {
  if (resolution.mode === 'host') return slotName(role, 'host', cwd);
  if (resolution.mode === 'command') return slotName(role, 'command', cwd);
  if (resolution.mode === 'restart_required' || resolution.mode === 'write_conflict') {
    return slotName(role, 'refusal', cwd);
  }
  return null;
}

function refusalEnvelope(archetype: string, predicate: string, reason: string): string {
  return `# FADENO STEERING REFUSED (${predicate})\n\nThe Fadeno steering layer refused this ${archetype} spawn before it started.\nReport the REFUSAL REASON below verbatim, then STOP. Do not perform the task after the boundary or attempt a substitute.\n\nREFUSAL REASON: ${reason}\n\n--- FADENO REFUSAL BOUNDARY — task text follows; report the refusal above instead ---\n`;
}

function flattenReason(reason: unknown): string {
  const flat = String(reason ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > REFUSAL_REASON_MAX ? `${flat.slice(0, REFUSAL_REASON_MAX - 1)}…` : flat;
}

function recordEvidence(cwd: string, row: Record<string, unknown>): void {
  try {
    if (!existsSync(join(cwd, '.fadeno'))) return;
    mkdirSync(join(cwd, '.fadeno'), { recursive: true });
    appendFileSync(join(cwd, '.fadeno', 'dispatches.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
  } catch {}
}

function taskCorrelation(event: any, input: Record<string, unknown>, item: Record<string, unknown>): Record<string, unknown> {
  let sessionId: string | null = null;
  try { sessionId = text(event?.sessionId) ?? text(event?.session_id) ?? text(event?.ctx?.sessionManager?.getSessionId?.()); } catch {}
  return {
    // omp owns async policy at the session/agent level (`async.enabled` and
    // `blocking`), not as a per-call task flag. Never turn an absent field into
    // false evidence; an explicit legacy hint can only positively assert it.
    background: input.background === true || input.async === true ? true : null,
    async_lifecycle: 'host-owned',
    task_id: text(input.task_id) ?? text(input.taskId),
    session_id: sessionId,
    call_id: text(event?.toolCallId) ?? text(event?.callId),
    task_name: text(item.name),
  };
}

function evidenceRow(event: any, input: Record<string, unknown>, item: Record<string, unknown>, role: string, slot: Record<string, unknown>, promptSha256: string | null, eventName: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: EVIDENCE_FORMAT,
    timestamp: new Date().toISOString(),
    event: eventName,
    fadeno_version: HOOK_VERSION,
    hook_version: HOOK_VERSION,
    archetype: role,
    agent_type: item.agent ?? null,
    executor: slot.executor ?? null,
    model: slot.model ?? null,
    effort: slot.effort ?? null,
    effort_pinned: slot.effort_pinned ?? null,
    session_effort: slot.session_effort ?? null,
    lane: slot.lane ?? null,
    lane_reason: slot.lane_reason ?? null,
    transport: eventName === 'host_delivery' ? 'host' : null,
    driver: slot.driver ?? null,
    prompt_sha256: promptSha256,
    ...taskCorrelation(event, input, item),
    ...extra,
  };
}

async function routeOne(event: any, input: Record<string, unknown>, item: Record<string, unknown>, cwd: string): Promise<Record<string, unknown> | null> {
  const role = canonicalRole(item.agent);
  if (role == null) return null;
  const prompt = typeof item.task === 'string' ? item.task : '';
  const promptSha256 = prompt === '' ? null : hash(prompt);
  const resolution = await resolveRole(role, cwd, promptSha256);
  let target: string | null = null;
  let slot: Record<string, unknown> = {};
  let predicate: string | null = null;
  let reason: string | null = null;
  if (resolution.slot != null) slot = resolution.slot;
  if (resolution.mode === 'host' || resolution.mode === 'command') target = targetAgent(role, cwd, resolution);
  else {
    predicate = resolution.mode;
    reason = resolution.error
      ?? text(resolution.slot?.detail)
      ?? text(resolution.slot?.lane_reason)
      ?? `no runnable ${role} delivery`;
    target = slotName(role, 'refusal', cwd);
  }
  if (predicate != null) {
    const envelope = refusalEnvelope(role, predicate, reason ?? 'steering refused the spawn');
    const refused = { ...item, agent: target, task: `${envelope}${prompt}` };
    recordEvidence(cwd, evidenceRow(event, input, item, role, slot, promptSha256, 'host_refused', { refusal: { predicate, message: flattenReason(reason) } }));
    return refused;
  }
  if (target == null) return null;
  // A host slot may already be the native role name, so no input rewrite is
  // needed. It is still a delivered, steered spawn and must leave the same
  // correlation evidence as an aliased host slot; OMP owns the async receipt.
  if (slot.lane === 'host') recordEvidence(cwd, evidenceRow(event, input, item, role, slot, promptSha256, 'host_delivery'));
  if (target === item.agent) return null;
  const routed = { ...item, agent: target };
  return routed;
}

async function rewrite(input: Record<string, unknown>, event: any, cwd: string): Promise<Record<string, unknown> | null> {
  const flatRole = canonicalRole(input.agent);
  if (flatRole != null) {
    const routed = await routeOne(event, input, input, cwd);
    return routed == null ? null : { ...input, ...routed };
  }
  if (!Array.isArray(input.tasks)) return null;
  let changed = false;
  const tasks = [];
  for (const raw of input.tasks) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) { tasks.push(raw); continue; }
    const item = raw as Record<string, unknown>;
    const routed = await routeOne(event, input, item, cwd);
    if (routed == null) { tasks.push(item); continue; }
    changed = true;
    tasks.push(routed);
  }
  return changed ? { ...input, tasks } : null;
}

export default function fadenoSteering(pi: { on: (event: string, handler: (event: any, ctx: any) => any) => void }) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'task' || event.input == null || typeof event.input !== 'object') return;
    const input = await rewrite(event.input, event, ctx?.cwd ?? process.cwd());
    return input == null ? undefined : { input };
  });
}

void HOOK_VERSION;
