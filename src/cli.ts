#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import {
  runDispatch,
} from './commands/dispatch.ts';
import {
  runDispatches,
  runDispatchesCancel,
  runDispatchesBakeoffs,
  runDispatchesOutput,
  relayQuarantineNotice,
  runDispatchesWithdraw,
  type DispatchesResult,
  runDispatchesMerge,
} from './commands/dispatches.ts';
import { renderExecutorStderr } from './lib/diagnostics.ts';
import {
  
  formatShadowLine,
  runDialClear,
  runDialSetMany,
  runDialClearShadow,
  runDialResolve,
  runDialShadow,
  runDialShow,
  runShadowShow,
  
  type DialShowResult,
} from './commands/dial.ts';
import { runModels, runModelsAdd, runModelsHarness, runModelsRemove, type HarnessListingResult, type ModelAddResult, type ModelRemoveResult, type ModelsResult } from './commands/models.ts';
import { runModelsVerify, type ModelsVerifyResult } from './commands/models-verify.ts';
import { runCodexPlugin, runOmpPlugin, runPlugin } from './commands/plugin.ts';
import { IGNORED_DEADLINE_NOTE_TOKEN } from './lib/executors.ts';
import { knownFlagsFor, retiredFlagFor, runCompletion, runCompletionCandidates, suggestFlag, TOP_LEVEL_COMMANDS, unknownFlagsFor } from './commands/completion.ts';
import { runDispatchClose, runDispatchOpen } from './commands/dispatch-adhoc.ts';
import { mergeBackReapplyCommand } from './lib/workspace-baseline.ts';
import {
  classifyIgnoredOutput,
  describeIgnoredOutput,
  ignoredOutputSignalOrder,
  ignoredOutputVerdict,
} from './lib/receipt-attestations.ts';
import { runSetup } from './commands/setup.ts';
import { runStatus } from './commands/status.ts';
import { runClean, runCleanWindows } from './commands/clean.ts';
import { packageVersion } from './lib/paths.ts';
import { readInstallationManifest, syncManagedRuntime } from './lib/installations.ts';
import { userPaths } from './lib/user-paths.ts';
import { renderFocusedHelp, renderGlobalHelp, resolveHelpPath } from './lib/cli-help.ts';
import { UNREADABLE_WINDOW_LOG_ID } from './lib/receipt-attestations.ts';

export const KNOWN_CLI_COMMANDS = new Set(TOP_LEVEL_COMMANDS);

export function shouldRunPreflight(command: string | undefined): boolean {
  if (!command) return false;
  const excluded = new Set(['status', 'setup', 'uninstall']);
  if (excluded.has(command)) return false;
  if (!KNOWN_CLI_COMMANDS.has(command)) return false;
  return true;
}

export function resolveRuntimeSyncCandidate(
  env: NodeJS.ProcessEnv,
  argv1: string | undefined,
  paths: ReturnType<typeof userPaths>,
  manifest: ReturnType<typeof readInstallationManifest>,
): { sourceDir: string; trustSource: boolean } | null {
  if (env.FADENO_BUNDLED_RUNTIME && existsSync(join(env.FADENO_BUNDLED_RUNTIME, 'fadeno'))) {
    return { sourceDir: env.FADENO_BUNDLED_RUNTIME, trustSource: true };
  }
  if (argv1) {
    try {
      const dir = dirname(resolve(argv1));
      const parent = dirname(dir);
      const candidates = [join(parent, '.claude-plugin', 'plugin.json'), join(parent, '.codex-plugin', 'plugin.json')];
      let isFadeno = false;
      for (const cand of candidates) {
        try {
          if (existsSync(cand)) {
            const p = JSON.parse(readFileSync(cand, 'utf8')) as { name?: unknown };
            if (p.name === 'fadeno') { isFadeno = true; break; }
          }
        } catch {}
      }
      if (isFadeno && existsSync(join(dir, 'fadeno'))) {
        return { sourceDir: dir, trustSource: true };
      }
    } catch {}
  }
  if (argv1) {
    try {
      const resolvedArgv = resolve(argv1);
      const managedDir = resolve(paths.managedRuntimeDir);
      const isManaged = resolvedArgv === resolve(paths.managedCli) || dirname(resolvedArgv) === managedDir || resolvedArgv.startsWith(managedDir + sep);
      if (isManaged) {
        const src = manifest.runtime?.source;
        if (src && existsSync(src) && existsSync(join(src, 'fadeno'))) {
          return { sourceDir: src, trustSource: false };
        }
        return null;
      }
    } catch {}
  }
  return null;
}

export function maybeRunRuntimePreflight(
  _argv: string[],
  command: string | undefined,
  deps: {
    env?: NodeJS.ProcessEnv;
    argv1?: string;
    paths?: ReturnType<typeof userPaths>;
    manifest?: ReturnType<typeof readInstallationManifest>;
    syncFn?: typeof syncManagedRuntime;
  } = {},
): void {
  if (!shouldRunPreflight(command)) return;
  try {
    const env = deps.env ?? process.env;
    const argv1 = deps.argv1 ?? process.argv[1];
    const paths = deps.paths ?? userPaths();
    const manifest = deps.manifest ?? readInstallationManifest();
    const candidate = resolveRuntimeSyncCandidate(env, argv1, paths, manifest);
    if (!candidate) return;
    if (manifest.runtime == null) return;
    const sync = deps.syncFn ?? syncManagedRuntime;
    const res = sync(paths, candidate.sourceDir, manifest, {
      allowInstall: false,
      trustSource: candidate.trustSource,
      force: false,
    });
    if (res.outcome === 'refreshed') {
      console.error(`fadeno: managed runtime ${res.from} -> ${res.to} refreshed at ${paths.managedRuntimeDir}`);
    }
  } catch (err) {
    try {
      console.error(`fadeno: managed runtime sync warning: ${(err as Error).message}`);
    } catch {}
  }
}

/**
 * Clear one shadow attachment, or every one when `archetype` is null.
 *
 * ONE renderer for two spellings — `fadeno dial clear-shadow` and
 * `fadeno shadow clear`. Shadows only ever live in `.fadeno/local/dials`, so
 * neither spelling takes a scope flag, and a second copy of this output is
 * exactly how the two would start disagreeing about what was cleared.
 */
function clearShadow(archetype: string | null, json: boolean): number {
  const result = runDialClearShadow({ archetype });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.archetype == null) {
    console.log(result.removed ? `cleared ${result.count} shadow attachment(s)` : 'no shadow attachments to clear (.fadeno/local/dials)');
    return 0;
  }
  console.log(`cleared shadow attachment: ${result.archetype} (was ${result.cleared!.model});`);
  return 0;
}

function printDispatches(result: DispatchesResult): void {
  if (result.lines.length === 0) {
    console.log(result.summary);
    return;
  }
  for (const line of result.lines) console.log(line);
  console.log(`\n${result.summary}`);
}

const DIAL_SOURCE_TEXT: Record<string, string> = {
  binding: 'binding',
  session: 'session dial',
  repo: 'repo pin',
  user: 'user dial',
  base: 'base',
};

function printStaleShadows(stale: Array<{ archetype: string; target: string }>): void {
  for (const item of stale) {
    console.error(
      `warning: shadow attachment ${item.archetype}~${item.target} names a model that is no longer resolvable — run \`fadeno dial shadow ${item.archetype} <model>\` or \`fadeno dial clear-shadow ${item.archetype}\`; the attachment is ignored below.`,
    );
  }
}

function printStaleDials(stale: Array<{ archetype: string; target: string }>): void {
  for (const item of stale) {
    console.error(`warning: dial ${item.archetype}→${item.target} is stale — re-dial with \`fadeno dial ${item.archetype} <model>\``);
  }
}

function printModels(result: ModelsResult): void {
  // `harness`: the model's home EXECUTOR harness. One harness table under v4,
  // so this column no longer varies with the host you are sitting inside.
  const header = `${'model'.padEnd(12)}  ${'provider'.padEnd(12)}  ${'id'.padEnd(26)}  ${'effort'.padEnd(8)}  harness`;
  console.log(header);
  for (const row of result.models) {
    console.log(
      `${row.name.padEnd(12)}  ${(row.provider ?? '—').padEnd(12)}  ${row.id.padEnd(26)}  ${row.effort.padEnd(8)}  ${row.home_harness}`,
    );
  }
  for (const row of result.models) {
    if (row.stale != null) console.error(`warning: ${row.name} — ${row.stale}`);
  }
  console.log(
    `\nany other name runs on ${result.unregistered_model_harness} — id passed verbatim, probed at dial time`,
  );
  if (result.listable_harnesses.length > 0) {
    console.log(`live backend listings: fadeno models --harness <${result.listable_harnesses.join('|')}>`);
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
  printModels({ ...result, models: [row] });
  console.log(`  harness: ${row.home_harness}`);
  for (const delivery of row.deliveries) {
    console.log(`  alternate: --harness ${delivery.harness} → ${delivery.id}${delivery.variant != null ? ` [variant ${delivery.variant}]` : ''}`);
  }
  for (const [harness, id] of Object.entries(row.spellings)) {
    console.log(`  spelling: --harness ${harness} → ${id}`);
  }
  for (const [archetype, state] of Object.entries(row.eligibility)) {
    if (state !== 'eligible') console.log(`  eligibility: ${archetype} → ${state}`);
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
  for (const shadow of result.dangling_shadows) {
    console.error(
      `warning: shadow attachment ${shadow.archetype}~${shadow.ref} now names a model that is gone — \`fadeno dial clear-shadow ${shadow.archetype}\``,
    );
  }
}

function printModelsVerify(result: ModelsVerifyResult): void {
  if (result.rows.length === 0) {
    console.log('no dialed models to verify — `fadeno dial` shows the effective table.');
    return;
  }
  console.log(`${'model'.padEnd(12)}  ${'id'.padEnd(26)}  ${'harness'.padEnd(10)}  ${'outcome'.padEnd(12)}  archetypes`);
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
 * `emptyMessage` is for the shadow-filtered view: an effective table with zero
 * rows reads as broken (a bare header, nothing under it), where the full `dial`
 * table never has zero rows (the worker/reviewer/judge triad always shows).
 * When set and there is nothing to show, it replaces the header+rows entirely
 * rather than printing beside an empty table.
 */
function printDialShow(result: DialShowResult, emptyMessage?: string): void {
  if (result.legacy_pin_note) console.log(result.legacy_pin_note);
  if (result.staleDials.length > 0) printStaleDials(result.staleDials);
  if (result.staleShadows.length > 0) printStaleShadows(result.staleShadows);
  if (result.rows.length === 0 && emptyMessage != null) {
    console.log(emptyMessage);
    if (result.note) console.log(result.note);
    return;
  }
  // Header
  // `harness` is the EXECUTOR, and under v4 that is the only thing this word
  // means anywhere: the ambient host travels as `host`, on its own key. The
  // column used to be called `via` precisely because `harness` was taken.
  // `(home)` marks a row whose DIAL named no harness — the registry answered,
  // whether through the provider's home claim or a model-level `harness:`.
  // `lane` sits between the harness and the source because it is what the two
  // columns to its left decide together and neither shows: effort moves a
  // delivery off the host lane only when PINNED, and the harness only when it
  // is not this session's host. A reader who has to infer the lane from those
  // two gets it wrong in exactly the cases that matter, and a preflight is
  // where that inference gets acted on — a director read this table plus a
  // shell `steering resolve`, concluded no host delegate existed, and routed a
  // five-lane campaign onto the command lane.
  //
  // Same `decideLane` as `dial resolve` and as the resolution echo's
  // `[command lane: …]` label; see `EffectiveRow.lane`.
  const header = `${'archetype'.padEnd(12)}  ${'model'.padEnd(18)}  ${'effort'.padEnd(8)}  ${'harness'.padEnd(22)}  ${'lane'.padEnd(9)}  source`;
  console.log(header);
  for (const row of result.rows) {
    const arch = row.archetype.padEnd(12);
    const model = row.modelDisplay.padEnd(18);
    // The PIN, never the resolved effort. Once the delivery lane depends on
    // whether the user pinned an effort, printing the registry default in
    // this column says "xhigh" for both `dial worker opus` and
    // `dial worker opus@xhigh` — two dials that now deliver differently.
    // `inherit` rather than `—`: `—` already means "not applicable" in this
    // column (the fallback row below), and an unpinned dial is not
    // effort-less, it takes its effort from elsewhere — the session on the
    // host lane, the model's declared default on the command lane. `inherit`
    // is also the one word that cannot be mistaken for a value, unlike
    // `default`, which is a literal effort in the vocabulary.
    const effort = (row.resolvedVia != null ? '—' : row.pinned_effort ?? 'inherit').padEnd(8);
    // `—` for a null harness, which is `current-host` with no host: the cell
    // has no value rather than the value `null`. Same dash this table already
    // uses for a not-applicable effort.
    const harness = (row.harness == null ? '—' : `${row.harness}${row.harness_explicit ? '' : ' (home)'}`).padEnd(22);
    const elig = row.eligibility === 'shadow_only' ? '  SHADOW-ONLY (never gates)' : row.eligibility === 'forbidden' ? '  FORBIDDEN (refused at dispatch)' : '';
    // `inherits`, not `via`: `resolvedVia` is the ARCHETYPE this row borrowed
    // its dial from (`reviewer` with no dial of its own falling back to
    // `worker`), which has nothing to do with the harness column two cells
    // left. Printing both as "via" on one line was the collision that kept
    // the column named `harness` in the first place.
    const inherits = row.resolvedVia ? ` (inherits ${row.resolvedVia})` : '';
    // `restart` rather than `restart_required`: the column is 9 wide and the
    // full value is the one lane nobody can act on anyway — the reason for it
    // is one `--json` away. `host` and `command` print in full, because those
    // two are what a reader is deciding between.
    const lane = (row.lane === 'restart_required' ? 'restart' : row.lane).padEnd(9);
    console.log(`${arch}  ${model}  ${effort}  ${harness}  ${lane}  ${DIAL_SOURCE_TEXT[row.source] ?? row.source}${inherits}${elig}`);
    if (row.shadow) console.log(formatShadowLine(row.shadow, '  '));
  }
  // One line, once, when any shadow is shown. The shadow row reads as a
  // property of the archetype; its scope is narrower than that, and a reader
  // of this table is exactly the person who would otherwise assume a playbook
  // run pairs too. See the same note at attach time.
  if (result.rows.some((row) => row.shadow)) {
    console.log('  (shadows roll on ad-hoc `fadeno dispatch` only; `fadeno drive` runs are unpaired)');
  }
  if (result.note) console.log(result.note);
}

const SHADOW_EMPTY_MESSAGE =
  'no active shadow attachments — attach one with `fadeno shadow <archetype> <model> [--rate <r>] [--n <count>]`';

/**
 * Shared handler for `fadeno dial shadow ...` and its top-level alias
 * `fadeno shadow ...` — both spellings call this, so they cannot drift. The
 * caller has already validated the positional shape (0 extra = show mode, 2
 * extra = attach, 1 extra = usage error, refused before this is reached).
 */
function runShadowCommand(
  archetype: string | undefined,
  model: string | undefined,
  opts: { harness: string | null; rate?: string; n?: string; json: boolean },
): number {
  if (archetype == null) {
    const result = runShadowShow({});
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    printDialShow(result, SHADOW_EMPTY_MESSAGE);
    return 0;
  }
  const result = runDialShadow({ archetype, model: model!, harness: opts.harness, rate: opts.rate, n: opts.n });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  for (const note of result.notes) console.log(note);
  const rate = result.rate != null ? ` [rate ${result.rate}]` : '';
  const budget = result.n != null ? ` [${result.remaining}/${result.n} triggers remaining]` : '';
  console.log(`shadow attached: ${result.archetype} ~ ${result.refString} on ${result.harness}${rate}${budget}`);
  if (result.previous) {
    const previousBudget = result.previous.n != null
      ? result.previous.remaining === 0
        ? ` expired after ${result.previous.n} triggers`
        : ` ${result.previous.remaining}/${result.previous.n} triggers remaining`
      : '';
    console.log(`  (was ${result.previous.model}${result.previous.rate ? ` rate ${result.previous.rate}` : ''}${previousBudget})`);
  }
  // Said at attach time, because the dial reads like a property of the
  // ARCHETYPE and is not one. `fadeno drive` never rolls a pair — shadow
  // sampling lives in the ad-hoc dispatch kernel — so an archetype dialed here
  // pairs when someone runs `fadeno dispatch`, and does not when the same
  // archetype is dispatched by a playbook run. Left undisclosed, this is a
  // dial that silently does nothing for half the system.
  console.log(
    `  scope: ad-hoc \`fadeno dispatch\` only. Engine runs (\`fadeno drive\`) do not roll shadow pairs, ` +
      `so ${result.archetype} steps inside a playbook run are unpaired.`,
  );
  return 0;
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

function main(argv: string[]): number {
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
        'were harnesses all along. See docs/experimental/harness-neutral-dials.md.',
    );
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        codex: { type: 'boolean' },
        claude: { type: 'boolean' },
        grok: { type: 'boolean' },
        opencode: { type: 'boolean' },
        omp: { type: 'boolean' },
        force: { type: 'boolean' },
        strict: { type: 'boolean' },
        'with-hooks': { type: 'boolean' },
        'with-steering': { type: 'boolean' },
        'no-steering': { type: 'boolean' },
        'data-only': { type: 'boolean' },
        'non-interactive': { type: 'boolean' },
        timeout: { type: 'string' }, // retired: accepted, ignored, warned. See RETIRED_FLAGS.
        from: { type: 'string' },
        'reset-runtime': { type: 'boolean' },
        all: { type: 'boolean' },
        'purge-user-data': { type: 'boolean' },
        project: { type: 'boolean' },
        verbose: { type: 'boolean' },
        scope: { type: 'string' },
        schema: { type: 'string' },
        format: { type: 'string' },
        step: { type: 'string' },
        status: { type: 'string' },
        event: { type: 'string' },
        artifact: { type: 'string' },
        report: { type: 'string' },
        member: { type: 'string' },
        field: { type: 'string', multiple: true },
        actor: { type: 'string' },
        iteration: { type: 'string' },
        inline: { type: 'boolean' },
        'no-record': { type: 'boolean' },
        bind: { type: 'string', multiple: true },
        unbind: { type: 'string', multiple: true },
        'max-transitions': { type: 'string' },
        parallel: { type: 'string' },
        'actor-call': { type: 'string' },
        input: { type: 'string', multiple: true },
        harness: { type: 'string' },
        user: { type: 'boolean' },
        session: { type: 'boolean' },
        repo: { type: 'boolean' },
        model: { type: 'string' },
        archetype: { type: 'string' },
        'prompt-sha256': { type: 'string' },
        role: { type: 'string' },
        'host-executor': { type: 'string' },
        // Pre-0.6 spelling. Kept parseable so a Codex agent TOML materialized
        // by an older setup keeps resolving until the next one rewrites it.
        'native-executor': { type: 'string' },
        run: { type: 'string' },
        'dispatch-id': { type: 'string' },
        'prompt-file': { type: 'string' },
        'no-brief': { type: 'boolean' },
        isolate: { type: 'boolean' },
        shared: { type: 'boolean' },
        'allow-relay-mismatch': { type: 'boolean' },
        'ignored-output': { type: 'string' },
        diagnostics: { type: 'boolean' },
        tail: { type: 'string' },
        stops: { type: 'boolean' },
        rate: { type: 'string' },
        n: { type: 'string' },
        tag: { type: 'string' },
        shadow: { type: 'string' },
        bakeoffs: { type: 'boolean' },
        wait: { type: 'string' },
        arm: { type: 'string' },
        check: { type: 'boolean' },
        'measure-only': { type: 'boolean' },
        evidence: { type: 'string' },
        prepare: { type: 'boolean' },
        record: { type: 'boolean' },
        comparison: { type: 'string' },
        adversarial: { type: 'string' },
        judge: { type: 'string' },
        json: { type: 'boolean' },
        'probe-models': { type: 'boolean' },
        'agent-id': { type: 'string' },
        windows: { type: 'boolean' },
        workspace: { type: 'string' },
        branch: { type: 'string' },
        file: { type: 'string' },
        source: { type: 'string' },
        output: { type: 'string' },
        cancel: { type: 'string' },
        withdraw: { type: 'string' },
        'work-left': { type: 'string' },
        merge: { type: 'string' },
        'no-merge': { type: 'boolean' },
        note: { type: 'string' },
        commit: { type: 'string' },
        reason: { type: 'string' },
        decision: { type: 'string' },
        feedback: { type: 'string' },
        latest: { type: 'boolean' },
        'allow-failed': { type: 'boolean' },
        legacy: { type: 'boolean' },
        events: { type: 'boolean' },
        tool: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
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
      `warning: \`--timeout\` ${IGNORED_DEADLINE_NOTE_TOKEN}. Nothing will stop this executor on a ` +
        'clock — a clock cannot tell slow from stuck. Stop work with `fadeno cancel <run>` or ' +
        '`fadeno dispatches --cancel <id|tag:<tag>>`. Remove the flag; it will go away.',
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

  // Best-effort runtime maintenance preflight for operational commands
  maybeRunRuntimePreflight(argv, command);

  switch (command) {
    case 'setup': {
      const target = optionalTarget(values);
      if (target === 'grok' || target === 'opencode' || target === 'omp') throw new Error('`fadeno setup` supports --codex or --claude; Grok, OpenCode, and omp have no user-scoped setup.');
      const runtimeSource = values.from != null ? String(values.from) : undefined;
      const result = runSetup({ target: target ?? null, nonInteractive: values['non-interactive'], runtimeSource: runtimeSource as any, resetRuntime: Boolean(values['reset-runtime']) });
      console.log(`Fadeno setup (${result.target ?? 'standalone'})`);
      for (const probe of result.probes) console.log(`  ${probe.name}: ${probe.available ? `available${probe.version ? ` (${probe.version})` : ''}` : 'not found'}`);
      for (const path of result.created) console.log(`  created ${path}`);
      for (const notice of result.notices) console.log(`  ${notice}`);
      if (result.restartRequired) console.log('  restart required: managed host integration changed.');
      return 0;
    }
    case 'status': {
      const target = optionalTarget(values);
      const result = runStatus({ verbose: values.verbose, target: target ?? null } as any);
      console.log(`Fadeno ${(result as any).version} · harness ${(result as any).harness ?? 'unknown'}`);
      console.log(`runtime: ${(result as any).runtime.invocationSource}; managed ${(result as any).runtime.managedVersion ?? 'not installed'}${(result as any).runtime.managedPath ? ` at ${(result as any).runtime.managedPath}` : ''}${(result as any).runtime.versionCurrent ? '' : ' (version skew)'}`);
      {
        const rt: any = (result as any).runtime;
        if (rt.skew) console.log(`skew: ${rt.skew}`);
        console.log(`use: ${rt.preferredCli}${rt.preferredReason ? ` (${rt.preferredReason})` : ''}`);
      }
      console.log(`session: Skills and subagents are loaded at host session start; a fresh session is required to refresh them — no setup or refresh will update the current session.`);
      console.log(`integrations: ${(result as any).runtime.installedHarnesses.join(', ') || 'none'}`);
      {
      }
      // New dial-based status: show per-role rows resolved through cascade
      const r: any = result as any;
      if (r.dials) {
        const d = r.dials as { session: Record<string, unknown>; repo: Record<string, unknown>; user: Record<string, unknown> };
        console.log(`dials: ${Object.keys(d.session).length} session, ${Object.keys(d.repo).length} repo, ${Object.keys(d.user).length} user`);
        for (const role of r.roles ?? []) console.log(`  ${role.archetype} → ${role.executor} (${role.adapter}) [${role.source ?? 'base'}]`);
      } else if (r.roles) {
        for (const role of r.roles) console.log(`  ${role.archetype} → ${role.executor} (${role.adapter})`);
      }
      if ((result as any).staleProjectPin) console.log(`stale project pin: ${(result as any).staleProjectPin}`);
      if ((result as any).staleUserPin) console.log(`stale user pin: ${(result as any).staleUserPin}`);
      if ((result as any).next) console.log(`next: ${(result as any).next}`);
      if (values.verbose) console.log(JSON.stringify({ repoRoot: (result as any).repoRoot, roles: (result as any).roles }, null, 2));
      return 0;
    }
    case 'clean': {
      // `--windows` is a mode, not a modifier: it compacts the write-window
      // log and deletes nothing. Checked before `--force` is read, because
      // `--force` on the ordinary path DELETES that log along with the rest of
      // `.fadeno/local` — including the open windows of deliveries writing
      // right now — which is the opposite of what compaction is for.
      if (values.windows) {
        const { compaction } = runCleanWindows();
        if (!compaction.compacted) {
          console.log(`${compaction.path}: nothing compacted — ${compaction.skipped ?? 'no reason recorded'}`);
          return 0;
        }
        console.log(
          `compacted ${compaction.path}: ${compaction.rowsBefore} rows → ` +
            `${compaction.rowsBefore - compaction.rowsDropped + compaction.rowsDrained} ` +
            `(${compaction.unreadableRowsDropped} unreadable, ${compaction.windowsDropped} closed window(s) ` +
            `past overlap, ${compaction.openWindowsKept} open window(s) kept)`,
        );
        console.log(`  ${compaction.bytesBefore} → ${compaction.bytesAfter} bytes`);
        return 0;
      }
      const result = runClean({ force: values.force });
      const paths = result.dryRun ? result.candidates : result.removed;
      for (const path of paths) console.log(`${result.dryRun ? 'would remove' : 'removed'} ${path}`);
      // What git still has registered under `.fadeno/local` — every kind,
      // asked of git rather than derived from a list of kinds this file would
      // then have to keep current. On the dry run it is the preview; on a
      // --force run it is what was actually deregistered.
      if (result.registeredWorktrees.length > 0) {
        const count = result.registeredWorktrees.length;
        console.log(
          `${count} registered git worktree${count === 1 ? '' : 's'} under .fadeno/local ` +
            `${result.dryRun ? 'would be deregistered and removed' : 'deregistered'}:`,
        );
        const shown = result.dryRun ? result.registeredWorktrees : result.deregisteredWorktrees;
        for (const path of shown) console.log(`  ${path}`);
      }
      // Shadow retention is otherwise invisible and unbounded, so a user about
      // to delete pair evidence sees what they are about to delete. Listed on
      // both runs: on the dry run it is the warning, on a --force run it is
      // the record of what went.
      if (result.retainedShadowWorktrees.length > 0) {
        const count = result.retainedShadowWorktrees.length;
        console.log(
          `${count} retained shadow worktree${count === 1 ? '' : 's'} named by the ledger — ` +
            `${result.dryRun ? 'this would delete' : 'this deleted'} that pair evidence:`,
        );
        for (const path of result.retainedShadowWorktrees) console.log(`  ${path}`);
      }
      // Counted, not listed: one line is the signal (shared host deliveries
      // dying before their terminal receipt), where a hundred paths would be
      // noise. `fadeno doctor` names them.
      if (result.overlapSnapshots.length > 0) {
        const count = result.overlapSnapshots.length;
        console.log(
          `${count} pre-delivery workspace snapshot${count === 1 ? '' : 's'} under .fadeno/local ` +
            `${result.dryRun ? 'would go' : 'went'} with it (overlap detection's baselines; ` +
            'one per shared host delivery that never reached a terminal receipt).',
        );
      }
      if (result.dryRun && paths.length > 0) console.log('Re-run with --force to remove these ignored runtime files.');
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
      const RESERVED = new Set(['clear', 'shadow', 'clear-shadow', 'resolve']);
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
      if (sub === 'clear-shadow') {
        if (positionals.length > 3) throw new Error('Usage: fadeno dial clear-shadow [<archetype>]');
        return clearShadow(positionals[2] ?? null, Boolean(values.json));
      }
      if (sub === 'shadow') {
        const shadowUsage = 'Usage: fadeno dial shadow [<archetype> <model>[@effort] [--harness <id>] [--rate <r>] [--n <count>]]';
        if (positionals.length > 4) throw new Error(shadowUsage);
        const archetype = positionals[2];
        const model = positionals[3];
        if (archetype != null && model == null) throw new Error(shadowUsage);
        return runShadowCommand(archetype, model, { harness: values.harness ?? null, rate: values.rate, n: values.n, json: Boolean(values.json) });
      }
      if (sub === 'resolve') {
        // `--prompt-sha256` is the CALLER's prompt digest — sha256 of the bytes
        // handed to Fadeno, before any kernel decoration (no archetype brief,
        // no result-protocol footer) and with trailing newlines stripped, since
        // the relay's heredoc adds one on the way to the kernel. The kernel
        // re-derives that same digest to re-roll the pair, so a digest taken
        // after decoration — or over raw bytes a transport will change —
        // answers a different question than the dispatch will.
        if (!values.archetype) {
          throw new Error(
            'Usage: fadeno dial resolve --archetype <name> ' +
              '[--prompt-sha256 <hex: the caller\'s prompt bytes, before any kernel decoration, trailing newlines stripped>]',
          );
        }
        if (positionals.length > 2) throw new Error('Usage: fadeno dial resolve --archetype <name>');
        const result = runDialResolve({ archetype: values.archetype, promptSha256: values['prompt-sha256'] ?? null });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      // Otherwise treat as archetype: either show single row or set
      // Reject reserved words and 'set' for grammar sanity
      if (RESERVED.has(sub) || sub === 'set') {
        // This branch should be unreachable because RESERVED already handled, but 'set' still needs refusal
        throw new Error(`archetype "${sub}" is a reserved word — rename the archetype`);
      }
      if (positionals.length === 2) {
        // Single-archetype view
        const archetype = sub;
        const result = runDialShow({});
        const row = result.rows.find((r) => r.archetype === archetype);
        const shadow = result.shadow_attachments[archetype] ?? undefined;
        // Filter to one row
        const filtered = {
          ...result,
          rows: row ? [row] : [],
          shadows: shadow ? { [archetype]: result.shadows[archetype]! } : {},
          shadow_attachments: shadow ? { [archetype]: shadow } : {},
          staleShadows: result.staleShadows.filter((s) => s.archetype === archetype),
          staleDials: result.staleDials.filter((s) => s.archetype === archetype),
          dials: {
            session: Object.hasOwn(result.dials.session, archetype) ? { [archetype]: result.dials.session[archetype]! } : {},
            repo: Object.hasOwn(result.dials.repo, archetype) ? { [archetype]: result.dials.repo[archetype]! } : {},
            user: Object.hasOwn(result.dials.user, archetype) ? { [archetype]: result.dials.user[archetype]! } : {},
          },
        };
        if (values.json) {
          console.log(JSON.stringify(filtered, null, 2));
          return 0;
        }
        // Reuse printer on filtered result
        printDialShow(filtered as any);
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
      throw new Error('Usage: fadeno dial [<archetype> [<model>[@effort] [--harness <id>] [--session|--user|--repo]] | clear [<archetype>] [--session|--user|--repo] | shadow [<archetype> <model>[@effort] [--harness <id>] [--rate <r>] [--n <count>]] | clear-shadow [<archetype>] | resolve --archetype <name>]');
    }
    // Top-level alias for `fadeno dial shadow ...` — same handler
    // (`runShadowCommand`) as the `dial` subcommand above, so the two
    // spellings cannot drift apart.
    case 'shadow': {
      // `fadeno shadow clear [<archetype>]` — the detach half of this command,
      // which previously existed only as `fadeno dial clear-shadow`. Safe as a
      // subcommand because `clear` is a RESERVED archetype name (runDialShadow
      // refuses it), so it can never shadow a real archetype.
      if (positionals[1] === 'clear') {
        if (positionals.length > 3) throw new Error('Usage: fadeno shadow clear [<archetype>]');
        return clearShadow(positionals[2] ?? null, Boolean(values.json));
      }
      const shadowUsage = 'Usage: fadeno shadow [<archetype> <model>[@effort] [--harness <id>] [--rate <r>] [--n <count>]] | fadeno shadow clear [<archetype>]';
      if (positionals.length > 3) throw new Error(shadowUsage);
      const archetype = positionals[1];
      const model = positionals[2];
      if (archetype != null && model == null) throw new Error(shadowUsage);
      return runShadowCommand(archetype, model, { harness: values.harness ?? null, rate: values.rate, n: values.n, json: Boolean(values.json) });
    }
    case 'dispatch': {
      const promptFile = values['prompt-file'];
      const result = (runDispatch as any)({
        archetype: values.archetype,
        role: values.role,
        model: values.model ?? null,
        harness: values.harness ?? null,
        tag: values.tag,
        shadow: values.shadow,
        isolate: Boolean(values.isolate),
        shared: Boolean(values.shared),
        allowRelayMismatch: Boolean(values['allow-relay-mismatch']),
        ignoredOutput: ((): 'kept' | 'discardable' | null => {
          const raw = values['ignored-output'];
          if (typeof raw !== 'string') return null;
          const trimmed = raw.trim();
          if (trimmed === 'kept' || trimmed === 'discardable') return trimmed;
          throw new Error(`--ignored-output must be "kept" or "discardable"; got "${raw}"`);
        })(),
        diagnostics: Boolean(values.diagnostics),
        noBrief: Boolean(values['no-brief']),
        promptFile,
        prompt: promptFile == null ? readFileSync(0, 'utf8') : undefined,
        onEcho: (line: string) => console.error(line),
      });
      // The quarantine banner goes to STDOUT, ahead of the report, and only
      // when a person used --allow-relay-mismatch to get here (without it the
      // dispatch was refused and never reached this line).
      //
      // stdout is normally the executor's pure report, and breaking that is
      // the deliberate cost. A proxy relays stdout and discards stderr, so a
      // warning on stderr about bytes on stdout is a warning that does not
      // reach the one reader who must not act on them. Better a report with a
      // banner on it than a tainted report that looks clean.
      if (result.relayAttested === false) {
        process.stdout.write(
          `${relayQuarantineNotice(result.dispatchId, result.relayAttested, result.relayMismatchAllowed)}\n\n`,
        );
      }
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      // The executor's raw transcript is NOT relayed here any more. It used to
      // be, unbounded: a Codex director's 7 KB report arrived beside ~127,000
      // output tokens of executor chatter, which for a host agent lands in a
      // context window and pushes out the answer it asked for.
      //
      // Silencing it wholesale is the opposite mistake, and one this line has
      // already paid for twice (7c7a0f6, 828dbcf): a finding on a stream
      // nobody reads is not a finding. The reconciliation is that Fadeno's own
      // decision-changing notices do not travel here at all — the relay
      // quarantine banner is on stdout above, and resolution, isolation,
      // ignored-output and transcript notices came out through `onEcho` before
      // this point — so what is left in `result.stderr` is a third party's
      // diagnostic noise. That is retained to a path (echoed by `onEcho`, and
      // stamped on the completion row for the caller who lost the echo), and
      // reaches the terminal only when the caller has no working result to
      // read instead.
      const dispatchFailed = result.exitCode !== 0 || result.outcome === 'empty';
      const executorStderr = renderExecutorStderr({
        stderr: result.stderr,
        transcript: result.transcript,
        // A retention failure prints the excerpt whatever the outcome: with no
        // file to point at, the terminal is the only copy left.
        actionable: dispatchFailed || result.transcript.path == null,
      });
      if (executorStderr != null) process.stderr.write(executorStderr);
      if (result.exitCode !== 0) {
        // CLI-level diagnosis on stderr — a quiet executor otherwise leaves
        // only a bare exit code. stdout stays the executor's pure report.
        console.error(
          result.signal != null
            ? `dispatch: executor ${result.executor} was killed by ${result.signal}`
            : `dispatch: executor ${result.executor} exited ${result.exitCode}`,
        );
      } else if (result.outcome === 'empty') {
        // Exit 0 and nothing written is not a success anyone can use: it is
        // what an unusable model id, or a worker that stopped after
        // backgrounding its real work, looks like from out here. Say so and
        // fail, rather than hand the caller an empty report to relay.
        console.error(
          // "above" is now always true: `renderExecutorStderr` says "none"
          // out loud rather than printing nothing, so this never points a
          // reader at output they will assume scrolled past.
          `dispatch: executor ${result.executor} exited 0 but produced no output — ` +
            `nothing was relayed. Check the executor's stderr above, and that ` +
            `its model id resolves (fadeno dial resolve --archetype <archetype>).`,
        );
        return 1;
      }
      return result.exitCode;
    }
    case 'dispatch-open': {
      const result = runDispatchOpen({
        archetype: values.archetype,
        tag: values.tag,
        note: values.note,
      });
      console.log(`${result.dispatchId} opened (host lane, isolated)`);
      console.log(`  workspace: ${result.workspaceAbs}`);
      console.log(`  base:      ${result.baseCommit.slice(0, 12)}`);
      // The one thing the host must actually do next, spelled out: spawn into
      // that directory, then close. A director that reads only this block has
      // everything the command lane's single invocation would have done for it.
      console.log(
        '  Spawn your in-session agent with that directory as its working tree, then record the receipt:',
      );
      console.log(
        `    fadeno dispatch-close ${result.tag != null ? `tag:${result.tag}` : result.dispatchId.slice(0, 8)}` +
          '            # merges the agent\'s diff back',
      );
      console.log(
        `    fadeno dispatch-close ${result.tag != null ? `tag:${result.tag}` : result.dispatchId.slice(0, 8)} --reason <text>  # it failed; nothing is merged`,
      );
      return 0;
    }
    case 'dispatch-close': {
      const [, target] = positionals;
      if (!target) {
        throw new Error('Usage: fadeno dispatch-close <id|tag:<handle>|last> [--reason <text>] [--no-merge] [--agent-id <id>]');
      }
      const inlineTag = target.startsWith('tag:') ? target.slice(4) : null;
      const result = runDispatchClose({
        dispatchId: inlineTag != null ? '' : target,
        tag: inlineTag ?? values.tag,
        reason: values.reason,
        noMerge: values['no-merge'] === true,
        agentId: values['agent-id'],
        onEcho: (line) => console.error(line),
      });
      const how = result.resolvedBy === 'tag' ? ` (tag: ${result.tag})` : '';
      console.log(
        `${result.dispatchId.slice(0, 8)}${how} closed: ${result.outcome}` +
          `${result.idempotent ? ' (idempotent)' : ''}`,
      );
      if (result.diffSnapshot != null) {
        console.log(`  diff: ${result.diffBytes ?? 0} bytes at ${result.diffSnapshot}`);
      }
      if (result.merge != null) {
        console.log(
          `  merge-back: ${result.merge.status}${result.merge.detail != null ? ` — ${result.merge.detail}` : ''}`,
        );
      }
      if (result.workspaceRetained != null) {
        // Never silent about a tree that still holds work: this is the one
        // fact a host cannot recover from anywhere else.
        console.log(
          `  worktree RETAINED at ${result.workspaceRetained}` +
            (result.diffSnapshot != null
              ? ` — apply it with \`${mergeBackReapplyCommand(result.diffSnapshot)}\``
              : ''),
        );
        // And WHY, when the reason is that a merged delivery's worktree is
        // still the only copy of something. Without this the retention reads
        // as a merge that did not finish.
        if (result.ignoredOutput != null) {
          // Ordered so anything NOT recognisable as build output is named
          // first: this sample is capped at six, and a `data/research/` tree
          // beside four build directories must not be the entry that gets
          // counted away. The imperative is dropped when every entry is
          // build-shaped — that is the line directors learned to skip.
          const ordered = ignoredOutputSignalOrder(result.ignoredOutput.paths);
          const onlyBuild = ordered.length > 0 && classifyIgnoredOutput(ordered).unclassified.length === 0;
          console.log(
            `  it holds gitignored output the diff could not carry: ` +
              `${ordered.slice(0, 6).join(', ') || 'content the listing could not enumerate'}` +
              `${result.ignoredOutput.truncated ? ' (a FLOOR, not the set)' : ''}. ` +
              (onlyBuild
                ? 'All of it is recognised as build or dependency output by NAME alone — most likely a rebuild ' +
                  'rather than a loss, but nothing was opened to check, so it was kept rather than destroyed.'
                : 'Copy what you need out before `fadeno clean --force` reclaims it.'),
          );
        }
      } else if (result.workspaceRemoved) {
        console.log('  worktree removed; the work is in this workspace.');
      }
      return 0;
    }
    case 'dispatches': {
      if (values.bakeoffs) {
        const result = runDispatchesBakeoffs({});
        if (values.json) {
          console.log(JSON.stringify(result, null, 2));
          return 0;
        }
        for (const line of result.lines) console.log(line);
        return 0;
      }
      if (values.cancel != null) {
        const inline = values.cancel.startsWith('tag:') ? values.cancel.slice(4) : null;
        const result = runDispatchesCancel({
          dispatchId: inline != null ? '' : values.cancel,
          tag: inline ?? values.tag,
        });
        const how = result.resolvedBy === 'tag' ? ` (tag: ${result.tag})` : '';
        console.log(`cancel signalled: ${result.dispatchId.slice(0, 8)}${how} — SIGTERM to supervisor ${result.pid}`);
        // Say what was and was not settled. The executor's process group is
        // being reaped now; the kernel writes the completion row when its
        // spawn returns, and only the workspace can say how far the work got.
        console.log('  the executor and its children are being reaped; the kernel records the completion row.');
        console.log('  check the workspace before re-dispatching — a cancelled executor may have written already.');
        return 0;
      }
      if (values.withdraw != null) {
        const inline = values.withdraw.startsWith('tag:') ? values.withdraw.slice(4) : null;
        const result = runDispatchesWithdraw({
          dispatchId: inline != null ? '' : values.withdraw,
          tag: inline ?? values.tag,
          reason: values.reason,
          workLeft: values['work-left'] ?? null,
        });
        const how = result.resolvedBy === 'tag' ? ` (tag: ${result.tag})` : '';
        console.log(
          `withdrawn: ${result.dispatchId.slice(0, 8)}${how}${result.idempotent ? ' (idempotent)' : ''} — ${result.reason}`,
        );
        // Say what was RECORDED and what was not touched. A withdraw signals
        // nothing and deletes nothing; a reader who assumed otherwise would
        // stop looking for the work this dispatch may have left behind.
        console.log(
          `  a dispatch_withdrawn row is the terminal receipt; nothing was signalled and no workspace was removed` +
            `${result.claim === 'stale' ? ' (a stale in-flight claim was found and left in place)' : ''}.`,
        );
        if (result.workLeft != null) {
          console.log(`  recorded as still holding this dispatch's work: ${result.workLeft}`);
        } else {
          console.log('  no tree was named as holding its work; add `--work-left <path>` if it left edits behind.');
        }
        return 0;
      }
      if (values.merge != null) {
        const inline = values.merge.startsWith('tag:') ? values.merge.slice(4) : null;
        const result = runDispatchesMerge({
          dispatchId: inline != null ? '' : values.merge,
          tag: inline ?? values.tag,
          allowRelayMismatch: Boolean(values['allow-relay-mismatch']),
        });
        const how = result.resolvedBy === 'tag' ? ` (tag: ${result.tag})` : '';
        console.log(
          `merged ${result.dispatchId.slice(0, 8)}${how}: ${result.diffBytes} bytes applied to the workspace from ${result.workspace}` +
            `${result.mergeBack.rebased_onto != null ? ` (rebased onto ${result.mergeBack.rebased_onto.slice(0, 12)} first)` : ''}; ` +
            `${result.ignoredOutputKept != null ? 'the worktree is KEPT.' : 'the worktree is removed.'}`,
        );
        console.log(`  diff kept at ${result.diffSnapshot}; a dispatch_merged row records the merge.`);
        // The patch that just landed carried no gitignored path, so removing
        // the worktree would have destroyed this. Said here rather than only
        // on the row: `--merge` is the last moment anyone is looking.
        if (result.ignoredOutputKept != null) {
          console.log(`  ${describeIgnoredOutput(result.ignoredOutputKept)}`);
          console.log('  Copy what you need out of it, then `fadeno clean --force` reclaims it.');
        }
        return 0;
      }
      if (values.output != null) {
        // `--wait` in seconds: the number a caller reaches for after a
        // ten-minute wait is "another minute", not "60000".
        let waitMs = 0;
        if (values.wait != null) {
          const seconds = values.wait === '' ? 120 : Number(values.wait);
          if (!Number.isFinite(seconds) || seconds < 0) {
            throw new Error(`Invalid --wait "${values.wait}". Use seconds (a non-negative number).`);
          }
          waitMs = Math.round(seconds * 1000);
        }
        // Two spellings on purpose. `--tag <handle>` is the natural one, but it
        // cannot stand alone: `--output` takes a value, so `--output --tag x`
        // would swallow the flag. `--output tag:<handle>` is the single-token
        // form that always parses — and it is the one the proxy guard permits,
        // because a caller recovering from an interruption should not also have to
        // get flag ordering right.
        const inline = values.output.startsWith('tag:') ? values.output.slice(4) : null;
        const result = runDispatchesOutput({
          dispatchId: inline != null ? '' : values.output,
          tag: inline ?? values.tag,
          waitMs,
          // Progress goes to stderr so stdout stays relay-safe; a host agent
          // blocked on this call sees life instead of a hang.
          onHeartbeat: (line) => console.error(line),
        });
        // stdout carries the snapshot bytes (relay-safe); the attestation
        // verdict goes to stderr so piping stays clean.
        //
        // One exception, and it is the reason this fix exists: when the relay
        // attestation failed, `result.bytes` already carries the quarantine
        // banner ahead of the report. Everything else here is a caveat ABOUT
        // the bytes and can live on stderr; that one says the bytes answer a
        // different question, and stderr is discarded on exactly the
        // recover-by-tag path this command serves.
        process.stdout.write(result.bytes);
        // The verdict leads. "attested" only says these are the bytes the
        // completion row hashed — a dispatch the kernel killed attests
        // perfectly, zero bytes to zero bytes, and on
        // 2026-08-22 a proxy relayed exactly that as "completed". The bytes
        // are worthless without the verdict, so the verdict is what a relay
        // must carry, and it is spelled in capitals a reader cannot miss.
        const verdict = ((): string | null => {
          switch (result.outcome) {
            case 'timeout': {
              // Legacy rows only: Fadeno no longer runs executors under a
              // deadline, so nothing written now can reach this branch. A
              // ledger recorded before the removal still can, and relaying
              // its bytes as a success is exactly the 2026-08-22 failure.
              const deadline = result.timeoutMs != null ? `${Math.round(result.timeoutMs / 1000)}s ` : '';
              return (
                `TIMED OUT: the kernel killed the executor at its ${deadline}deadline` +
                `${result.signal != null ? ` (${result.signal})` : ''}; the work did NOT finish. ` +
                `${result.outputBytes ?? 0} bytes of output were captured before the kill. ` +
                'This is an old receipt: executor deadlines were removed, and a re-dispatch runs without one.'
              );
            }
            case 'failed':
              if (result.signal == null && result.exitCode === 0) {
                // Only the executor's outcome claim lands here: every other
                // failed derivation has a nonzero exit or a signal behind it.
                return 'FAILED: exit 0, but the report claimed failure (FADENO-DISPATCH-RESULT: failed) — do not relay this as a success';
              }
              return result.signal != null
                ? `FAILED: the executor was killed by ${result.signal}`
                : `FAILED: exit ${result.exitCode ?? '?'}`;
            case 'empty':
              return 'NO OUTPUT: exit 0 with 0 bytes — nothing to relay';
            case 'ok':
              return `ok: exit 0, ${result.outputBytes ?? '?'} bytes`;
            default:
              return null;
          }
        })();
        const merge = result.primaryMerge == null
          ? null
          : result.primaryMerge.status === 'unresolved'
            ? `merge-back UNRESOLVED: the work conflicts with the workspace and did NOT land; the worktree is retained with conflict markers` +
              `${result.workspace != null ? ` at ${result.workspace}` : ''}${result.primaryMerge.detail != null ? ` (${result.primaryMerge.detail})` : ''}. ` +
              `Resolve them there, then \`fadeno dispatches --merge ${result.dispatchId.slice(0, 8)}\``
            : result.primaryMerge.status === 'conflicted'
              ? `merge-back CONFLICTED: the tree MAY be partly applied — inspect \`git status\`${result.primaryMerge.detail != null ? ` (${result.primaryMerge.detail})` : ''}`
            : result.primaryMerge.status === 'blocked'
              ? `merge-back BLOCKED: nothing was applied, the workspace is untouched${result.primaryMerge.detail != null ? ` (${result.primaryMerge.detail})` : ''}`
              : result.primaryMerge.detail != null
                ? `merge-back clean: ${result.primaryMerge.detail}`
                : null;
        const attestation =
          result.attested === 'match'
            ? 'output attested: sha matches the completion row'
            : result.attested === 'mismatch'
              ? 'WARNING: snapshot sha does not match the completion row (file changed after the dispatch?)'
              : result.withdrawn
                ? 'WITHDRAWN: an operator retired this dispatch' +
                  `${result.withdrawnReason != null ? ` (${result.withdrawnReason})` : ''}; these are all the bytes ` +
                  'it ever produced and no completion row is coming. Do not wait on it.'
              : waitMs > 0
                ? `STILL RUNNING: no completion row after waiting ${Math.round(waitMs / 1000)}s. ` +
                  'The executor has not exited; this is its output so far. Not a failure — ' +
                  're-run this command to check again.'
                : 'no completion row recorded YET: the executor may still be running, and the ' +
                  'kernel writes that row only when it exits. This is its output so far, not a ' +
                  'failure. Re-run with --wait <seconds> to wait for the real answer.';
        // Repeated on stderr as well as in the bytes. The banner is what
        // survives a relay; this is what a human watching the terminal sees
        // first, and neither is a substitute for the other.
        const relay = result.relayAttested === false
          ? `RELAY FIDELITY FAILED (relay_attested: false${result.relayMismatchAllowed ? ', dispatched under --allow-relay-mismatch' : ''}) — ` +
            'the report above answers a prompt the caller never wrote; do not relay it as an answer'
          : null;
        // Repeated here for the human at the terminal; the banner in the bytes
        // is what survives a relay. Neither is a substitute for the other.
        // Through the shared phrasing rather than a local slice-and-join.
        // This line predates `receipt-attestations.ts` and had drifted into a
        // third spelling that could not say a worktree still holds the
        // content — the one thing a reader can act on.
        const discarded = result.ignoredOutputDiscarded == null
          ? null
          : `GITIGNORED OUTPUT ${ignoredOutputVerdict(result.ignoredOutputDiscarded)} — ` +
            describeIgnoredOutput(result.ignoredOutputDiscarded, result.ignoredOutputPolicy);
        // Not prefixed onto the bytes: an overlap does not make the report
        // false. It is still stated, because nothing prevents a concurrent
        // writer any more and this is one of the two places it can be read.
        // The log-unreadable stamp names no delivery; counting it as one would
        // turn "I could not see who else was there" into "someone else was".
        const overlapNamed = (result.concurrentWrite ?? []).filter((stamp) => stamp.dispatchId !== UNREADABLE_WINDOW_LOG_ID);
        const overlap = overlapNamed.length === 0
          ? null
          : `concurrent_write: ${overlapNamed.length} other ` +
            `${overlapNamed.length === 1 ? 'delivery' : 'deliveries'} overlapped this one ` +
            `(${overlapNamed.map((stamp) => stamp.dispatchId.slice(0, 8)).join(', ')}) — an ` +
            'attestation, not proof of damage; `fadeno dispatches` names the intersecting paths';
        // Where the executor's stderr went. Last in the list because it is a
        // pointer, not a finding — but present at all because `dispatch`
        // stopped relaying that transcript and now echoes its path on stderr,
        // and stderr is precisely what the caller reaching for this command
        // has already lost.
        const transcript = result.stderrSnapshot == null
          ? null
          : `executor stderr: ${result.stderrBytes ?? '?'} bytes at ${result.stderrSnapshot}` +
            (result.stderrTruncated ? ' (a head+tail sample; a floor, not the set)' : '');
        const note = [relay, discarded, verdict, merge, attestation, overlap, transcript]
          .filter((part) => part != null)
          .join('; ');
        // Say how `last` landed. Recency now only survives when nothing
        // overlapped this dispatch — concurrent-and-finished refuses outright —
        // so the note reports that narrowed claim rather than a bare warning.
        const how =
          result.resolvedBy === 'recency'
            ? ' [resolved by recency: nothing was open and nothing overlapped it, so this is the ' +
              'only candidate — launch with `--tag <handle>` to name it outright]'
            : result.resolvedBy === 'tag'
              ? ' [resolved by tag]'
              : '';
        console.error(`[${result.dispatchId}] ${result.path} — ${note}${how}`);
        return 0;
      }
      let tail: number | undefined;
      if (values.tail != null) {
        const n = Number(values.tail);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`Invalid --tail "${values.tail}". Use a positive integer.`);
        }
        tail = n;
      }
      const result = runDispatches({ tail, stops: Boolean(values.stops) });
      if (values.json) {
        console.log(
          JSON.stringify(
            {
              path: result.path,
              total: result.total,
              shown: result.entries.length,
              skipped: result.skipped,
              skippedNewerFormat: result.skippedNewerFormat,
              // What the listing did NOT slot, and why. A JSON consumer that
              // only read `entries` would see the same silence the terminal
              // reader is protected from: rows exist that this view collapsed.
              stopsOnly: result.stopsOnly,
              stopsTotal: result.stopsTotal,
              stopsCollapsed: result.stopsCollapsed,
              entries: result.entries,
            },
            null,
            2,
          ),
        );
        return 0;
      }
      printDispatches(result);
      return 0;
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
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
