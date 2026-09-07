# Extending Fadeno

File-by-file recipes for the changes people actually make. Read
[`architecture.md`](architecture.md) first for the shape; this is the how.

Every recipe ends the same way:

```bash
npx tsc --noEmit -p .
npm test
npm run build:plugin && npm run build:plugin:codex && npm run build:plugin:omp
```

The plugin rebuilds are not optional when you touch `templates/` — the drift
tests compare what is committed against a fresh generation.

---

## Add a CLI command

1. **`src/commands/<name>.ts`** — export `run<Name>(opts)` that returns data and
   throws a typed error. No `console.*`; the CLI prints.
2. **`src/cli.ts`** — add a `case` in the switch that calls it and formats the
   result. If it takes a new flag, add it to the `options` object in
   `parseArgs`.
3. **`src/commands/completion.ts`** — add the command to `COMMANDS` with the
   flags it accepts. This registry is also the validator: a flag `cli.ts` reads
   that is not listed here fails `test/cli-flag-scope.test.ts`, and a flag
   listed here that no command reads is dead completion.
4. **`src/lib/cli-help.ts`** — add a page to `TOP_LEVEL` (or `NESTED`) and an
   entry to `PAGE_OPTIONS`. Every option needs a hint in `OPTION_HINTS`, or
   `renderFocusedHelp` throws — which is the point: help is a contract, not a
   dump of what the parser tolerates.
5. **`test/`** — call `run<Name>()` directly. Reach for the CLI subprocess only
   when the thing under test *is* the output.

## Add a model to the registry

For yourself, no code change:

```bash
fadeno models add moonshot moonshot/kimi-k3   # discovers and writes ~/.config/fadeno/executors.yaml
fadeno models                                 # the effective registry
fadeno models verify                          # re-probe every dialed model against its backend
```

To ship one for everybody, add it to `templates/common/fadeno/executors.yaml`
under `models:`:

```yaml
  kimi:
    provider: moonshot
    id: kimi-k3
    effort: high
    spellings:                # only where a harness needs a different id
      opencode: moonshot/kimi-k3
```

`provider` must be claimed as home by exactly one harness, or the model needs an
explicit `harness:`. Both are load errors otherwise, named at parse time.

## Add a harness Fadeno can spawn

One entry under `harnesses:` in the same file:

```yaml
  newcli:
    provider: someprovider        # optional: claims that provider as home
    command: [ newcli, run, --model, "{model}", --effort, "{reasoning_effort}", --yolo ]
    models_command: [ newcli, models ]   # optional: enables the dial-time probe
    effort_encoding: model-suffix        # optional: `-high` appended to the id instead of a flag
```

Placeholders substituted into the argv: `{model}`, `{reasoning_effort}`, and
`{prompt_file}` for a CLI that reads prompts only from a regular file. A lane
with no `{prompt_file}` receives the prompt on stdin.

Three things to check before you commit it, each of which has bitten:

- **Does it actually read the prompt?** Several CLIs accept a prompt flag,
  answer "how can I help you today?", and exit 0.
- **Does it write into the working directory?** Some bind a workspace elsewhere
  unless told, and report success while the repo gets nothing.
- **Does its effort vocabulary include `default`?** If not, a model left at the
  neutral effort will hard-fail at the CLI.

Add a comment recording what you verified and when. Every lane in the shipped
catalog carries one, and they are the reason nobody re-litigates a flag.

If the lane can run `fadeno` itself, teach `argvGrantsFadenoShell`
(`src/lib/executors.ts`) whatever flag grants it — otherwise the
`fadeno_capable` column in `fadeno models` quietly answers `false`.

## Add a harness Fadeno can run inside

A **host** harness needs three things:

1. A `host:` block in the catalog entry — `effort_channel` (`none` or
   `agent-file`), `identity` (`model` if a spawn can name the model, `session`
   if the adapter can only rewrite the agent name), and optionally a `relay`
   model for the dispatch proxy.
2. **Hooks.** A `PreToolUse` on its spawn tool, a stop hook, and a Bash guard.
   Write them against `templates/hooks/hook-lib.mjs` — the shared library
   already does CLI resolution, the subprocess call, agent classification, and
   refusal envelopes. Add a manifest beside `hooks-claude.json`.
3. An emitter in `src/commands/plugin.ts` producing that harness's plugin
   layout, plus a `npm run build:plugin:<harness>` script.

The hook must be able to answer one question — *what did the CLI say to do?* —
and apply it. If the harness cannot rewrite a spawn, it can still refuse one
with the command that does the work; `spawn-codex.mjs` is the worked example.

## Add an archetype

For one repo, `.fadeno/executors.yaml`:

```yaml
archetypes:
  auditor:
    description: Checks a change against the compliance checklist and reports gaps.
    fallback: reviewer        # optional: whose dial it borrows when it has none
```

The description is what a director reads when choosing what to spawn, so write
the sentence that tells this archetype from its neighbours.

To ship one, add it to `templates/common/fadeno/executors.yaml` **and** to
`BUILTIN_ARCHETYPE_DESCRIPTIONS` in `src/lib/contracts.ts` (the fallback used
when a catalog declares none), and decide whether it belongs in
`ARCHETYPE_DISPLAY_ORDER` and `CANON_ARCHETYPES` (`templates/hooks/hook-lib.mjs`
— the names a spawn hook recognizes without a `fadeno:` prefix).

## Change a template

`templates/` is the single source of truth for everything the plugins carry:
the catalog, the skills, the slash commands, the hook family, the generated
agents. Edit there, never under `plugin*/`.

```bash
npm run build:plugin && npm run build:plugin:codex && npm run build:plugin:omp
git add plugin plugin-codex plugin-omp
```

Mid-flight, `FADENO_SKIP_DRIFT=1 npm test` runs the suite with only the
committed-vs-fresh comparisons skipped. Rebuild before integrating.

Some template text is asserted from the source side on purpose — the host-mode
policy sentences must survive into `templates/common/skills/fadeno-host/SKILL.md`,
and a test enforces it. When a test names a sentence, change both or neither.

## Change what a dispatched agent is told

`src/lib/contracts.ts` holds two things:

- `workerContract()` — appended to every dispatched prompt. The worktree, the
  branch, what to merge from, what the final message must say, and (for a
  director) the archetype vocabulary.
- `hostVocabulary()` — what a host session is told: the archetype list with live
  routing, how spawning works, the close obligation, and the nag.

Both are one function with two delivery points, which is why the host mode skill
and a spawned director cannot drift apart. Injected text is never recorded in
the ledger — it is identical every time, so storing it would make the log
describe Fadeno instead of the work.

## Release a version

1. `npm version <patch|minor|major>` — or edit `package.json` directly.
2. Rebuild all three plugins and commit them; the version is stamped into the
   bundled binaries and the plugin manifests.
3. Update `CHANGELOG.md`.
4. `npm publish` and push the tag. **That step is the maintainer's**, not an
   agent's.

## Where the tripwires are

Adding a feature is easy; keeping two surfaces from disagreeing is the work.
These tests exist to catch that, and adding to them is one literal each:

| Test | Catches |
|------|---------|
| `cli-flag-scope.test.ts` | A flag `cli.ts` reads that the registry does not accept — a flag silently ignored. |
| `catalog-key-strictness.test.ts` | A catalog key advertised but dropped by the merge, and a typo that vanishes instead of erroring. |
| `plugin*.test.ts` | A template edited without rebuilding the plugins. |
| `host-mode-hook.test.ts` | A policy sentence that drifted between the hook and the skill. |
| `hook-sentences.ts` | A refusal that does not end with "report this to the user". |
