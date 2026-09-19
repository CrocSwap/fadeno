#!/usr/bin/env node
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  renderClean,
  renderDispatchDetail,
  renderDispatches,
  renderWorktrees,
  runCancel,
  runClean,
  runContext,
  runDispatch,
  runDispatchClose,
  runDispatchOpen,
  runDispatchRead,
  runDispatchStop,
  runDispatchWait,
  resolveDispatchSelector,
  type DispatchReadResult,
  runWorktrees,
  NotADispatchError,
  type OpenLane,
} from './commands/dispatches.ts';
import {
  RESERVED_ARCHETYPES,
  runDialClear,
  runDialResolve,
  runDialSetMany,
  runDialShow,
  type DialShowResult,
  type EffectiveRow,
} from './commands/dial.ts';
import { runModels, runModelsAdd, runModelsHarness, runModelsRemove, type HarnessListingResult, type ModelAddResult, type ModelRemoveResult, type ModelsResult } from './commands/models.ts';
import { runModelsVerify, type ModelsVerifyResult } from './commands/models-verify.ts';
import { runModelRun } from './commands/model-run.ts';
import { readLogsProgress, runLogs, waitForLogsChange } from './commands/logs.ts';
import { runCodexPlugin, runOmpPlugin, runPlugin } from './commands/plugin.ts';
import { knownFlagsFor, retiredFlagFor, runCompletion, runCompletionCandidates, suggestFlag, TOP_LEVEL_COMMANDS, unknownFlagsFor } from './commands/completion.ts';
import { runFeedbackAdd, runFeedbackRead } from './commands/feedback.ts';
import { runPromptClaim, runPromptConsume, runPromptFinalize, runPromptRollback, runPromptStage } from './commands/prompt-stage.ts';
import { runCodexAgentBootstrap, runSetup } from './commands/setup.ts';
import { runStatus } from './commands/status.ts';
import { roleResolutionEchoLabel } from './lib/executors.ts';
import { modelAgrees } from './lib/ledger.ts';
import { packageVersion } from './lib/paths.ts';
import { renderFocusedHelp, renderGlobalHelp, resolveHelpPath } from './lib/cli-help.ts';
import { formatAge } from './lib/contracts.ts';
import { DEFAULT_COMMAND_HEARTBEAT_MS, outputPaths, sharedFromRefusal } from './lib/spawn.ts';
import { readStdin } from './lib/stdin.ts';

export const KNOWN_CLI_COMMANDS = new Set(TOP_LEVEL_COMMANDS);

/** How long a dispatch has been open, for a line that says "ask again". */
/** The last thing a process said before it stopped, for a one-line diagnosis. */
function lastStderrLine(excerpt: string | null | undefined, max = 160): string | null {
  if (excerpt == null) return null;
  const line = excerpt.split('\n').map((l) => l.trim()).filter((l) => l !== '').at(-1);
  if (line == null) return null;
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}

/** The executor's non-zero exit code is still a failure when it wrote a report. */
function executorFailureStatus(stopped: { exit?: { code: number | null; signal: string | null } } | null | undefined): number | null {
  const exit = stopped?.exit;
  // A signal is often the intentional `cancel` path. Preserve the existing
  // wait contract for that report; an actual provider exit code is the
  // failure status that must not be turned into success.
  if (exit?.code == null || exit.code === 0) return null;
  return exit.code;
}

/** Status and the actionable stderr tail for a failed command-lane report. */
function executorFailureContext(
  name: string,
  id: string,
  stopped: { exit?: { code: number | null; signal: string | null }; stderr_excerpt?: string | null; reconstructed?: boolean } | null | undefined,
): string | null {
  const status = executorFailureStatus(stopped);
  if (status == null || stopped?.reconstructed === true) return null;
  const exit = stopped?.exit;
  const ending = exit?.signal != null ? `killed by ${exit.signal}` : `exit ${exit?.code ?? 1}`;
  const cause = lastStderrLine(stopped?.stderr_excerpt);
  return (
    `${name} failed: ${ending}` +
    (cause != null ? `; stderr ends: ${cause}` : '') +
    (stopped?.stderr_excerpt != null ? `; full stderr at ${outputPaths(id).stderr}` : '')
  );
}

function ageOf(record: { opened?: { at: string } | null }): string {
  const at = record.opened?.at;
  if (at == null) return '?';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60000));
  return formatAge(Number.isFinite(minutes) ? minutes : null);
}

function printStaleDials(stale: Array<{ archetype: string; reason: string }>): void {
  for (const item of stale) {
    console.error(
      `warning: ${item.archetype} does not resolve, so its row is omitted — ${item.reason} ` +
        `Re-dial it with \`fadeno dial ${item.archetype} <model>\`.`,
    );
  }
}

function printModels(result: ModelsResult, options: { catchAll?: boolean } = {}): void {
  // `harness`: the model's home EXECUTOR harness. One harness table under v4,
  // so this column no longer varies with the host you are sitting inside.
  const header = `${'MODEL'.padEnd(12)}  ${'PROVIDER'.padEnd(12)}  ${'ID'.padEnd(26)}  ${'EFFORT'.padEnd(8)}  HARNESS`;
  console.log(header);
  for (const row of result.models) {
    console.log(
      `${row.name.padEnd(12)}  ${(row.provider ?? '—').padEnd(12)}  ${row.id.padEnd(26)}  ${row.effort.padEnd(8)}  ${row.home_harness}`,
    );
  }
  // The catch-all, as a ROW rather than a sentence underneath the table. A
  // name the registry does not hold is not an error: it is dialed as written
  // and delivered by `unregistered_model_harness`. That is the same question
  // every row above answers, so it belongs in the same columns — `*` wherever
  // the registry would have supplied a value, and the harness that will run
  // it. Read from the profile, so a catalog that sets the key sees its own
  // answer here.
  if (options.catchAll !== false) {
    console.log(
      `${'*'.padEnd(12)}  ${'*'.padEnd(12)}  ${'*'.padEnd(26)}  ${'*'.padEnd(8)}  ${result.unregistered_model_harness}`,
    );
  }
  for (const row of result.models) {
    if (row.stale != null) console.error(`warning: ${row.name} — ${row.stale}`);
  }
}

function printModelDetail(result: ModelsResult, name: string): void {
  const row = result.models.find((r) => r.name === name);
  if (row == null) {
    console.log(
      `"${name}" is not in the registry — dialing it runs on ${result.unregistered_model_harness} with the id passed verbatim (probed at dial time). ` +
        'Declare it under models: to set a home harness or standard effort.',
    );
    return;
  }
  // One model, so no catch-all row: the question here is what THIS name
  // resolves to.
  printModels({ ...result, models: [row] }, { catchAll: false });
  console.log(`  harness: ${row.home_harness}`);
  for (const delivery of row.deliveries) {
    console.log(`  alternate: --harness ${delivery.harness} → ${delivery.id}`);
  }
  for (const [harness, id] of Object.entries(row.spellings)) {
    console.log(`  spelling: --harness ${harness} → ${id}`);
  }
}

function printModelsHarness(result: HarnessListingResult): void {
  console.log(`${result.harness} backend listing (${result.models_command.join(' ')}): ${result.models.length} model(s)`);
  for (const model of result.models) {
    const marks = model.registered_as.length > 0 ? `  ← ${model.registered_as.join(', ')}` : '';
    console.log(`  ${model.id}${marks}`);
  }
}

function printModelAdd(result: ModelAddResult): void {
  console.log(`added ${result.alias} → ${result.provider}/${result.id}`);
  console.log(`  discovery: ${result.discovery_path} matched ${result.matched_identity}`);
  console.log(`  delivery: ${result.delivery.harness} → ${result.delivery.id}`);
  console.log(`  user catalog: ${result.catalog_path}`);
  if (result.suppressed_by_project) {
    console.log('  note: this checkout has a self-contained project catalog; the alias will fall back into it per-key when its harness is declared there (dial show names any that drop).');
  }
}

function printModelRemove(result: ModelRemoveResult): void {
  console.log(`removed ${result.alias} from ${result.path}`);
  if (result.verifications_removed > 0) {
    console.log(`  verification rows dropped: ${result.verifications_removed}`);
  }
  // Stranded references go to stderr: the removal succeeded, and what is left
  // is the thing the next dispatch would otherwise discover for you.
  for (const dial of result.dangling_dials) {
    console.error(
      `warning: dial ${dial.archetype}→${dial.ref} (${dial.layer}) now names a model that is gone — re-dial with \`fadeno dial ${dial.archetype} <other>\``,
    );
  }
}

function printModelsVerify(result: ModelsVerifyResult): void {
  if (result.rows.length === 0) {
    console.log('no dialed models to verify — `fadeno dial` shows the effective table.');
    return;
  }
  console.log(`${'MODEL'.padEnd(12)}  ${'ID'.padEnd(26)}  ${'HARNESS'.padEnd(10)}  ${'OUTCOME'.padEnd(12)}  ARCHETYPES`);
  for (const row of result.rows) {
    console.log(
      `${row.model.padEnd(12)}  ${row.model_id.padEnd(26)}  ${row.harness.padEnd(10)}  ${row.outcome.padEnd(12)}  ${row.archetypes.join(', ')}`,
    );
  }
  for (const row of result.rows) {
    if (row.detail == null) continue;
    const line = `  ${row.model} on ${row.harness} — ${row.detail}`;
    if (row.outcome === 'not_listed') console.error(`error:${line}`);
    else console.log(`note:${line}`);
  }
  console.log(
    `\n${result.counts.verified} verified, ${result.counts.not_listed} not listed, ` +
      `${result.counts.unavailable} unavailable, ${result.counts.skipped} skipped`,
  );
  if (result.counts.not_listed > 0) {
    console.log('cached verification rows for the not-listed models were deleted.');
  }
}

/**
 * `model`, or `model@effort` when the dial pinned an effort the model's own
 * registry entry would not have given it.
 *
 * One helper for both renderers below: `dial` and `status` describing the same
 * dial two different ways is the failure this codebase keeps finding, and a
 * shared cell is the only durable fix. A pin that merely restates the
 * registry's default is not shown — it changes nothing, and a suffix on every
 * row is a suffix nobody reads.
 */
function modelCell(row: EffectiveRow): string {
  const pin = row.pinned_effort;
  return pin != null && pin !== row.default_effort ? `${row.model}@${pin}` : row.model;
}

/**
 * The effective table: every archetype the catalog and the dials know, and
 * where each one currently routes.
 *
 * Three columns, because three is what a reader can act on — the archetype,
 * the model it lands on, and the harness that will run it.
 *
 * The LANE is deliberately absent. It is `harness == host`, evaluated for
 * whoever asks, so from a shell — where this command is almost always run — it
 * is a constant, and a column of constants invited the one wrong reading it
 * could produce: that a dial IS a command-lane dial, when the same dial file
 * is a host dial read from inside that harness. `fadeno status` carries the
 * case a person must act on (an archetype with no lane from here), and
 * `fadeno dial resolve --archetype <name>` answers it per row.
 */
function printDialShow(result: DialShowResult): void {
  if (result.staleDials.length > 0) printStaleDials(result.staleDials);
  console.log(`${'ARCHETYPE'.padEnd(12)}  ${'MODEL'.padEnd(20)}  ${'HARNESS'.padEnd(12)}  SOURCE`);
  for (const row of result.rows) {
    // `—` for a null harness, which is `host` outside a session: the
    // cell has no value rather than the value `null`.
    const harness = (row.harness ?? '—').padEnd(12);
    // `inherits`, not `via`: `resolvedVia` is the ARCHETYPE this row borrowed
    // its dial from (`reviewer` with no dial of its own falling back to
    // `worker`), which has nothing to do with the harness column.
    const inherits = row.resolvedVia ? ` (inherits ${row.resolvedVia})` : '';
    console.log(
      `${row.archetype.padEnd(12)}  ${modelCell(row).padEnd(20)}  ${harness}  ${roleResolutionEchoLabel(row.source) ?? '—'}${inherits}`,
    );
  }
  if (result.note) console.log(result.note);
}

type Target = 'codex' | 'claude' | 'grok' | 'opencode' | 'omp';
type TargetFlags = { codex?: boolean; claude?: boolean; grok?: boolean; opencode?: boolean; omp?: boolean };

function optionalTarget(values: TargetFlags): Target | undefined {
  const selected: Target[] = [];
  if (values.codex) selected.push('codex');
  if (values.claude) selected.push('claude');
  if (values.grok) selected.push('grok');
  if (values.opencode) selected.push('opencode');
  if (values.omp) selected.push('omp');
  if (selected.length > 1) throw new Error('Choose at most one target: --codex, --claude, --grok, --opencode, or --omp.');
  return selected[0];
}

function printDispatchPreparing(values: { name?: string | null; archetype?: string | null; model?: string | null }): void {
  const details = [
    values.name?.trim() ? `name "${values.name.trim()}"` : null,
    values.archetype?.trim() ? `archetype ${values.archetype.trim()}` : null,
    values.model?.trim() ? `model ${values.model.trim()}` : null,
  ].filter((detail): detail is string => detail != null);
  const target = details.length > 0 ? ` (${details.join('; ')})` : '';
  console.error(
    `dispatch${target}: preparation underway — this dispatch has not opened a ledger row or started an executor yet.`,
  );
}

interface DispatchLaunchCliOptions {
  archetype?: string | null;
  model?: string | null;
  name?: string | null;
  shared?: boolean;
  from?: string | null;
  promptFile?: string | null;
  session?: string | null;
  parent?: string | null;
  heartbeat?: string | null;
}

/** Print the command-lane result shared by every dispatch launch spelling. */
async function runDispatchLaunch(options: DispatchLaunchCliOptions): Promise<number> {
  const policy = sharedFromRefusal(Boolean(options.shared), options.from ?? null);
  if (policy != null) {
    console.error(policy);
    return 3;
  }
  printDispatchPreparing({ name: options.name, archetype: options.archetype, model: options.model });
  const promptFile = options.promptFile;
  const outcome = await runDispatch({
    archetype: options.archetype ?? null,
    model: options.model ?? null,
    name: options.name ?? null,
    shared: Boolean(options.shared),
    from: options.from ?? null,
    promptFile,
    prompt: promptFile == null ? readStdin() : undefined,
    session: options.session ?? null,
    parent: options.parent,
    onEcho: (line) => console.error(line),
    heartbeatMs: options.heartbeat != null ? Number(options.heartbeat) * 1000 : DEFAULT_COMMAND_HEARTBEAT_MS,
  });
  if (!outcome.ok) {
    console.error(outcome.refused);
    return 3;
  }
  const r = outcome.result;
  if (r.stdout.length > 0) process.stdout.write(r.stdout.endsWith('\n') ? r.stdout : `${r.stdout}\n`);
  const ending = r.signal != null ? `killed by ${r.signal}` : `exit ${r.exitCode}`;
  const where = r.opened.workspace?.branch != null ? `branch ${r.opened.workspace.branch}` : 'shared tree';
  const empty = r.stdout.trim().length === 0;
  // The reason a run failed is in its last words, and "stderr at <path>"
  // is not the reason. Four workers died minutes apart on "Grok Build
  // usage balance exhausted" and the host read `exit 1` five times before
  // opening a file.
  const bad = r.exitCode !== 0 || r.signal != null || empty;
  const lastWords = bad ? lastStderrLine(r.stopped.stderr_excerpt) : null;
  console.error(
    `dispatch ${r.name} (${r.id}) stopped: ${ending}; ${where}` +
      (empty ? '; NO OUTPUT — the executor wrote nothing' : '') +
      (lastWords != null ? `; stderr ends: ${lastWords}` : '') +
      (r.stderrBytes > 0 ? `; full stderr at ${r.stderrPath}` : '') +
      `. Close it: fadeno dispatch-close ${r.name} --merged|--kept|--discarded|--failed|--reviewed`,
  );
  if (r.exitCode === 0 && empty) return 1;
  return r.exitCode ?? 1;
}

/** Render the one shared read result used by `dispatch` and `dispatches`. */
function printDispatchRead(read: DispatchReadResult, json: boolean, readCommand: 'dispatch' | 'dispatches'): number {
  if (read.kind === 'output') {
    const out = read.result;
    const name = out.record.opened?.name ?? out.record.id;
    const failureStatus = executorFailureStatus(out.record.stopped);
    if (out.text == null) {
      const failure = executorFailureContext(name, out.record.id, out.record.stopped);
      console.error(
        `${name}: no report recorded${out.record.state === 'open' ? ' — it is still open' : ''}.` +
          (failure == null ? '' : ` ${failure}.`),
      );
      return 1;
    }
    // A running dispatch has output but no REPORT. Handing back the stream so
    // far with nothing said is the worst answer this command can give: a proxy
    // whose Bash call was killed recovered exactly this and had to work out
    // for itself that it held an interim log. Say it on stderr so relayed
    // stdout stays verbatim.
    if (out.record.stopped == null) {
      console.error(
        `${name} has not stopped: what follows is its output so far, not a report. ` +
          `Run this again when it stops (\`fadeno ${readCommand}\` shows the state).`,
      );
    }
    if (out.source === 'final_message' && out.record.opened?.lane === 'command') {
      console.error(
        `${name}: the retained command-lane stdout transcript is unavailable; the following text is only the stopped row's bounded final-message excerpt, not the complete report. ` +
          'The full report cannot be recovered from this ledger excerpt.',
      );
    }
    if (failureStatus != null) {
      const failure = executorFailureContext(name, out.record.id, out.record.stopped);
      if (failure != null) console.error(`${failure}; report follows.`);
    }
    process.stdout.write(out.text.endsWith('\n') ? out.text : `${out.text}\n`);
    return out.record.stopped == null ? 2 : failureStatus ?? 0;
  }
  if (read.kind === 'show') {
    if (json) console.log(JSON.stringify(read.result.record));
    else for (const line of renderDispatchDetail(read.result)) console.log(line);
    return 0;
  }
  if (json) console.log(JSON.stringify(read.result));
  else for (const line of renderDispatches(read.result)) console.log(line);
  return 0;
}

/** Write activity bytes without decoding or adding a newline. */
async function writeStdoutBytes(bytes: Buffer): Promise<void> {
  if (bytes.length === 0) return;
  if (process.stdout.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      process.stdout.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      process.stdout.off('drain', onDrain);
      reject(error);
    };
    process.stdout.once('drain', onDrain);
    process.stdout.once('error', onError);
  });
}

async function main(argv: string[]): Promise<number> {
  // The generated completer places the complete COMP_WORDS vector after an
  // explicit `--` boundary. Parse this tiny protocol before node:util.parseArgs
  // so partially typed flags in that vector cannot be consumed as CLI options.
  if (argv[0] === 'completion' && argv[1] === 'candidates') {
    const separator = argv.indexOf('--', 3);
    if (separator !== 3 || argv.length <= separator + 1) {
      throw new Error('Usage: fadeno completion candidates <cword> -- <words...>');
    }
    const cword = Number(argv[2]);
    if (!Number.isInteger(cword) || cword < 0) {
      throw new Error('Usage: fadeno completion candidates <cword> -- <words...>');
    }
    const candidates = runCompletionCandidates({ cword, words: argv.slice(separator + 1) });
    if (candidates.length > 0) process.stdout.write(`${candidates.join('\n')}\n`);
    return 0;
  }
  // node:util.parseArgs treats a dash-prefixed value after a string option as
  // an ambiguous missing argument. `logs` owns a stricter positive-integer
  // contract, so turn that parser-level case into the same useful error as
  // every other invalid `--tail` spelling.
  if (argv[0] === 'logs') {
    const tailIndex = argv.findIndex((arg) => arg === '--tail');
    if (tailIndex >= 0) {
      const raw = argv[tailIndex + 1];
      if (raw == null || raw.startsWith('-')) throw new Error('--tail must be a positive integer; pass --tail <lines>.');
    }
  }
  // `--via` is gone with the driver vocabulary it belonged to. `parseArgs`
  // would answer "Unknown option" for it, which tells a reader the flag is
  // wrong but not what replaced it — and every scripted `fadeno dial … --via`
  // in the wild deserves the one-line answer. Checked before parsing, since
  // an undeclared option aborts there.
  const staleVia = argv.find((arg) => arg === '--via' || arg.startsWith('--via='));
  if (staleVia != null) {
    throw new Error(
      '`--via` was removed with catalog v4 — use `--harness <id>`. A dial names a model and, optionally, ' +
        'the harness that executes it; the driver names it took (claude-exec, opencode-direct, muse-code) ' +
        'were harnesses all along.',
    );
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        json: { type: 'boolean' },
        force: { type: 'boolean' },
        verbose: { type: 'boolean' },
        // Harness targets, for `setup`, `status` and `plugin`.
        codex: { type: 'boolean' },
        'agents-only': { type: 'boolean' },
        claude: { type: 'boolean' },
        grok: { type: 'boolean' },
        opencode: { type: 'boolean' },
        omp: { type: 'boolean' },
        // dial and models
        harness: { type: 'string' },
        user: { type: 'boolean' },
        session: { type: 'boolean' },
        repo: { type: 'boolean' },
        archetype: { type: 'string' },
        strict: { type: 'boolean' },
        // dispatch and the hooks' entry points
        model: { type: 'string' },
        name: { type: 'string' },
        from: { type: 'string' },
        shared: { type: 'boolean' },
        lane: { type: 'string' },
        parent: { type: 'string' },
        'session-id': { type: 'string' },
        'prompt-file': { type: 'string' },
        consume: { type: 'string' },
        claim: { type: 'string' },
        finalize: { type: 'string' },
        rollback: { type: 'string' },
        'claim-id': { type: 'string' },
        'prompt-sealed': { type: 'string' },
        'dry-run': { type: 'boolean' },
        'agent-id': { type: 'string' },
        'message-file': { type: 'string' },
        'agent-cwd': { type: 'string' },
        durable: { type: 'boolean' },
        transcript: { type: 'string' },
        'parent-transcript': { type: 'string' },
        heartbeat: { type: 'string' },
        // dispatch-close
        merged: { type: 'boolean' },
        kept: { type: 'boolean' },
        discarded: { type: 'boolean' },
        failed: { type: 'boolean' },
        reviewed: { type: 'boolean' },
        note: { type: 'string' },
        // feedback
        dispatch: { type: 'string' },
        // dispatch-wait
        'wait-seconds': { type: 'string' },
        // dispatches
        all: { type: 'boolean' },
        tail: { type: 'string' },
        output: { type: 'string' },
        follow: { type: 'boolean' },
        // Retired: accepted, ignored, warned. See RETIRED_FLAGS.
        timeout: { type: 'string' },
      },
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}\n`);
    console.error(renderGlobalHelp());
    return 1;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  // `parseArgs` is strict, but its option table is GLOBAL across every
  // command, so a flag declared for one command parses cleanly under any
  // other and is then silently ignored. `fadeno doctor --repo <path>`
  // consumed `--repo` as `dial`'s boolean and left the path as a stray
  // positional — reporting on the current repository while appearing to
  // inspect another one. A wrong answer that looks right is worse than an
  // error, and this was found the only way that class ever is: by noticing
  // the output described somewhere else.
  //
  // The per-command table in `completion.ts` already knew the answer; it now
  // serves both completion and validation, so the two cannot drift. An
  // unknown command answers `[]` rather than "accepts nothing", because
  // rejecting every flag of a command the registry forgot would be a worse
  // failure than the one being fixed.
  // A retired flag is accepted and does nothing, but saying nothing would let
  // a caller believe a deadline is in force. Nothing is armed; nothing will
  // stop an executor on a clock. Same wording doctor uses for `timeout_ms`.
  if (command != null && values.timeout != null && retiredFlagFor(command, '--timeout')) {
    console.error(
      'warning: `--timeout` is retired and ignored. Nothing stops an executor on a clock — a clock cannot ' +
        'tell slow from stuck. Stop work with `fadeno cancel <name|id>`. Remove the flag; it will go away.',
    );
  }
  if (command != null && values.help !== true && values.version !== true) {
    const unknown = unknownFlagsFor(command, positionals[1], Object.keys(values));
    if (unknown.length > 0) {
      const described = unknown.map((flag: string) => {
        const near = suggestFlag(command, positionals[1], flag);
        return near != null ? `${flag} (did you mean ${near}?)` : flag;
      });
      // Name what IS accepted rather than only what is not. The list is
      // short for most commands, and a reader who mistyped is one glance from
      // the answer instead of one more invocation.
      const accepted = [...(knownFlagsFor(command, positionals[1]) ?? [])].sort();
      throw new Error(
        `\`fadeno ${command}\` does not accept ${described.join(', ')}. ` +
          (accepted.length > 0 && accepted.length <= 8
            ? `It accepts: ${accepted.join(', ')}.`
            : `Run \`fadeno ${command} --help\` for what it does accept.`),
      );
    }
  }

  if (values.version) {
    console.log(packageVersion());
    return 0;
  }
  if (values.help) {
    const path = resolveHelpPath(positionals);
    console.log(path == null ? renderGlobalHelp() : renderFocusedHelp(path));
    return 0;
  }
  if (!command) {
    console.log(renderGlobalHelp());
    return 1;
  }

  switch (command) {
    case 'prompt-stage': {
      const promptFile = values['prompt-file'];
      if (positionals.length > 1) {
        throw new Error('Usage: fadeno prompt-stage [--name <semantic-name>] [--prompt-file <path> | stdin] [--json], or fadeno prompt-stage --consume|--claim|--finalize|--rollback <task_name> --json');
      }
      const lifecycle = [values.consume, values.claim, values.finalize, values.rollback].filter((value): value is string => typeof value === 'string');
      if (lifecycle.length > 1) throw new Error('Usage: choose exactly one of --consume, --claim, --finalize, or --rollback.');
      if (values.consume != null) {
        if (promptFile != null || values.name != null || values.consume.trim() === '' || values.json !== true) {
          throw new Error('Usage: fadeno prompt-stage --consume <task_name> --json');
        }
        const consumed = runPromptConsume({ taskName: values.consume });
        console.log(JSON.stringify({ ok: true, token: consumed.token, name: consumed.name, task_name: consumed.taskName, prompt: consumed.prompt }));
        return 0;
      }
      if (values.claim != null) {
        if (promptFile != null || values.name != null || values.claim.trim() === '' || values.json !== true || values['claim-id'] != null) {
          throw new Error('Usage: fadeno prompt-stage --claim <task_name> --json');
        }
        const claimed = runPromptClaim({ taskName: values.claim });
        console.log(JSON.stringify({ ok: true, token: claimed.token, name: claimed.name, task_name: claimed.taskName, claim_id: claimed.claimId, prompt: claimed.prompt }));
        return 0;
      }
      if (values.finalize != null || values.rollback != null) {
        const taskName = values.finalize ?? values.rollback;
        if (promptFile != null || values.name != null || taskName == null || taskName.trim() === '' || typeof values['claim-id'] !== 'string' || values['claim-id'].trim() === '' || values.json !== true) {
          throw new Error(`Usage: fadeno prompt-stage --${values.finalize != null ? 'finalize' : 'rollback'} <task_name> --claim-id <id> --json`);
        }
        const options = { taskName, claimId: values['claim-id'] };
        if (values.finalize != null) runPromptFinalize(options);
        else runPromptRollback(options);
        console.log(JSON.stringify({ ok: true, task_name: taskName }));
        return 0;
      }
      const staged = runPromptStage({ name: values.name ?? null, promptFile, prompt: promptFile == null && !process.stdin.isTTY ? readStdin() : undefined });
      if (values.json) {
        console.log(JSON.stringify({ ok: true, token: staged.token, name: staged.name, task_name: staged.taskName, expires_at: staged.expiresAt }, null, 2));
      } else {
        console.log(`name: ${staged.name}`);
        console.log(`staged Codex prompt: ${staged.token}`);
        console.log(`task_name: ${staged.taskName}`);
        console.log(`expires_at: ${staged.expiresAt}`);
      }
      return 0;
    }
    case 'setup': {
      const target = optionalTarget(values);
      if (target === 'grok' || target === 'opencode' || target === 'omp') {
        throw new Error('`fadeno setup` supports --codex or --claude; Grok, OpenCode, and omp have no user-scoped setup.');
      }
      if (values['agents-only']) {
        if (target !== 'codex') throw new Error('`fadeno setup --agents-only` requires --codex.');
        if (values.from || values.force) {
          throw new Error('`fadeno setup --codex --agents-only` does not link a CLI, so it does not accept --from or --force.');
        }
        const result = runCodexAgentBootstrap();
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else for (const notice of result.notices) console.log(notice);
        return 0;
      }
      // `--from <bin-dir>` names the directory the CLI lives in, the same
      // shape the plugin launcher publishes; the link points at the file.
      const from = values.from != null ? join(String(values.from), 'fadeno') : undefined;
      const result = runSetup({ target: target ?? null, source: from, force: Boolean(values.force) });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      console.log(`Fadeno setup (${result.target ?? 'standalone'})`);
      console.log(`  link ${result.link.action}: ${result.link.path} -> ${result.link.target}`);
      for (const probe of result.probes) {
        console.log(`  ${probe.name}: ${probe.available ? `available${probe.version ? ` (${probe.version})` : ''}` : 'not found'}`);
      }
      for (const notice of result.notices) console.log(`  ${notice}`);
      return 0;
    }
    case 'status': {
      const target = optionalTarget(values);
      if (target === 'grok') throw new Error('`fadeno status` reports the host it is inside; --grok names no host integration.');
      const result = runStatus({ verbose: Boolean(values.verbose), target: target ?? null });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      console.log(`Fadeno ${result.version} · host ${result.harness ?? 'unknown'} · ${result.repoRoot}`);
      console.log(
        `cli: ${result.link.state === 'linked' ? `${result.link.path} -> ${result.link.target}` : `${result.link.state} at ${result.link.path}`}`,
      );
      console.log('routing:');
      console.log(`  ${'ARCHETYPE'.padEnd(12)} ${'MODEL'.padEnd(20)} ${'LANE'.padEnd(8)} SOURCE`);
      for (const row of result.routing) {
        // Status keeps the lane: this is the command whose job is what needs
        // a person, and `no lane` is the one routing fact that does.
        const lane = row.deliverable ? row.lane : 'no lane';
        console.log(`  ${row.archetype.padEnd(12)} ${modelCell(row).padEnd(20)} ${lane.padEnd(8)} ${roleResolutionEchoLabel(row.source) ?? '—'}`);
      }
      if (result.attention.length === 0) {
        console.log('attention: nothing');
      } else {
        console.log('attention:');
        for (const item of result.attention) console.log(`  - ${item}`);
      }
      if (result.verbose) console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    case 'clean': {
      for (const line of renderClean(runClean({ force: values.force }))) console.log(line);
      return 0;
    }
    case 'plugin': {
      if (values.omp) {
        const { outDir, results } = runOmpPlugin({ outDir: positionals[1], force: values.force });
        const counts = { created: 0, overwritten: 0, appended: 0, skipped: 0 };
        for (const r of results) counts[r.status] += 1;
        console.log(`Generated Fadeno omp plugin in ${outDir}`);
        console.log(`  ${counts.created} created, ${counts.overwritten} overwritten, ${counts.skipped} skipped.`);
        // Marketplace root is the repo root (where .omp-plugin/marketplace.json
        // lives), not the plugin dir — pass `.`, not the payload path.
        console.log('\nTest it: `omp plugin marketplace add . && omp plugin install fadeno@fadeno`');
        return 0;
      }
      if (values.grok || values.opencode) {
        throw new Error('The --grok and --opencode targets are supported by init only; no plugin generator exists for them.');
      }
      const codex = Boolean(values.codex);
      const { outDir, results } = codex
        ? runCodexPlugin({ outDir: positionals[1], force: values.force })
        : runPlugin({ outDir: positionals[1], force: values.force });
      const counts = { created: 0, overwritten: 0, appended: 0, skipped: 0 };
      for (const r of results) counts[r.status] += 1;
      console.log(`Generated Fadeno ${codex ? 'Codex' : 'Claude Code'} plugin in ${outDir}`);
      console.log(`  ${counts.created} created, ${counts.overwritten} overwritten, ${counts.skipped} skipped.`);
      if (codex) {
        // Marketplace root is the repo root (where .agents/plugins/marketplace.json
        // lives), not the plugin dir — pass `.`, not the payload path.
        console.log('\nTest it: `codex plugin marketplace add . && codex plugin add fadeno@fadeno`');
      } else {
        console.log('\nTest it: `claude --plugin-dir ' + relative(process.cwd(), outDir) + '`');
      }
      return 0;
    }
    case 'completion': {
      if (positionals[1] !== 'bash' || positionals.length > 2) {
        throw new Error('Usage: fadeno completion bash');
      }
      process.stdout.write(runCompletion());
      return 0;
    }
    case 'model':
    case 'models': {
      if (positionals[1] === 'run') {
        if (positionals.length < 3) {
          throw new Error('Usage: fadeno model run <ref[@effort][ on <harness>]> [<prompt>...] [--prompt-file <path>]');
        }
        if (values.json) throw new Error('`fadeno model run` emits the harness streams verbatim and does not support --json.');
        const promptArgs = positionals.slice(3);
        if (promptArgs.length > 0 && values['prompt-file'] != null) {
          throw new Error('conflicting prompt inputs: use either a positional prompt or --prompt-file, not both.');
        }
        const stdin = process.stdin.isTTY ? '' : readStdin();
        if (promptArgs.length > 0 && stdin.length > 0) {
          throw new Error('conflicting prompt inputs: both a positional prompt and stdin were provided.');
        }
        if (promptArgs.length === 0 && values['prompt-file'] != null && stdin.length > 0) {
          throw new Error('conflicting prompt inputs: both --prompt-file and stdin were provided.');
        }
        const result = await runModelRun({
          model: positionals[2]!,
          harness: values.harness ?? null,
          prompt: promptArgs.length > 0 ? promptArgs.join(' ') : values['prompt-file'] != null ? null : stdin,
          promptFile: values['prompt-file'] ?? null,
        });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        return result.exitCode ?? 1;
      }
      if (positionals[1] === 'add') {
        if (positionals.length !== 4 || values.harness != null) {
          throw new Error('Usage: fadeno model add <alias> <provider/id> [--json]');
        }
        const result = runModelsAdd({ alias: positionals[2]!, discoveryId: positionals[3]! });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printModelAdd(result);
        return 0;
      }
      if (positionals[1] === 'remove') {
        if (positionals.length !== 3 || values.harness != null) {
          throw new Error('Usage: fadeno model remove <alias> [--force] [--json]');
        }
        const result = runModelsRemove({ alias: positionals[2]!, force: Boolean(values.force) });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printModelRemove(result);
        return 0;
      }
      if (positionals[1] === 'verify') {
        const result = runModelsVerify({
          refs: positionals.slice(2),
          harness: values.harness ?? null,
          strict: Boolean(values.strict),
        });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printModelsVerify(result);
        return result.ok ? 0 : 1;
      }
      if (values.harness != null) {
        if (positionals.length > 1) throw new Error('Usage: fadeno models --harness <id>  (no positional with --harness)');
        const result = runModelsHarness({ harness: values.harness });
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printModelsHarness(result);
        return 0;
      }
      if (positionals.length > 2) throw new Error('Usage: fadeno models [<name>] [--harness <id>] [--json]');
      const result = runModels({});
      const name = positionals[1];
      if (values.json) {
        console.log(JSON.stringify(name != null ? { ...result, models: result.models.filter((r) => r.name === name) } : result, null, 2));
        return 0;
      }
      if (name != null) printModelDetail(result, name);
      else printModels(result);
      return 0;
    }
    case 'dial': {
      const sub = positionals[1];
      if (sub == null) {
        const result = runDialShow({});
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else printDialShow(result);
        return 0;
      }
      if (sub === 'clear') {
        if (positionals.length > 3) throw new Error('Usage: fadeno dial clear [<archetype>] [--session|--user|--repo]');
        const archetype = positionals[2] ?? null;
        const result = runDialClear({ archetype, session: Boolean(values.session), user: Boolean(values.user), repo: Boolean(values.repo) });
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        if (result.archetype == null) {
          if (result.removed) {
            const layers = result.cleared_layers;
            const detail = layers != null && (layers.session > 0 || layers.user > 0)
              ? ` (${[layers.session > 0 ? `${layers.session} session` : null, layers.user > 0 ? `${layers.user} user` : null].filter(Boolean).join(', ')})`
              : '';
            console.log(`cleared ${result.count ?? 0} dial(s)${detail}`);
          } else {
            console.log('no dials to clear');
          }
          if ((result.repo_pins_remaining?.length ?? 0) > 0) {
            console.log(`repo pins remain (committed): ${result.repo_pins_remaining!.join(', ')} — remove per archetype with \`fadeno dial clear <archetype> --repo\``);
          }
          return 0;
        }
        if (!result.removed) {
          if (result.livesAt === 'repo') {
            console.log(`no session dial for ${result.archetype}; ${result.archetype} is repo-pinned — 'fadeno dial clear ${result.archetype} --repo' to remove it (repo pins are committed config, never cleared implicitly)`);
          } else {
            console.log(`no dial for ${result.archetype} at any layer — nothing to clear`);
          }
          return 0;
        }
        console.log(`cleared ${result.archetype} (${result.cleared})${result.inferred ? ' [user default — the only layer holding a dial]' : ''}`);
        return 0;
      }
      if (sub === 'resolve') {
        const usage = 'Usage: fadeno dial resolve --archetype <name>';
        if (!values.archetype) throw new Error(usage);
        if (positionals.length > 2) throw new Error(usage);
        console.log(JSON.stringify(runDialResolve({ archetype: values.archetype }), null, 2));
        return 0;
      }
      // Otherwise `sub` names an archetype: one row, or a set.
      if (RESERVED_ARCHETYPES.has(sub)) {
        throw new Error(`archetype "${sub}" is a reserved word — rename the archetype`);
      }
      if (positionals.length === 2) {
        const result = runDialShow({});
        const row = result.rows.find((r) => r.archetype === sub);
        const filtered: DialShowResult = {
          ...result,
          rows: row ? [row] : [],
          staleDials: result.staleDials.filter((stale) => stale.archetype === sub),
          dials: {
            session: Object.hasOwn(result.dials.session, sub) ? { [sub]: result.dials.session[sub]! } : {},
            repo: Object.hasOwn(result.dials.repo, sub) ? { [sub]: result.dials.repo[sub]! } : {},
            user: Object.hasOwn(result.dials.user, sub) ? { [sub]: result.dials.user[sub]! } : {},
          },
        };
        if (values.json) console.log(JSON.stringify(filtered, null, 2));
        else printDialShow(filtered);
        return 0;
      }
      if (positionals.length >= 3) {
        // Set: every positional but the last names archetypes (space, `+`,
        // and `,` separated all work); the last is the model.
        const model = positionals[positionals.length - 1]!;
        const archetypes = positionals
          .slice(1, -1)
          .flatMap((token) => token.split(/[+,]/))
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        const results = runDialSetMany({ archetypes, model, harness: values.harness ?? null, session: Boolean(values.session), user: Boolean(values.user), repo: Boolean(values.repo) });
        if (values.json) {
          console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
          return 0;
        }
        for (const result of results) {
          console.log(result.narrative);
          for (const note of result.notes) {
            if (note.startsWith('WARNING:')) console.error(note);
            else console.log(note);
          }
        }
        return 0;
      }
      throw new Error('Usage: fadeno dial [<archetype> [<model>[@effort] [--harness <id>] [--session|--user|--repo]] | clear [<archetype>] [--session|--user|--repo] | resolve --archetype <name>]');
    }
    case 'dispatch': {
      const [, first, selector] = positionals;
      const isRun = first === 'run';
      const launchOptionsPresent = [
        values.name,
        values['prompt-file'],
        values.shared,
        values.from,
        values['session-id'],
        values.parent,
        values.heartbeat,
      ].some((value) => value != null && value !== false);
      const launchSelectorPresent = values.archetype != null || values.model != null;
      const readOptionsPresent = values.all === true || values.tail != null || values.output != null || values.json === true;

      if (isRun) {
        if (positionals.length > 3) {
          throw new Error('Usage: fadeno dispatch run <archetype-or-model> [launch options], or fadeno dispatch run --archetype|--model <selector> [launch options].');
        }
        if (selector != null && launchSelectorPresent) {
          throw new Error('fadeno dispatch run cannot combine a positional selector with --archetype or --model; use one selector form.');
        }
        if (readOptionsPresent) {
          throw new Error('fadeno dispatch run accepts launch options, not --all, --tail, --json, or --output; use `fadeno dispatch` for reads.');
        }
        let launch: DispatchLaunchCliOptions = {
          archetype: values.archetype ?? null,
          model: values.model ?? null,
          name: values.name ?? null,
          shared: Boolean(values.shared),
          from: values.from ?? null,
          promptFile: values['prompt-file'] ?? null,
          session: values['session-id'] ?? null,
          parent: values.parent ?? null,
          heartbeat: values.heartbeat ?? null,
        };
        if (selector != null) {
          const resolved = resolveDispatchSelector({ selector });
          launch = resolved.kind === 'archetype'
            ? { ...launch, archetype: resolved.archetype, model: null }
            : { ...launch, archetype: null, model: resolved.model };
        } else if (!launchSelectorPresent) {
          throw new Error('Usage: fadeno dispatch run <archetype-or-model> [launch options], or fadeno dispatch run --archetype|--model <selector> [launch options].');
        }
        return runDispatchLaunch(launch);
      }

      if (launchSelectorPresent || launchOptionsPresent) {
        if (first != null) {
          throw new Error(`fadeno dispatch cannot combine positional read selector "${first}" with launch selectors or launch options; use fadeno dispatch run ${first} for a positional launch.`);
        }
        if (readOptionsPresent) {
          throw new Error('fadeno dispatch launch forms cannot combine --all, --tail, --json, or --output; use `fadeno dispatch` without --archetype/--model for reads.');
        }
        return runDispatchLaunch({
          archetype: values.archetype ?? null,
          model: values.model ?? null,
          name: values.name ?? null,
          shared: Boolean(values.shared),
          from: values.from ?? null,
          promptFile: values['prompt-file'] ?? null,
          session: values['session-id'] ?? null,
          parent: values.parent ?? null,
          heartbeat: values.heartbeat ?? null,
        });
      }

      if (positionals.length > 2) {
        throw new Error('Usage: fadeno dispatch [--all] [--tail <count>] [--json], fadeno dispatch <name|id> [--json], or fadeno dispatch --output <name|id>.');
      }
      return printDispatchRead(runDispatchRead({
        ref: first ?? null,
        output: values.output ?? null,
        tail: values.tail != null ? Number(values.tail) : undefined,
        all: Boolean(values.all),
      }), Boolean(values.json), 'dispatch');
    }
    case 'dispatch-open': {
      if (!values.archetype) {
        throw new Error(
          'Usage: fadeno dispatch-open --archetype <name> [--name <n>] [--model <ref>] [--lane auto|host|command] [--shared] [--from <dispatch-name|id|ref|sha>] ' +
            '[--session-id <id>] [--parent <id> | --parent-transcript <path>] [--harness <id>] [--agent-id <id>] ' +
            '(--prompt-file <path> | stdin | --prompt-sealed <reason> | --dry-run) [--json]',
        );
      }
      const policy = sharedFromRefusal(Boolean(values.shared), values.from ?? null);
      if (policy != null) {
        if (values.json) console.log(JSON.stringify({ ok: false, refused: policy }));
        else console.error(policy);
        return 3;
      }
      const promptFile = values['prompt-file'];
      const promptSealed = values['prompt-sealed'] ?? null;
      const outcome = runDispatchOpen({
        archetype: values.archetype,
        model: values.model ?? null,
        name: values.name ?? null,
        shared: Boolean(values.shared),
        from: values.from ?? null,
        promptFile,
        // Nothing is read from stdin when the harness sealed the prompt: there
        // is no prompt to read, and a hook that opened a pipe it never fills
        // would hang the spawn it is supposed to be waving through.
        prompt: promptSealed != null || promptFile != null ? undefined : readStdin(),
        promptSealed,
        agentId: values['agent-id'] ?? null,
        dryRun: Boolean(values['dry-run']),
        session: values['session-id'] ?? null,
        parent: values.parent,
        harness: values.harness ?? null,
        parentTranscript: values['parent-transcript'] ?? null,
        lane: (values.lane ?? 'auto') as OpenLane,
      });
      if (!outcome.ok) {
        if (values.json) console.log(JSON.stringify({ ok: false, refused: outcome.refused }));
        else console.error(outcome.refused);
        return 3;
      }
      if (values.json) {
        console.log(JSON.stringify(outcome));
        return 0;
      }
      if (!outcome.opened && 'dryRun' in outcome) {
        console.log(
          `${outcome.archetype} resolves to ${outcome.model}${outcome.effort ? `@${outcome.effort}` : ''}${outcome.harness ? ` on ${outcome.harness}` : ''} ` +
            `on the ${outcome.lane} lane${outcome.deliverable ? '' : ', which cannot be delivered from here'}. Nothing was opened.`,
        );
        console.log(outcome.nag);
        return 0;
      }
      if (!outcome.opened) {
        console.log(
          `${outcome.archetype} resolves to ${outcome.model}${outcome.effort ? `@${outcome.effort}` : ''}${outcome.harness ? ` on ${outcome.harness}` : ''}, a command lane: nothing opened here. The dispatch proxy runs:`,
        );
        console.log(`  ${outcome.relay.command}`);
        console.log(outcome.nag);
        return 0;
      }
      console.log(
        `${outcome.name} (${outcome.id}) opened on the host lane: ` +
          `${outcome.model}${outcome.effort ? `@${outcome.effort}` : ''}${outcome.harness ? ` on ${outcome.harness}` : ''}`,
      );
      console.log(`  work in: ${outcome.cwd}${outcome.workspace.branch ? ` (${outcome.workspace.branch})` : ' (shared tree)'}`);
      console.log('  the contract-bearing prompt is in the --json output; the hook hands it to the agent.');
      console.log(outcome.nag);
      return 0;
    }
    case 'dispatch-stop': {
      const [, ref] = positionals;
      const transcript = values.transcript ?? null;
      const agentId = values['agent-id'] ?? null;
      if (!ref && !transcript && !agentId) {
        throw new Error('Usage: fadeno dispatch-stop [<name|id>] [--agent-id <id>] [--transcript <path>] [--message-file <path> | stdin] [--agent-cwd <dir>] [--durable] [--json] — an agent id or a transcript can name the dispatch itself.');
      }
      const messageFile = values['message-file'];
      let stopped;
      try {
        stopped = runDispatchStop({
          ref: ref ?? null,
          agentId,
          transcript,
          messageFile,
          message: messageFile == null && !process.stdin.isTTY ? readStdin() : null,
          agentCwd: values['agent-cwd'] ?? null,
          durableOnly: Boolean(values.durable),
        });
      } catch (err) {
        // Not a dispatch: the stop hook fires for every subagent, and one that
        // carried no contract has nothing to record. Exit 4 says so without noise.
        if (err instanceof NotADispatchError) {
          if (values.json) console.log(JSON.stringify({ ok: false, dispatch: null, reason: err.message }));
          else console.error(err.message);
          return 4;
        }
        throw err;
      }
      const name = stopped.record.opened?.name ?? stopped.record.id;
      const dirty = stopped.row.dirty === 'unavailable' ? 'unreadable' : stopped.row.dirty.paths.length === 0 ? 'clean' : `${stopped.row.dirty.paths.length} dirty path(s)`;
      if (values.json) {
        console.log(JSON.stringify({
          ok: true,
          id: stopped.record.id,
          name,
          replayed: stopped.replayed,
          dirty: stopped.row.dirty,
          mismatchedCwd: stopped.mismatchedCwd,
          model: stopped.record.opened?.model ?? null,
          modelObserved: stopped.row.model_observed ?? null,
          modelMismatch: !modelAgrees(stopped.record.opened?.model, stopped.row.model_observed, stopped.record.opened?.model_id),
          inspectionPending: stopped.row.evidence === 'durable',
        }));
        return 0;
      }
      const asked = stopped.record.opened?.model ?? null;
      const ran = stopped.row.model_observed ?? null;
      const modelNote = !modelAgrees(asked, ran, stopped.record.opened?.model_id) ? `; WARNING: ran on ${ran}, the dial asked for ${asked}` : '';
      console.log(
        `${name} stopped${stopped.replayed ? ' (already recorded)' : ''}; ${stopped.row.evidence === 'durable' ? 'worktree inspection deferred' : `tree ${dirty}`}` +
          (stopped.mismatchedCwd != null ? `; WARNING: the agent worked in ${stopped.mismatchedCwd}, not its assigned worktree` : '') +
          modelNote +
          `. Close it: fadeno dispatch-close ${name} --merged|--kept|--discarded|--failed|--reviewed`,
      );
      return 0;
    }
    case 'dispatch-close': {
      const [, ref] = positionals;
      const verbs = (['merged', 'kept', 'discarded', 'failed', 'reviewed'] as const).filter((verb) => values[verb]);
      if (!ref || verbs.length !== 1) {
        throw new Error('Usage: fadeno dispatch-close <name|id> --merged|--kept|--discarded|--failed|--reviewed [--note <text>] — exactly one verb.');
      }
      const closed = runDispatchClose({ ref, verb: verbs[0]!, note: values.note ?? null, force: Boolean(values.force) });
      const name = closed.record.opened?.name ?? closed.record.id;
      // A forced close is stated plainly. It is a legitimate move — the work
      // may well have landed by a squash — but a record that does not show the
      // check was overridden is a record that cannot be audited later.
      if (closed.forced != null) console.error(`--force: closed anyway over the check. ${closed.forced}`);
      console.log(
        `${name} closed: ${closed.verb}${closed.replayed ? ' (already recorded)' : ''}` +
          (closed.branch != null
            ? `; branch ${closed.branch} kept${closed.worktree != null ? `, worktree ${closed.worktree} stays until fadeno clean` : ''}`
            : ''),
      );
      if (closed.verb === 'merged' && closed.merge != null && !closed.merge.checked && closed.merge.reason != null) {
        console.error(`(not verified: ${closed.merge.reason})`);
      }
      return 0;
    }
    case 'cancel': {
      const [, ref] = positionals;
      if (!ref) throw new Error('Usage: fadeno cancel <name|id>');
      const outcome = await runCancel({ ref });
      if (!outcome.ok) {
        console.error(outcome.message);
        return 1;
      }
      const name = outcome.record.opened?.name ?? outcome.record.id;
      const signalDescription = outcome.method === 'cooperative'
        ? 'launcher cooperatively signalled process group'
        : 'signalled process group';
      console.log(
        `cancelled ${name}: ${signalDescription} ${outcome.processGroup}` +
          (outcome.stoppedRecorded ? '; stop recorded' : '; its launcher recorded the stop') +
          `. Close it: fadeno dispatch-close ${name} --failed|--kept|--discarded|--reviewed`,
      );
      return 0;
    }
    case 'worktrees': {
      const entries = runWorktrees();
      if (values.json) console.log(JSON.stringify(entries));
      else for (const line of renderWorktrees(entries)) console.log(line);
      return 0;
    }
    case 'context': {
      const context = runContext();
      if (values.json) console.log(JSON.stringify(context));
      else console.log(context.text);
      return 0;
    }
    case 'dispatch-wait': {
      const refs = positionals.slice(1);
      if (refs.length === 0) throw new Error('Usage: fadeno dispatch-wait <name|id>... [--wait-seconds <n>] [--json]');
      const seconds = values['wait-seconds'] == null ? undefined : Number(values['wait-seconds']);
      if (seconds != null && (!Number.isFinite(seconds) || seconds < 0)) {
        throw new Error('--wait-seconds takes a non-negative number of seconds.');
      }
      const outcome = await runDispatchWait({ refs, waitSeconds: seconds });
      const nameOf = (r: { id: string; opened?: { name: string } | null }) => r.opened?.name ?? r.id.slice(0, 8);
      const name = nameOf(outcome.record);
      // What is STILL running, when several were named: the caller's next call
      // should ask for those and not for the one it just collected.
      const others = outcome.waiting.map(nameOf);
      const stillWaiting = others.length === 0 ? '' : ` Still running: ${others.join(' ')} — \`fadeno dispatch-wait ${others.join(' ')}\`.`;
      if (values.json) console.log(JSON.stringify(outcome, null, 2));
      if (outcome.state === 'stopped') {
        // Exit 0 means "here is the report". A dispatch that stopped and left
        // nothing is a different ending needing a different action, and
        // answering it with 0 and an empty stdout is how four disk-killed
        // workers were relayed to their proxies as finished.
        const s = outcome.record.stopped;
        // A reconstructed row means the launcher was killed before it could
        // record anything, so how the executor ended is unknown. Said plainly
        // both ways round: an absent exit code must not read as a clean one,
        // and a recovered report must not read as one this call watched
        // arrive.
        const how = s?.reconstructed === true
          ? ' (its launcher was killed before it could record the stop, so how it ended is unknown)'
          : s?.exit == null
            ? ''
            : s.exit.signal != null
              ? ` (killed by ${s.exit.signal})`
              : ` (exit ${s.exit.code})`;
        const failureStatus = executorFailureStatus(s);
        const failure = executorFailureContext(name, outcome.record.id, s);
        if (outcome.text == null) {
          if (!values.json) {
            const why = lastStderrLine(s?.stderr_excerpt);
            const w = s?.work;
            const held = w == null
              ? ''
              : w.commits === 0
                ? ' Its branch holds no commits HEAD lacks.'
                : ` Its branch holds ${w.commits} commit(s) HEAD does not have (${w.files} file(s), +${w.insertions} -${w.deletions}).`;
            console.error(
              `${name} stopped${how} and recorded NO REPORT.` +
                (why != null ? ` Its stderr ends: ${why}` : '') +
                held +
                ` Read \`fadeno dispatches ${name}\` for what its branch holds, then close it.${stillWaiting}`,
            );
          }
          return 5;
        }
        if (!values.json) {
          // stderr, never stdout: what follows on stdout is the report
          // verbatim, because a proxy relays it.
          if (s?.reconstructed === true) console.error(`${name} stopped${how}; its report was recovered from what it left on disk, and follows.${stillWaiting}`);
          else if (failure != null) console.error(`${failure}; its report follows.${stillWaiting}`);
          else if (refs.length > 1) console.error(`${name} stopped; its report follows.${stillWaiting}`);
          process.stdout.write(outcome.text.endsWith('\n') ? outcome.text : `${outcome.text}\n`);
        }
        // A report is still the executor's stdout, but a non-zero executor is
        // not success. Preserve the report bytes on stdout and carry the
        // provider failure through the command status and stderr context.
        return failureStatus ?? 0;
      }
      // Still running when the bound elapsed. Exit 2, the same code
      // `dispatches --output` uses for "not finished". The message is one
      // instruction, because the only thing a caller can usefully do is ask
      // again. There is no third ending: a dead group with no stop row is
      // reconstructed into one above rather than reported as a loss.
      if (!values.json) {
        const which = outcome.waiting.length > 1
          ? `${outcome.waiting.length} dispatches are still running (${others.join(', ')})`
          : `${name} is still running (${ageOf(outcome.record)} in)`;
        console.error(`${which}. Run this command again.`);
      }
      return 2;
    }
    case 'feedback': {
      const text = positionals.slice(1).join(' ').trim();
      if (text.length === 0) {
        const read = runFeedbackRead();
        if (values.json) console.log(JSON.stringify(read, null, 2));
        else if (!read.exists) console.log(`no feedback recorded — \`fadeno feedback "<what happened>"\` starts ${read.path}.`);
        else process.stdout.write(read.text!.endsWith('\n') ? read.text! : `${read.text!}\n`);
        return 0;
      }
      const added = runFeedbackAdd({ text, dispatch: values.dispatch ?? null });
      if (values.json) console.log(JSON.stringify(added, null, 2));
      else console.log(`recorded in ${added.path} (${added.total} entr${added.total === 1 ? 'y' : 'ies'}).`);
      return 0;
    }
    case 'logs': {
      const ref = positionals[1];
      if (ref == null || positionals.length !== 2) {
        throw new Error('Usage: fadeno logs <name|id> [--tail <lines>] [--follow]');
      }
      const source = runLogs({ ref, tail: values.tail ?? null, follow: Boolean(values.follow) });
      await writeStdoutBytes(source.initial);
      if (!source.follow) return 0;
      for (;;) {
        const progress = readLogsProgress(source);
        await writeStdoutBytes(progress.chunk);
        if (progress.stopped && progress.drained) return 0;
        await waitForLogsChange(source, progress.token);
      }
    }
    case 'dispatches': {
      const [, ref] = positionals;
      return printDispatchRead(runDispatchRead({
        ref: ref ?? null,
        output: values.output ?? null,
        tail: values.tail != null ? Number(values.tail) : undefined,
        all: Boolean(values.all),
      }), Boolean(values.json), 'dispatches');
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(renderGlobalHelp());
      return 1;
  }
}

const _isMain = (() => {
  try {
    if ((import.meta as any).main) return true;
  } catch {}
  const a1 = process.argv[1];
  if (!a1) return false;
  return a1.endsWith('src/cli.ts') || a1.endsWith('dist/cli.js') || a1.endsWith('/fadeno') || a1.endsWith('/fadeno.cmd') || a1.endsWith('/fadeno.js');
})();
if (_isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    },
  );
}
