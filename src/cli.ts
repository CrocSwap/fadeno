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
} from './commands/dial.ts';
import { runModels, runModelsAdd, runModelsHarness, runModelsRemove, type HarnessListingResult, type ModelAddResult, type ModelRemoveResult, type ModelsResult } from './commands/models.ts';
import { runModelsVerify, type ModelsVerifyResult } from './commands/models-verify.ts';
import { runCodexPlugin, runOmpPlugin, runPlugin } from './commands/plugin.ts';
import { knownFlagsFor, retiredFlagFor, runCompletion, runCompletionCandidates, suggestFlag, TOP_LEVEL_COMMANDS, unknownFlagsFor } from './commands/completion.ts';
import { runSetup } from './commands/setup.ts';
import { runStatus } from './commands/status.ts';
import { roleResolutionEchoLabel } from './lib/executors.ts';
import { modelAgrees } from './lib/ledger.ts';
import { packageVersion } from './lib/paths.ts';
import { renderFocusedHelp, renderGlobalHelp, resolveHelpPath } from './lib/cli-help.ts';

export const KNOWN_CLI_COMMANDS = new Set(TOP_LEVEL_COMMANDS);

function printStaleDials(stale: Array<{ archetype: string; reason: string }>): void {
  for (const item of stale) {
    console.error(
      `warning: ${item.archetype} does not resolve, so its row is omitted — ${item.reason} ` +
        `Re-dial it with \`fadeno dial ${item.archetype} <model>\`.`,
    );
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
 * The effective table: every archetype the catalog and the dials know, and
 * where each one currently goes.
 *
 * One line per archetype, because this table answers "where does it route" —
 * what each archetype is FOR belongs to `fadeno context`, which is what a host
 * session is actually given. A description repeated under every row here
 * doubled the table's height to restate text the reader already had.
 *
 * `lane` is printed rather than left to be inferred: it is what the harness
 * column decides and does not show, and a reader who guesses it wrong routes a
 * whole campaign the wrong way.
 */
function printDialShow(result: DialShowResult): void {
  if (result.staleDials.length > 0) printStaleDials(result.staleDials);
  const header = `${'archetype'.padEnd(12)}  ${'model'.padEnd(18)}  ${'effort'.padEnd(8)}  ${'harness'.padEnd(22)}  ${'lane'.padEnd(8)}  source`;
  console.log(header);
  for (const row of result.rows) {
    const arch = row.archetype.padEnd(12);
    const model = row.model.padEnd(18);
    // The PIN, never the resolved effort: every catalog model declares a
    // default, so a column showing the effective value says the same thing for
    // `dial worker opus` and `dial worker opus@xhigh` and hides which one the
    // user actually asked for. `inherit` rather than `—`, because an unpinned
    // dial is not effort-less — it takes the model's declared default on the
    // command lane and the session's own on the host lane.
    const effort = (row.pinned_effort ?? 'inherit').padEnd(8);
    // `—` for a null harness, which is `current-host` with no host: the cell
    // has no value rather than the value `null`.
    // `(home)` marks a row whose DIAL named no harness — the registry
    // answered, through the provider's home claim or a model-level `harness:`.
    const harness = (row.harness == null ? '—' : `${row.harness}${row.harness_explicit ? '' : ' (home)'}`).padEnd(22);
    // `inherits`, not `via`: `resolvedVia` is the ARCHETYPE this row borrowed
    // its dial from (`reviewer` with no dial of its own falling back to
    // `worker`), which has nothing to do with the harness column.
    const inherits = row.resolvedVia ? ` (inherits ${row.resolvedVia})` : '';
    // `none` is not a third lane; it is the command lane with nothing to
    // invoke, which from a bare shell is every undialed archetype. Saying
    // `command` there would name a dispatch that cannot start.
    const lane = (row.deliverable ? row.lane : 'none').padEnd(8);
    console.log(`${arch}  ${model}  ${effort}  ${harness}  ${lane}  ${roleResolutionEchoLabel(row.source)}${inherits}`);
  }
  if (result.rows.some((row) => !row.deliverable)) {
    console.log(
      'none: no lane from here — `current-host` names the session\'s own model and this is not a session. ' +
        'Spawn it from a host harness, or dial it onto a model with a command lane.',
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
      for (const row of result.routing) {
        const effort = row.pinned_effort != null ? `@${row.pinned_effort}` : '';
        const lane = row.deliverable ? row.lane : 'no lane';
        console.log(`  ${row.archetype.padEnd(12)} ${`${row.model}${effort}`.padEnd(20)} ${lane.padEnd(8)} ${roleResolutionEchoLabel(row.source)}`);
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
      const closed = runDispatchClose({ ref, verb: verbs[0]!, note: values.note ?? null });
      const name = closed.record.opened?.name ?? closed.record.id;
      console.log(
        `${name} closed: ${closed.verb}${closed.replayed ? ' (already recorded)' : ''}` +
          (closed.branch != null
            ? `; branch ${closed.branch} kept${closed.worktree != null ? `, worktree ${closed.worktree} stays until fadeno clean` : ''}`
            : ''),
      );
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
    case 'dispatches': {
      const [, ref] = positionals;
      if (values.output != null) {
        const out = runDispatchOutput({ ref: values.output });
        if (out.text == null) {
          const name = out.record.opened?.name ?? out.record.id;
          console.error(`${name}: no report recorded${out.record.state === 'open' ? ' — it is still open' : ''}.`);
          return 1;
        }
        process.stdout.write(out.text.endsWith('\n') ? out.text : `${out.text}\n`);
        return 0;
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
