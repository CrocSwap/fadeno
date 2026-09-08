#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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
  runDispatchOutput,
  runDispatchShow,
  runDispatchStop,
  runDispatchWait,
  runDispatches,
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
import { runCodexPlugin, runOmpPlugin, runPlugin } from './commands/plugin.ts';
import { knownFlagsFor, retiredFlagFor, runCompletion, runCompletionCandidates, suggestFlag, TOP_LEVEL_COMMANDS, unknownFlagsFor } from './commands/completion.ts';
import { runFeedbackAdd, runFeedbackRead } from './commands/feedback.ts';
import { runSetup } from './commands/setup.ts';
import { runStatus } from './commands/status.ts';
import { roleResolutionEchoLabel } from './lib/executors.ts';
import { modelAgrees } from './lib/ledger.ts';
import { packageVersion } from './lib/paths.ts';
import { renderFocusedHelp, renderGlobalHelp, resolveHelpPath } from './lib/cli-help.ts';
import { formatAge } from './lib/contracts.ts';

export const KNOWN_CLI_COMMANDS = new Set(TOP_LEVEL_COMMANDS);

/** How long a dispatch has been open, for a line that says "ask again". */
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
        'stage-prompt': { type: 'boolean' },
        'reuse-open': { type: 'boolean' },
        parent: { type: 'string' },
        'session-id': { type: 'string' },
        'prompt-file': { type: 'string' },
        'message-file': { type: 'string' },
        'agent-cwd': { type: 'string' },
        transcript: { type: 'string' },
        'parent-transcript': { type: 'string' },
        heartbeat: { type: 'string' },
        // dispatch-close
        merged: { type: 'boolean' },
        kept: { type: 'boolean' },
        discarded: { type: 'boolean' },
        failed: { type: 'boolean' },
        note: { type: 'string' },
        // feedback
        dispatch: { type: 'string' },
        // dispatch-wait
        'wait-seconds': { type: 'string' },
        // dispatches
        all: { type: 'boolean' },
        tail: { type: 'string' },
        output: { type: 'string' },
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
    case 'setup': {
      const target = optionalTarget(values);
      if (target === 'grok' || target === 'opencode' || target === 'omp') {
        throw new Error('`fadeno setup` supports --codex or --claude; Grok, OpenCode, and omp have no user-scoped setup.');
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
      const promptFile = values['prompt-file'];
      const outcome = await runDispatch({
        archetype: values.archetype ?? null,
        model: values.model ?? null,
        name: values.name ?? null,
        shared: Boolean(values.shared),
        from: values.from ?? null,
        promptFile,
        prompt: promptFile == null ? readFileSync(0, 'utf8') : undefined,
        session: values['session-id'] ?? null,
        parent: values.parent,
        onEcho: (line) => console.error(line),
        heartbeatMs: values.heartbeat != null ? Number(values.heartbeat) * 1000 : 30_000,
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
      console.error(
        `dispatch ${r.name} (${r.id}) stopped: ${ending}; ${where}` +
          (empty ? '; NO OUTPUT — the executor wrote nothing' : '') +
          (r.stderrBytes > 0 ? `; stderr at ${r.stderrPath}` : '') +
          `. Close it: fadeno dispatch-close ${r.name} --merged|--kept|--discarded|--failed`,
      );
      if (r.exitCode === 0 && empty) return 1;
      return r.exitCode ?? 1;
    }
    case 'dispatch-open': {
      if (!values.archetype) {
        throw new Error(
          'Usage: fadeno dispatch-open --archetype <name> [--name <n>] [--model <ref>] [--lane auto|host|command] [--shared] [--from <ref>] ' +
            '[--session-id <id>] [--parent <id> | --parent-transcript <path>] [--harness <id>] [--stage-prompt] [--reuse-open] ' +
            '(--prompt-file <path> | stdin) [--json]',
        );
      }
      const promptFile = values['prompt-file'];
      const outcome = runDispatchOpen({
        archetype: values.archetype,
        model: values.model ?? null,
        name: values.name ?? null,
        shared: Boolean(values.shared),
        from: values.from ?? null,
        promptFile,
        prompt: promptFile == null ? readFileSync(0, 'utf8') : undefined,
        session: values['session-id'] ?? null,
        parent: values.parent,
        harness: values.harness ?? null,
        parentTranscript: values['parent-transcript'] ?? null,
        lane: (values.lane ?? 'auto') as OpenLane,
        stagePrompt: Boolean(values['stage-prompt']),
        reuseOpen: Boolean(values['reuse-open']),
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
      if (!outcome.opened) {
        console.log(
          `${outcome.archetype} resolves to ${outcome.model}${outcome.effort ? `@${outcome.effort}` : ''}${outcome.harness ? ` on ${outcome.harness}` : ''}, a command lane: nothing opened here. The dispatch proxy runs:`,
        );
        console.log(`  ${outcome.relay.command}`);
        console.log(outcome.nag);
        return 0;
      }
      console.log(
        `${outcome.name} (${outcome.id}) ${outcome.reused ? 'is already open' : 'opened'} on the host lane: ` +
          `${outcome.model}${outcome.effort ? `@${outcome.effort}` : ''}${outcome.harness ? ` on ${outcome.harness}` : ''}`,
      );
      console.log(`  work in: ${outcome.cwd}${outcome.workspace.branch ? ` (${outcome.workspace.branch})` : ' (shared tree)'}`);
      if (outcome.promptFile != null) console.log(`  prompt staged at: ${outcome.promptFile}`);
      else console.log('  the contract-bearing prompt is in the --json output; the hook hands it to the agent.');
      console.log(outcome.nag);
      return 0;
    }
    case 'dispatch-stop': {
      const [, ref] = positionals;
      const transcript = values.transcript ?? null;
      if (!ref && !transcript) {
        throw new Error('Usage: fadeno dispatch-stop [<name|id>] [--transcript <path>] [--message-file <path> | stdin] [--agent-cwd <dir>] [--json] — a transcript can name the dispatch by its contract header.');
      }
      const messageFile = values['message-file'];
      let stopped;
      try {
        stopped = runDispatchStop({
          ref: ref ?? null,
          transcript,
          messageFile,
          message: messageFile == null && !process.stdin.isTTY ? readFileSync(0, 'utf8') : null,
          agentCwd: values['agent-cwd'] ?? null,
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
        }));
        return 0;
      }
      const asked = stopped.record.opened?.model ?? null;
      const ran = stopped.row.model_observed ?? null;
      const modelNote = !modelAgrees(asked, ran, stopped.record.opened?.model_id) ? `; WARNING: ran on ${ran}, the dial asked for ${asked}` : '';
      console.log(
        `${name} stopped${stopped.replayed ? ' (already recorded)' : ''}; tree ${dirty}` +
          (stopped.mismatchedCwd != null ? `; WARNING: the agent worked in ${stopped.mismatchedCwd}, not its assigned worktree` : '') +
          modelNote +
          `. Close it: fadeno dispatch-close ${name} --merged|--kept|--discarded|--failed`,
      );
      return 0;
    }
    case 'dispatch-close': {
      const [, ref] = positionals;
      const verbs = (['merged', 'kept', 'discarded', 'failed'] as const).filter((verb) => values[verb]);
      if (!ref || verbs.length !== 1) {
        throw new Error('Usage: fadeno dispatch-close <name|id> --merged|--kept|--discarded|--failed [--note <text>] — exactly one verb.');
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
      console.log(
        `cancelled ${name}: signalled process group ${outcome.processGroup}` +
          (outcome.stoppedRecorded ? '; stop recorded' : '; its launcher recorded the stop') +
          `. Close it: fadeno dispatch-close ${name} --failed|--kept|--discarded`,
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
        if (!values.json) {
          if (outcome.text == null) console.error(`${name} stopped and recorded no report.${stillWaiting}`);
          else {
            if (refs.length > 1) console.error(`${name} stopped; its report follows.${stillWaiting}`);
            process.stdout.write(outcome.text.endsWith('\n') ? outcome.text : `${outcome.text}\n`);
          }
        }
        return 0;
      }
      if (outcome.state === 'running') {
        // Exit 2, the same code `dispatches --output` uses for "not finished".
        // The message is one instruction, because the only thing a caller can
        // usefully do is ask again.
        if (!values.json) {
          const which = outcome.waiting.length > 1
            ? `${outcome.waiting.length} dispatches are still running (${others.join(', ')})`
            : `${name} is still running (${ageOf(outcome.record)} in)`;
          console.error(`${which}. Run this command again.`);
        }
        return 2;
      }
      if (!values.json) {
        console.error(
          `${name} is not running and never recorded a stop: its process group is gone, so no report is coming. ` +
            `What the executor wrote is at ${outcome.stdoutPath} — record it with ` +
            `\`fadeno dispatch-stop ${name} --message-file ${outcome.stdoutPath}\`, then close it.${stillWaiting}`,
        );
      }
      return 4;
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
    case 'dispatches': {
      const [, ref] = positionals;
      if (values.output != null) {
        const out = runDispatchOutput({ ref: values.output });
        if (out.text == null) {
          const name = out.record.opened?.name ?? out.record.id;
          console.error(`${name}: no report recorded${out.record.state === 'open' ? ' — it is still open' : ''}.`);
          return 1;
        }
        // A running dispatch has output but no REPORT. Handing back the
        // stream so far with nothing said is the worst answer this command
        // can give: a proxy whose Bash call was killed recovered exactly this
        // and had to work out for itself that it held an interim log. Say it,
        // on stderr so the relayed stdout stays verbatim.
        if (out.record.stopped == null) {
          const name = out.record.opened?.name ?? out.record.id.slice(0, 8);
          console.error(
            `${name} has not stopped: what follows is its output so far, not a report. ` +
              'Run this again when it stops (`fadeno dispatches` shows the state).',
          );
        }
        process.stdout.write(out.text.endsWith('\n') ? out.text : `${out.text}\n`);
        return out.record.stopped == null ? 2 : 0;
      }
      if (ref != null) {
        const detail = runDispatchShow({ ref });
        if (values.json) console.log(JSON.stringify(detail.record));
        else for (const line of renderDispatchDetail(detail)) console.log(line);
        return 0;
      }
      const result = runDispatches({ tail: values.tail != null ? Number(values.tail) : undefined, all: Boolean(values.all) });
      if (values.json) console.log(JSON.stringify(result));
      else for (const line of renderDispatches(result)) console.log(line);
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
