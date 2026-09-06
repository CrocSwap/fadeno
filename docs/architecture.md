# Architecture

How the Fadeno codebase is built. This is the implementation map; for *why* the
design is shaped this way, see [`kickoff-memo.md`](kickoff-memo.md). For *how to
make a specific change*, see [`extending.md`](extending.md).

## The shape of the system

Fadeno is a CLI plus a set of templated assets. Nothing here is a long-running
process — every command is a pure-ish function over the filesystem.

```
                 templates/  ── single source of truth ──┐
                    │                                     │
   fadeno init  ────┤ copies into a user repo            │  fadeno plugin +
   (capability +    │  (.fadeno/, skills, subagents,     │  build-bin.mjs
    definitions)    │   bootstrap, settings, hooks)      │  generate ↓
                    │                                     ▼
   .fadeno/runs/ ◀──┘ written by new-run / run / gate    plugin/  (committed)
   (traces)           as a playbook executes              capability, installed once
```

Three layers, mirrored in the directory split (the organizing principle from the
kickoff memo):

- **Capability** — skills + subagents + CLI. Source under `templates/common/skills`,
  `templates/{codex,claude,grok}/*-agents`, and `src/`.
- **Definitions** — the `.fadeno/` tree. Source under `templates/common/fadeno`.
- **Traces** — `.fadeno/runs/<id>/`. Created lazily by the CLI; no template or
  committed `.gitkeep` is required.

The bundled definition resolver (`src/lib/definitions.ts`) applies project
shadowing over immutable plugin-adjacent definitions. `SchemaSet` accepts a
project directory plus a bundled fallback, so validation, prompting, driving,
diagrams, and verification all use the same logical catalog.

Executor configuration is layered by `src/lib/config-layers.ts`:

```text
bundled catalog → user executors.yaml → project .fadeno/executors.yaml
```

Registry models, the `harnesses:` table, dials (`dials:`), and bindings merge by
key; `unregistered_model_harness` uses the highest declaring layer. A user-layer
model nothing in the merged harness table can deliver is DROPPED with a note
rather than failing the load — a personal alias is machine state, not catalog
policy — while a project- or builtin-declared one is a load error. Pre-dials catalogs with legacy keys (`loadouts`/`targets`) are rejected at parse time. A malformed
present layer is an error. User paths are resolved by `src/lib/user-paths.ts`
with injectable XDG/Windows overrides, including `$FADENO_STATE_HOME/dials.json`
(session dials) and `$FADENO_STATE_HOME/model-verifications.json` (dial-time
verification cache). Setup does not synthesize a catalog from installed CLI
probes: the bundled v4 model registry and harness table are working defaults, and the
user file is an optional override.

## Glossary: harnesses, hosts, and executors

Fadeno relates to an agentic coding environment in exactly two ways. This
section fixes the vocabulary so the two can be said apart.

**Harness** — an agentic coding environment: Codex, Claude Code, Grok Build,
OpenCode, omp, Antigravity, Muse Code. A harness is not a role; it takes one of
the two roles below, and the same harness can take both. Since catalog v4
(`docs/experimental/harness-neutral-dials.md`) the catalog has exactly one
table keyed by harness id, and which role an entry plays is read off which
blocks it declares.

**Host** — the harness Fadeno is *running inside*. This is a typed axis:
`HarnessId = 'codex' | 'claude' | 'grok' | 'opencode' | 'omp' | 'standalone'`
(`src/lib/executors.ts`), resolved by `activeHarness()` as `FADENO_HARNESS` →
ambient markers → `standalone`. **There is no stored default harness**: both
inputs are set by a host at call time, so nothing on disk remembers one. A host
needs an **adapter** — a `templates/<host>/` tree emitted by
`fadeno init --<host>` — because Fadeno has to install skills, subagents,
bootstrap files, and hooks into it. In the catalog a host is a `harnesses.<id>`
entry that declares `host:`. `standalone` is the *no host* value: Fadeno
invoked from a plain shell, with no adapter tree and no session — which is why
`current-host` answers `restart_required` there.

**Executor** — a harness Fadeno *invokes as a subprocess* to do work. An
executor needs nothing from Fadeno but argv: no `templates/` tree, no plugin,
no init step. In the catalog it is a `harnesses.<id>` entry that declares
`command:`:

```yaml
harnesses:
  grok:                                      # an executor…
    provider: xai
    command: [grok, --prompt-file, /dev/stdin, --model, "{model}"]
  claude:                                    # …and a harness that is both
    provider: anthropic
    host: { effort_channel: none }
    command: [claude, -p, --model, "{model}", --permission-mode, acceptEdits, --allowedTools, Bash]
```

A Claude Code session can drive `grok` with no Grok plugin anywhere, and the
reverse pairing is equally valid. A harness that declares both blocks plays
whichever role the call needs: same harness as the host → in-session; different
→ spawn. That pairing is decided at dispatch time, never stored.

The reliable test for which role you mean: **does it need a
`templates/<x>/` tree?** Host yes, executor no.

The word `driver` is retired. It named exactly what `harness` names here, in a
vocabulary where `harness` was already taken by the host; v4 gave the ambient
one its own word (`host`) and the collision went with it.

### The delivery axis (how a slot is filled)

- **Host delivery** — the dial's harness IS the host and that harness declares
  `host:`, compiling to `adapter: 'host'`: an in-session subagent of the host,
  bound to the requesting archetype at resolution time.
- **Command delivery** — `adapter: 'command'`: argv with the prompt on stdin,
  out of process. This is the only way a spawn-only harness is ever reached.
- **`restart_required`** — the identity is deliverable, but not from here and
  not through any declared command: the named harness is a host you are not
  sitting in.

### The identity axis (who does the work)

- **Model** — a harness-neutral registry entry (`provider` + `id` + standard
  `effort`, optional `spellings:` per harness and an explicit `harness:`). It
  carries canonical identity while a spelling selects how that identity reaches
  a given harness; never argv, never permission flags. `current-host` is the
  built-in model naming whatever session is running.
- **Home harness** — the harness that claims the model's provider (`luna →
  codex`), shown identically from every caller reference frame because there is
  one harness table. The resolved `host | command` adapter is separate
  structured resolution data.
- **Harness entry** — `harnesses.<id>`: an optional `provider:` home claim, an
  optional `host:` block (`effort_channel`, `identity?`, `relay?`,
  `eligibility?`), an
  optional `command:` base lane with `models_command:` / `models_prefix:` /
  `effort_encoding:` / `eligibility:`, and optional named `variants:`.
- **Dial** — an archetype → model ref (`model[@effort][ on <harness>]`, set with
  `--harness <id>`);
  **archetype** — a `worker`/`reviewer`/`judge`-shaped slot. Dials are layered
  (`session` via `.fadeno/local/dials`, `repo` via `dials:` in the project
  catalog, `user` via `$FADENO_STATE_HOME/dials.json`, `base` = `current-host`).

### Two name collisions to watch for

These are load-bearing in existing code, so they are documented rather than
renamed. (A third — `driver` versus `harness` — is gone: catalog v4 gave the
ambient side its own word, `host`, and retired `driver` entirely.)

1. **`grok` names two things.** A `HarnessId` (the host axis) and a binary
   inside a harness's `command:` (the executor axis). Same token, opposite
   roles — and since v4 both are spelled `grok` in one table, where the entry
   plays whichever role the call needs.
2. **`adapter` names two things.** A host-side surface (`templates/grok/` is
   "the Grok Build adapter") and a delivery mechanism
   (`adapter: 'command' | 'host'`).

A retired third: **`Target`**. `type Target = 'codex' | 'claude' | 'grok'` in
`src/commands/init.ts` is a *host*, while the legacy `targets:` key in
`executors.yaml` was a provider/model profile (now `models:`). `extending.md`'s
two recipes are now named apart — *Add a harness entry to the catalog* and
*Add a host adapter* — so `target` survives only in legacy catalog lore.

The schema now branches on host-versus-executor in exactly one place: whether a
`harnesses.<id>` entry declares `host:`, `command:`, or both. That single bit is
what the six `routes.<host>` tables were spending six copies to express.

## The CLI

### Dispatch and the view layer (`src/cli.ts`)

`cli.ts` is the only place that talks to the terminal. It:

1. Parses argv with `node:util.parseArgs` (no arg-parser dependency).
2. Resolves global flags (`--help`, `--version`).
3. Dispatches on the first positional to a `run*()` function.
4. Formats the returned data into stdout/stderr and sets `process.exitCode`.

The top-level `try/catch` turns any thrown error into `Error: <message>` + exit 1.
The compact global page and focused pages render from `lib/cli-help.ts`; tests
check its path coverage against the public completion grammar so a public
command cannot silently lack focused help.

### Commands return data; they don't print (`src/commands/*.ts`)

Every command file exports a single `run*(opts)` that **returns a result object**
and **throws a typed error** on failure (`RunError`, `GateError`, `NewRunError`,
`ValidateError`, or a plain `Error`). None of them call `console.*`. This is a
hard convention — it's what lets the test suite call the functions directly and
assert on return values and filesystem effects instead of scraping stdout.

| Command | Returns | Notes |
|---------|---------|-------|
| `runInit` | `EmitResult[]` + `repoRoot` | Scaffolds a target; see *Templates & the plugin*. |
| `runValidate` | per-file results + `ok` | The 3-pass validator; see below. |
| `runPlaybooks` | effective catalog or metadata + ASCII workflow | Read-only resolver-backed list/detail view; project playbooks shadow bundled names. |
| `runDiagram` | a rendered string | Pure; delegates to `lib/diagram.ts`. |
| `runNewRun` | `runId` + `runDir` | Creates a run ledger. |
| `runRun` | updated fields + appended events | Mutates `run.yaml`, appends `events.jsonl`. |
| `runGate` | pass/fail + blocking titles | The advisory→enforced bridge. |
| `runPrompt` | prompt text + sha + record status + plan | Deterministic step-prompt assembler; records a snapshot + `prompt_assembled` by default. Pure resolution/rendering live in `lib/prompt-resolve.ts` + `lib/prompt.ts`. |
| `runNext` | next-step JSON (`status`, `step`, `gate`, …) | Pure flow cursor over playbook + events; read-only. Logic in `lib/flow-cursor.ts`. |
| `runDialShow` / `…Set` / `…Clear` / `…Shadow` | effective dial table + layered dial state | `set`/`clear` pin `.fadeno/local/dials` (session) or `$FADENO_STATE_HOME/dials.json` (user) or `dials:` (repo); shadows are session-pinned. Resolution via `resolveDialCascade` + `resolveDelivery` in `lib/executors.ts`. |
| `runDispatch` | executor report + evidence row | Ad-hoc archetype→executor dispatch; appends a correlated `dispatch_requested`/`dispatch_completed` row pair to `.fadeno/dispatches.jsonl`. Refuses before spawning on eligibility, a `constraints.command` refusal, or a delivery with no argv to invoke. Echo goes to stderr so stdout stays the executor's pure report. |
| `runDispatches` | correlated dispatch rows | Read-only projection of `.fadeno/dispatches.jsonl`: pairs `dispatch_requested`/`dispatch_completed` by `dispatch_id`, keeps `host_delivery` rows inline, and marks a request with no completion as killed-or-in-flight rather than dropping it. Pre-format legacy rows render as `[legacy]`; newer-format rows get a separate count. `--tail <N>` (default 10) / `--json`. |
| `runSteeringResolve` / `runSteeringApply` | hybrid mode / emitted Codex agents | Resolves host vs command vs restart-required vs write-conflict per invocation; materializes per-slot host agents or cheap command brokers, declining brokers for write-conflicted slots. |
| `runToolRun` | `ToolRunResult` + `artifact` | Executes a registered `tool_call` (`test-result` only) deterministically: strict registry, supervisor/process-group, writer lease, bounded TestResult synthesis, exclusive placement, and `tool_dispatched`/`tool_completed`/`tool_failed` lifecycle. Thin adapter over `lib/tool-exec.ts`. |
| `runToolComplete` | run update + artifact manifest + `tool_recorded` receipt | Validates a typed tool result before atomically starting the exact next `tool_call` and recording its result. Shares claim/lease/concurrency discipline with `tool-run` (generation-scoped, one attempt wins). Writes the manifest, then a `tool_recorded` receipt (`recorded_by: host`) — never `tool_completed`, which means the kernel ran it. |
| `runCancel` | `CancelResult` | SIGTERM to the live supervisor/process-group for `engine-*` or `tool-*` claims (run-scoped, `ESRCH`-checked before retry). |
| `runPlugin` | `EmitResult[]` + `outDir` | Generates `plugin/` from templates. |
| `runSetup` | user paths, probes, dial state, restart notices | Safe host-default setup and dial-backed steering; no longer seeds a user dial pin. |
| `runStatus` / `runDoctor` | effective routing / findings | Read-only diagnostics (dial layers + per-role resolved rows). |
| `runVendor` / `runEvidencePromote` | lock / promoted receipt | Explicit committed project capability and evidence. |
| `runUninstall` / `runClean` / `runUnvendor` | removed + preserved paths | Ownership-aware user removal, repo runtime cleanup, and digest-backed vendored removal. |
| `runCompletion` / `runCompletionCandidates` | Bash source + candidate strings | Emits the `fadeno completion bash` script and serves its read-only candidate protocol. |

All commands accept injectable `cwd` / `repoRoot` (and `now` where time matters)
so tests stay hermetic and deterministic.

### Bash completion protocol

`fadeno completion bash` prints a dependency-free Bash function and registers
it for the `fadeno` executable. On each Tab press the function calls
`fadeno completion candidates <COMP_CWORD> -- <COMP_WORDS...>`; the `--`
boundary keeps partially typed Fadeno flags in the word vector out of the
outer argument parser. Candidate calculation stays in `commands/completion.ts`
as plain data, while `cli.ts` owns printing and exit status. It reads only
repo-local playbooks, ledgers, and executor profiles, sorts and de-duplicates
results, and suppresses errors for malformed or incomplete repositories. The
script uses Bash built-ins (`complete`, arrays, `mapfile`, `compgen`) and falls
back to ordinary file completion when no specialized candidates apply.

### Shared libs (`src/lib/`)

- **`paths.ts`** — `findRepoRoot()` (walks up for `.git`), `templatesDir()`
  (locates the bundled `templates/`), `packageVersion()`, and `findUp()`. Handles
  the **dual module system** (see *Build & module system*).
- **`fsutil.ts`** — the non-destructive emit primitives: `emitFile`
  (skip-unless-`force`), `copyTree` (recursive, renames `gitkeep` → `.gitkeep`),
  and `emitBootstrap` (marker-wrapped, idempotent section in `AGENTS.md`/
  `CLAUDE.md`). Everything `init`/`plugin` writes goes through these, so they all
  share the same skip/overwrite/append semantics and report an `EmitStatus`.
- **`playbook-validate.ts`** — the validator (below).
- **`persisted-state.ts`** — `PERSISTED_SURFACES`, the inventory of every file
  Fadeno persists, plus `stampSchemaVersion` / `readVersioned` /
  `auditPersistedState` / `migratePersistedState` (see *Persisted state and
  schema evolution*).
- **`catalog-rot.ts`** — pure predicates behind doctor's `user-catalog-repairs`
  and `model-verification-stale` findings: `VERIFICATION_MAX_AGE_DAYS`,
  `isVerificationStale`, `catalogRepairFindings`, `verificationFindings`. No
  filesystem, no clock, no spawn — `doctor.ts` feeds it the loader outcome, the
  cache rows and the time. Every resolved dial is audited; a dial onto a harness
  with no `models_command` is reported with a remediation that says nothing can
  re-probe it, rather than filtered out.
- **`model-listing.ts`** — `parseListedIds` / `listingContains` /
  `listHarnessModels` / `listingFindings` / `isListable`. The first two are the
  ONE parser and the ONE membership rule: `src/commands/models.ts` imports them
  rather than keeping copies, so `fadeno models` and
  `fadeno doctor --probe-models` cannot disagree about what a backend listed.
  Membership qualifies the dialed id with `models_prefix` via
  `qualifyListedModelId` and compares it to the raw listing — the listing is
  never de-prefixed to meet a bare dial halfway, because `fadeno dial` would
  refuse that dial. `listHarnessModels` spawns a harness's `models_command`
  (10s timeout) and never throws; every failure is `{ ok: false, reason }`,
  worded the way `fadeno models <harness>` would have raised it.
- **`diagram.ts`** — the renderer (below).
- **`flow-cursor.ts`** — pure `computeNext(playbook, events)` for `fadeno next`.
- **`prompt-resolve.ts` / `prompt.ts`** — pure step-prompt plan + render for `fadeno prompt`.
- **`run-ledger.ts`** — list/resolve runs, parse events, list artifacts, and
  gate format-0.3 readers behind explicit 0.2 compatibility mode.
- **`host-dispatch.ts`** — durable host request/start/terminal receipt
  protocol with immutable output placement and attempt evidence. Write-capable
  host work holds a PID-less, full-identity workspace lease until its terminal
  receipt; completion accepts either a file or binary stdin and places output
  with a same-directory atomic rename. Opt-in isolated host delivery uses `fadeno dispatch-prepare <run> <dispatch-id> --isolate` to create a detached worktree at `.fadeno/local/host-worktrees/<run>/<dispatch-id>` from `HEAD` plus a synthetic commit replaying the caller's tracked and untracked/unignored changes (workspace_mode: isolated, state at `.fadeno/local/host-workspaces/<run>/<dispatch-id>.json`), guarded against traversal/symlink escape and serialized by `.fadeno/local/.host-workspace.lock`; `dispatch-prompt` then includes `workspace_mode: isolated` and the absolute workspace path, and `dispatch-start` stamps `workspace_mode: isolated`/`workspace`/`base_commit` on `actor_dispatched`. `dispatch-complete`/`dispatch-fail` collect a binary staged diff of only the host's post-baseline changes at `.fadeno/local/outputs/host-isolated-<run>-<dispatch-id>.diff` without auto-merge, stamping `workspace_mode: isolated` plus `workspace`/`base_commit` and `diff_snapshot`/`diff_bytes` only when a diff was actually collected from the proven registered worktree; `dispatch-fail` degrades to a terminal receipt without diff keys whenever evidence is absent, unverifiable, or unrecoverable (including a missing or malformed machine-local state file) while a collection failure with the state present still refuses, preserving the worktree for retry; `dispatch-complete` may recover and collect from a verified ledger-named worktree when the state vanished but still refuses success when evidence cannot be collected. Neither command stages or removes a directory it has not proven to be this dispatch's registered worktree, and nothing is ever auto-merged. `fadeno show` surfaces workspace_mode as non-gating observability; `verify` never requires machine-local state.
- **`host-workspace.ts`** — idempotent detached-worktree primitive for opt-in isolated host delivery: `HOST_WORKTREES_DIR` is `.fadeno/local/host-worktrees`, `HOST_WORKSPACES_DIR` is `.fadeno/local/host-workspaces`, `HOST_ISOLATED_DIFF_DIR` is `.fadeno/local/outputs`, lock `.fadeno/local/.host-workspace.lock`, state schema `1.0` with `workspace_mode: isolated`, dirty-workspace baseline replay under a short read-window lease, traversal/symlink-safe paths, atomic tmp+rename writes, and delegation to `workspace-lease` for binary diff collection.
- **`workspace-lease.ts`** — the machine-local, repo-wide single-writer lease
  plus detached-worktree isolation for `dispatch --isolate`. Command supervisors release a full-holder
  lease only after the executor process group closes; host leases remain
  conservative until complete/fail. Isolated host delivery via `fadeno dispatch-prepare --isolate` also returns a binary diff
  and never merges automatically. A shared writer blocks with
  ```
  shared workspace is already held by <kind> "<id>" (supervisor_pid <pid>, started <iso>); holder "<requester>" must wait or retry. Inspect it with `fadeno show <run>`; recover an abandoned host dispatch with dispatch-fail/dispatch-complete. Only after verifying no writer remains, remove .fadeno/local/workspace-lease.json as a last resort.
  ``` Multi-holder fan-out enumerates `holders: "<id1>", "<id2>"`. Doctor reports the same state as a `workspace-lease` finding (stale vs live, lock staleness at 120s) and never acquires or deletes. `--isolate` bypasses the lease; `--diagnostics` (or `FADENO_DIAGNOSTICS=1`) is opt-in only, bounded to 32 KiB / 500 lines per stream with head+tail sampling and a single truncation marker `…[fadeno diagnostics truncated: <stdout|stderr> exceeded 32 KiB / 500 lines]…`, stored machine-local under `.fadeno/local/outputs/diagnostics/` as `dispatch-<id>.log` (ad-hoc) or `<run>-<actorCallId>-a<attempt>.log` (engine), never ledger-committed, never gating.
- **Command dispatch supervision and recovery** — both ad-hoc dispatches and
  engine command attempts run below a supervisor that owns the executor's
  process group. The supervisor forwards exact output bytes while publishing
  independent heartbeat, output activity, PID/process-group, and terminal
  status facts (`supervisor_pid`, `executor_pid`, `process_group_id`,
  `started_at`, `heartbeat_at`, `last_output_at`, `stdout_bytes`,
  `stderr_bytes`, plus `timed_out`/`timeout_ms`/`deadline_at` when a deadline
  is in force). Before supervisor startup, the engine atomically publishes an
  exclusive correlated claim; a machine-local in-flight claim then lets another
  `fadeno drive` distinguish any still-running attempt from a dead engine,
  independent of write posture. Recovery refuses to
  record `engine_interrupted` or retry while the supervisor is alive, then
  closes the dangling start only after no live claim remains. A supervisor-owned
  hard deadline sends SIGTERM to the executor group at `deadline_at` and
  escalates to SIGKILL after 5s; lease and claim release still waits for
  `close`, so cancellation and timeout are similarly proven only after the
  group is gone. Idle output is never a termination signal — `show`
  surfaces a warning after five minutes via `OUTPUT_IDLE_WARNING_MS` and
  `HarnessObservedProcessView.outputIdleWarning`, worded by
  `describeIdleOutput` (`lib/attempt-progress.ts`) for what is actually known:
  the agent's mirrored self-report when it moved during the silence
  (`no stdout/stderr for <duration>; agent progress "<phase>" <age> ago`), the
  print-at-exit note when the argv is `claude -p` or `codex exec`
  (`… (this executor prints only at exit; not a stall signal)`), and otherwise
  the unchanged `no output observed for <duration> (non-gating)`.
- **The command-lane progress mirror** — every engine actor prompt asks its
  agent to keep a cooperative progress sidecar, and until 0.6.1 nothing on the
  reading side ever opened one for a *command* attempt: the file was written
  into the attempt's workspace (an isolated worktree, usually) and left there,
  so a live attempt could only be described by byte counters. Three parties
  now: the **producer** is the agent, writing
  `attempt-progress`'s `attemptProgressRelPath(run, step, actor)` — the same
  spelling `prompt.ts` put in its prompt, delegated to rather than restated so
  the two cannot drift; the **mirror** is the supervisor, which reads that file
  on each heartbeat (plus at startup and at `close`) and copies
  `progress_state`/`progress_phase`/`progress_current`/`progress_updated_at`
  with `progress_source: 'agent'` onto its in-flight claim, and clears all five
  fields whenever that read fails (absent, unreadable, unparsable, not an
  object, or carrying no non-empty `updated_at`) so a report that has stopped
  arriving reads as absent rather than as current — the cost being that a
  rename-torn read drops the fields for one tick; the **readers** are
  `readClaimProgress` in `show` and `cli.ts`. It is machine-local, harness-
  observed and never ledger evidence, and — this is the whole discipline — it
  is the agent's SELF-REPORT, not a measurement: it is labelled as such
  wherever it is printed and it never gates.
- **`collective.ts`** — `reduceCollective`, the one reduction of a map's member
  parts into its collective. `drive` writes a collective through it and
  receipts the reduction (`collective_assembled`: parts in order, digest,
  `assembled_by: engine`); `verify` (`collective-provenance`) reduces the
  receipted parts again and refuses a collective that does not come out
  identical.
- **`tool-exec.ts`** — deterministic `tool_call` execution core: strict `tools:` registry parsing (static argv, timeout), `tool_dispatched` → supervisor spawn (shared writer lease, `readdirSync` live-claim scan with `ESRCH` group reclaim) → bounded `TestResult` synthesis → exclusive `linkSync` placement (never clobbering) → `artifact_created` + `tool_completed`/`tool_failed` lifecycle (one attempt wins, `tool-generation` scoped, crash-safe attribution preserving already-attributed bytes). Used by both `fadeno tool-run` and `fadeno drive`; recovery via shared `recoverInterruptedToolDispatchesShared`.
- **`executors.ts`** — the executor profile (`.fadeno/executors.yaml`): v4 registry
  `models:` plus one `harnesses:` table (each entry an optional `provider:` home
  claim, an optional `host:` block with `effort_channel` / `identity` /
  `relay?` / `eligibility?`, an optional `command:` lane with
  `models_command:` / `models_prefix:` / `effort_encoding:` / `eligibility:`,
  and optional named `variants:`), layered **dials** (`session` → `repo` → `user` → `base`),
  per-role `bindings`, and **`tools:`** (`tool` → `{command: string[], timeout?, timeout_ms?}` static argv, no shell/interpolation, positive timeout; layered like other catalog keys; snapshotted into `profile.yaml`); plus an `unregistered_model_harness` fall-through.
  v1 executor profiles remain supported for ledger replay via
  `resolveRoleLegacy`. Core helpers: `parseDialRef`/`formatDialRef`,
  `resolveDelivery` (registry + host → delivery), `resolveDialCascade` (pure cascade,
  no registry touch, so verify replays from snapshot), `resolveRole` (cascade +
  compile), `deliveryIsHost`, plus pin files (`LocalDialState`,
  `readLocalDialState`/`writeLocalDialState`) and user dials +
  `model-verifications.json` cache (`readUserDials`, `readVerifiedModels`,
  etc.). Resolution is computed at dispatch time, inside the CLI, and never
  cached in config emitted elsewhere — integrations (plugin agents, hooks) stay
  dumb and call `fadeno`, so a dial switch takes effect on the next dispatch
  with no config churn.

## Persisted state and schema evolution

`src/lib/persisted-state.ts` holds **`PERSISTED_SURFACES`** — one row for every
file Fadeno writes, carrying its `id`, `scope` (`user-config` / `user-state` /
`repo-local` / `run` / `ledger` / `ephemeral`), `relPath`, `format`,
`versionField`, `currentVersion`, and the `reader`/`writer` that own it. The
table exists because the failure it prevents is invisible: state files
accumulated one at a time, each with its own reader, and a shape change in any
one of them showed up as a command quietly doing the wrong thing rather than as
an error. One list means one place to ask "what do we write, and what version is
it at."

**The versioning rule.** The stamp key is `schema_version`, an integer at the
top level of a JSON or YAML document.

- **An unstamped document is version 0** — the legacy shape today's writers
  produce — and stays readable **forever**. v0 tolerance is not a migration
  window; it is the contract.
- **A stamp from the future is refused, not degraded.** `readUserDials` and
  `readLocalDialState` throw rather than half-read a document a newer Fadeno
  wrote, because these files decide which model runs. `recordVerifiedModel` and
  `removeVerifiedModels` no-op on a document they could not parse rather than
  clobbering it — doctor is what makes the condition loud.
- Writers emit the current version. A surface whose `currentVersion` and
  writer disagree is a test failure, not a runtime surprise (below).

**What is stamped.** `dials.json` v1 is `{schema_version, dials}` (v0 was the
flat archetype map); `model-verifications.json` v1 is
`{schema_version, verifications}` (v0 was the bare array);
`.fadeno/local/dials` v1 is the stamp beside today's keys. `executors.yaml`
(catalog v4), the installation manifest, the dispatch ledger's per-row `format`,
and run snapshots were already versioned and keep their own field names —
`versionField` records which.

**Auditing.** `auditPersistedState({ repoRoot, paths })` reports one
`persisted-state:<surface-id>` finding per row: `ok` at the current version,
`warning` when readable but behind (naming both versions and pointing at
`fadeno setup`), `error` when unreadable or at an unknown version. An `error`
names the surface's backup directory — `<stateDir>/backups` for user files,
`<repoRoot>/.fadeno/local/backups` for repo-local ones, the same place a
migration would have written — so "keep a copy, then delete it" points
somewhere concrete rather than leaving the user to invent a location. It
**never writes**.

**A stamp is not a schema.** Reaching the current version is not enough for an
`ok`: the audit then asks the surface's own reader whether the BODY is one it
can use. `{"schema_version": 1, "dials": []}` is at version 1 and
`readUserDials` yields nothing from it — a check that compared the stamp and
stopped would report that file healthy, which is the exact confident-wrong-answer
this inventory exists to catch. Each validator is exported from the module that
owns the reader — `validateUserDialsDocument` and `validateVerificationDocument`
(`user-paths.ts`), `validateLocalDialDocument` (`executors.ts`),
`validateInstallationManifestDocument` (`installations.ts`) — and each is built
from the reader's own code path, so a rule cannot be changed in one place only.
A document the reader gets NOTHING from is an `error` naming the file and the
scope's `backups/` directory (`fadeno setup` cannot help: migration runs only
0 → current); one it gets most of is a `warning`. `SHAPE_VALIDATORS` in
`persisted-state.ts` is exhaustive over stamped surfaces, with an explicit
`null` meaning "decided: nothing beyond the envelope" — `shapeValidatorFor`
throws for a stamped surface the table does not mention, so adding one forces
the decision. The two catalog surfaces are deliberate `null`s: a catalog *layer*
need only be a YAML mapping, and parsing the merged profile is doctor's
`configuration` check (a user layer is legitimately a `models:`-only fragment
that no full-profile parse would accept).

Per-run surfaces roll up to one finding over the 50 most recent runs
(`RUN_AUDIT_SCAN_LIMIT`), and an *older* run ledger is `ok`, not a warning: a
run ledger is immutable evidence that nothing will ever rewrite, so warning
about it forever would only teach people to skip the section. Damage is still
an `error`. **`run-ledger` is one surface with two files**: `run.yaml` and the
`events.jsonl` beside it, named machine-readably in `RUN_COMPANION_ROWS` and
audited row by row through `readEvents` — the ledger's own reader, so the audit
and the reader cannot disagree about what "corrupt" means. A row the reader
cannot use at all (a truncated append, a scalar where an object belongs) is an
`error` naming the run id and the line number; a row in an older shape is not,
because events carry no stamp, unknown fields survive in `extra`, and history
is supposed to keep the format it was written in. `fadeno doctor` collapses a fully-`ok` inventory into one counted
line; `fadeno doctor --json` always carries every finding.

**The audit runs on EVERY doctor invocation, including when status fails.**
`runDoctor` wraps the status/catalog work in a `try` whose `catch` returns
early — and the failure it catches is very often a persisted surface: a
`dials.json` or a `.fadeno/local/dials` stamped with a version this build
refuses makes `runStatus` throw. Reporting only `configuration: error` there
withheld the `persisted-state:<id>` finding that names the surface, its backup
directory, and what to do — the diagnostic went silent at exactly the moment it
was the diagnosis. The audit now runs from a closure called on both paths, so
both findings appear together; the generic `configuration` error is kept beside
it, because the status failure is real.

**Unstamped is not a reason to skip the read.** Every unversioned surface is
read through its REAL reader — `readWorkspaceLease` (`workspace-lease.ts`),
`readInflightClaim`/`readSupervisorStatus` (`supervisor.ts`),
`spawnMarkerRow` (`spawn-markers.ts`, shared with
`consumeSpawnSideRelay`/`consumeProxyDispatchMarker`), and `parseBakeoffFile`
(`bakeoff.ts`, which is where it now lives so `src/lib/` need not import
`src/commands/`) — and a document the reader refuses is an `error` naming that
file and the backup directory. `UNVERSIONED_READERS` is exhaustive over
unversioned surfaces with an explicit `null` meaning "decided: nothing reads
it"; `unversionedReaderFor` throws for one the table does not mention, exactly
as `shapeValidatorFor` does. The failure it closes is the mirror of the stamp
one: six surfaces holding live machine-local state were reported `ok` —
"unversioned by design" — by a check that had never opened them, and a
`workspace-lease.json` nothing can read reads as a free workspace everywhere
else, so mutual exclusion silently stops excluding.

**Directory surfaces are read member by member.** `host-workspace-state` is a
directory of per-dispatch documents, so the directory itself carries no stamp
to compare; each member is read through `readHostWorkspaceState` — the same
reader `dispatch-complete` uses to decide whether an isolated worktree's diff
can be collected. Directory scans are bounded by `MEMBER_AUDIT_SCAN_LIMIT` and
the finding says so whenever the bound is hit, because a bounded scan that does
not announce the bound is the same confident wrong answer in a new place.

**Migrating.** `migratePersistedState` is called by `fadeno setup` only, never
by `doctor`, and it rewrites only the three newly-stamped surfaces. Each file is
**backed up before it is touched** — `<stateDir>/backups/<ISO-8601 basic
timestamp>/<basename>` for user files, `.fadeno/local/backups/<timestamp>/` for
repo-local ones — and a migration that cannot back up does not rewrite: leaving
a file at v0 costs nothing (v0 stays readable), losing it costs the dial. Errors
are collected into the `MigrationReport`, not thrown, so one unreadable dials
file cannot stop setup from installing a runtime.

**Two tests hold the table honest.**
`test/persisted-state-inventory.test.ts` is the drift tripwire: every path
constant in `src/lib/user-paths.ts` (mapped by `USER_PATH_SURFACE_IDS`) and
every repo-local state path must appear in `PERSISTED_SURFACES`, and each
declared `currentVersion` must equal what its writer actually stamps — checked
by writing to a temp directory and reading the bytes back.
`test/persisted-state-fixtures.test.ts` runs the fixture zoo at
`test/fixtures/persisted-state/<surface-id>/v<N>.<ext>` through the real
readers; the v0 samples were captured from the pre-change writers, so tolerance
is asserted against the legacy bytes rather than against a remembered shape.
Beside them sits `malformed-v<current>.<ext>` — a document at the current
version whose body the reader cannot use — and a tripwire requires one for
every surface with a shape validator, so a validator can never sit untested
while the audit drifts back to trusting the stamp.

## The validator (`src/lib/playbook-validate.ts`)

`validateFile()` runs schema, reference, and semantic passes; severity-aware, so
**warnings don't fail the build** (only `error`-severity issues do).

1. **Schema** — Ajv against the relevant JSON Schema in `.fadeno/schemas/`.
   `SchemaSet` lazily compiles and caches the shipped schemas (`playbook` / `run`
   / `review-report` / `test-result`). It registers a dependency-free
   `date-time` format (a lenient `Date.parse`) so run timestamps are actually
   checked and Ajv doesn't warn about an unknown format.
2. **Reference integrity** *(playbook only, errors)* — every step id referenced by
   a control-flow field (`next`, `on_pass`, `on_fail`, `on_approve`, `on_reject`,
   `on_success`, `on_exhausted`, `default`), a container `body`, or a `routes` map must
   resolve to a defined step; duplicate ids are flagged.
3. **Normalized control flow and definite artifacts** *(playbook only)* — physical
   fallthrough is added only for steps without explicit outgoing control flow;
   container-body definitions are reachable only through their lexical owner.
   The validator reports unreachable steps, container recursion/multiple ownership,
   invalid terminal declarations, unsupported condition bindings, and inputs that
   are absent from the intersection of incoming artifact paths. Container body
   outputs are available to their parent scope.
4. **Role semantics** *(playbook only)* — every `actor`/`actors` entry must be a
   declared role *(error)*; declared-but-unused roles are *warnings*. `over`
   items count as roles only for the legacy leaf-map form; compositional map
   members are data identities. A role may declare an advisory `archetype:` —
   its identity for the dispatch kernel's dial routing, never routing config
   in the playbook — and only its bare-lowercase-identifier shape is checked
   *(error)*; absence is fine.

Semantic analysis runs only when the playbook schema and references are clean.
`detectKind()` infers the document type from its shape (then its path) when
`--schema` isn't given; only playbooks get semantic analysis, while `run.yaml`,
`review-report.json`/`ReviewReport[]`, and `test-result.json` get the schema pass
alone.

> The schema is the **single source of truth for the vocabulary**; the validator
> enforces the cross-references and semantics a schema can't express.

## The run ledger

A run is a directory — the file-backed "degraded runtime" for instruction-only
hosts, and the seam a future compiled runtime would read/write.

```
.fadeno/runs/<id>/
  run.yaml       # metadata, validated by run.schema.json
  events.jsonl   # append-only lifecycle log, one JSON object per line
  artifacts/     # every durable step output (plans, patches, reports, …)
```

Three commands drive its original lifecycle, and host work adds three
receipt commands:

- **`new-run <playbook> "<task>"`** (`runNewRun`) creates the directory, writes
  `run.yaml` with a `$schema` modeline, seeds a `run_started` event, and makes
  `artifacts/`. Two deliberate details: the **run id uses local date/time** (so
  "today's run" sorts under today's date) while **`started_at` stays UTC ISO**;
  and `slugify()` cuts the task slug at a **word boundary** so ids never end
  mid-word.
- **`run <id> [--step|--status|--event|--artifact|--member|--field]`** (`runRun`)
  mutates `run.yaml` and appends to `events.jsonl`. It preserves the modeline,
  attributes events to the in-progress step (an explicit `--step` wins, else the
  run's `current_step`), attaches optional `--member` / `--field k=v` onto the
  event payload, and on a terminal status sets `ended_at` and clears
  `current_step`.
- **`gate <id> <condition> --artifact <path>`** (`runGate`) validates a named
  artifact against the condition's schema, evaluates it deterministically, logs a
  `gate_evaluated` event, and **exits 0/1**. v0 supports `all_reviews_approved`, `no_blocking_issues`, and
  `tests_pass`; `--report` remains a deprecated alias. This is the
  **advisory→enforced bridge**: the same check the runner applies can run in CI, a
  pre-commit hook, or a Claude Code `Stop` hook. See `enforcement.md`.
- **`dispatch-prompt|dispatch-start|dispatch-progress|dispatch-complete|dispatch-fail|dispatch-withdraw`** are
  host receipts. A
  host executor request is durable before host work begins; receipts record
  the requested model/effort/type, host agent id, provenance-labelled
  non-gating progress, and terminal output/failure. Requested identity is
  internally checked but stays visibly unverified unless a future host supplies
  authoritative runtime metadata. `dispatch-prompt` emits the immutable engine
  assignment envelope and recorded prompt bytes without host-side
  reconstruction. `dispatch-withdraw <run> <dispatch-id> --reason <text>` is
  the third terminal receipt and the only one for work that never began: it
  retires a minted-but-unstarted request (`host_dispatch_withdrawn`, removing a
  prepared isolated workspace if one exists), is refused once an
  `actor_dispatched` start exists, and is idempotent for the same reason. The
  request stops being pending, so the next `fadeno drive` mints attempt *n+1*
  for the same actor call under the current cascade or binding with
  `attempt_reason: withdrawn` — `hostRequestAttempts` keeps counting minted
  requests, so the withdrawn attempt keeps its ordinal. `hostRequestTerminalState`
  (`lib/host-dispatch.ts`) is the single reading of the lifecycle that `verify`,
  `drive`, `show` and completion all share. `show` reloads the run's playbook so the projection
  retains graph order and pending actors, then overlays lifecycle/progress
  events and derives actor/step/total runtime. It labels semantic progress as
  agent/harness/director-attested and presents machine-local process facts in a
  distinct harness-observed, non-gating section. The director is the only
  ledger writer during this MVP.

  `steering resolve --run <run> --dispatch-id <id>` is the engine-delivery
  branch: it reads the unique immutable host request and run profile snapshot,
  ignoring ambient dial state. Host executor mismatch is a deterministic
  restart requirement. Whole-trace verification accepts a historical failed
  host attempt only when the same actor call has a later higher-ordinal valid
  success; the final attempt must still succeed.

Compositional playbooks use `lib/composite-flow.ts` instead of the legacy
single cursor. It computes a pure runnable frontier from events. Canonical paths
from `lib/node-instance.ts` distinguish map members and loop generations; drive
batches every ready host leaf, scopes its prompt/output, and recomputes
the frontier after receipts. Literal maps and linear bodies are the deliberate
first boundary. `show` groups observed paths back under their declared graph,
while `verify` recomputes path, parent, member, generation, and dispatch ids. For deterministic `tool_call` steps, `verify` also recomputes `tool-result-coherence`, `tool-command-digest`, and `tool-lifecycle` (one terminal per `tool_dispatched`, digest vs snapshotted `tools:` binding).

Two evidence surfaces sit beside the step lifecycle:

- **`resolution_snapshot`** — computed by `drive` at first engine contact
  (right after the repo profile is snapshotted into the run dir as
  `profile.yaml`), recording the effective dial table and, per
  declared role, its `(archetype, executor, model, resolution source, dial_source)`. Later
  invocations re-record it **only when the resolution in force changed** (a
  dial switch, a `--bind` override); the echo prints on every invocation
  regardless, so the ledger stays quiet while the user still sees which
  provider the run is spending. The row is the invocation's **prelude**: it is
  written by the first thing the invocation actually records, and an invocation
  that records nothing — including one that refuses a dropped binding — records
  no snapshot either, because the snapshot is a claim about work that happened.
  It cannot be a trailing row instead: `verify` holds each dispatch against the
  resolution in force *at that point in the ledger*, so the snapshot has to
  precede the rows it explains. `new-run` prints a best-effort preview of the
  same table but writes no ledger event — resolution is computed at dispatch
  time and the engine owns the durable record. `verify`'s executor-bindings
  check replays these events (plus `executor_override`s, in order) to recompute
  every dispatch's resolution from ledger contents alone.
- **`.fadeno/dispatches.jsonl`** — the append-only evidence log for ad-hoc
  `fadeno dispatch`, which has no run dir: one JSON row per dispatch with
  timestamp, archetype, role, resolution path (`resolution`: `binding` |
  `session` | `repo` | `user` | `base` | `fallback` | `executor-flag` — how the executor was chosen; `dial_source` records which dial layer won), executor, model, exit code,
  duration, and prompt/output sha256 digests. The row is written even when the
  spawn itself fails — a failed dispatch is still a dispatch that happened.
  The executed `command` joins that identity, so what an arm was actually
  able to do is legible in the row rather than only in an empty-handed
  report. The Claude
  steering hook appends `host_delivery` rows to the same file when it steers
  a spawn to a host role agent (archetype, agent_type, dial, executor,
  model, model_override, `reasoning_effort: "inherited"`,
  `transport: "host"`, prompt_sha256, prompt_snapshot,
  `hook_version`) — the kernel never runs on the host path,
  so the hook is the only writer that can witness it, and one file audits both
  delivery routes. Like `.fadeno/local/dials`, it is per-machine evidence —
  auditable locally, never committed. `hook_version` exists because hooks load
  at session start and therefore lag one session behind an edit (`dev` in the
  committed template, the package version in emitted copies), so a row's
  writing generation is identifiable after the fact. `fadeno dispatches` is the
  read-side projection of this file.

A command dispatch has **two terminal receipts**, and they answer different
questions. `dispatch_completed` is the kernel's: an executor ran and its bytes
were hashed. `dispatch_withdrawn` is the operator's: nothing is going to run,
and this dispatch is over. The second exists because the first was
unreachable for a dispatch nobody could signal — reported 2026-09-05, when
`fadeno dispatches --cancel` refused two dead dispatches with *"no running
executor on this machine (no in-flight claim), yet its evidence shows no
completion"*. That refusal is correct and unchanged: cancel signals a process
and will not report having cancelled work it never touched. What was missing
was a second move, so both dispatches read as open forever and "missing
terminal receipts made dead workers look potentially live."

`fadeno dispatches --withdraw <id|tag:<tag>> --reason <text>`
(`runDispatchesWithdraw`) appends that receipt. It signals nothing, and unlike
the host lane's `dispatch-withdraw` it removes **no workspace**: a host request
is withdrawn before it starts, so its prepared worktree is empty, while a
command dispatch is withdrawn after it died, and a killed executor's
uncommitted edits are the thing worth keeping. `--work-left <path>` records
where they are, so `fadeno dispatches` shows an owner for a dirty tree without
anyone reading a transcript. The command is refused while any process behind
the in-flight claim is still alive (cancel it first), refused after a
completion row, and idempotent for the same reason. `commandDispatchTerminalState`
(`commands/dispatch.ts`) is the single list of terminal receipts that the tag
allocator, the output-record loader, `last` resolution, `--cancel`, `--merge`
and the listing all read — the command-lane twin of `hostRequestTerminalState`,
and there for the same reason. `foldEvidenceRow` is the single per-row reader
behind both the tail view and the whole-log view, which were byte-identical
copies before it.

Role agents get one narrow Bash refusal at `PreToolUse`. The same
`dispatch-proxy-guard.mjs` that enforces the proxy relay contract also refuses
the `DESTRUCTIVE_GIT` subcommands — `checkout`, `switch`, `restore`, `reset`,
`stash`, `clean` — when `agent_type` names a managed `worker`, `reviewer` or
`judge`, after a 2026-09-05 report of a worker running `git checkout -- <file>`
in a shared tree against its own explicit instructions. `git stash list|show`
and `git clean -n` pass; the main session is never guarded. The coverage is
**partial and documented as such**: identification is by `agent_type`, so a role
brief handed to a plain `claude`-type subagent is invisible to it, and the
statement splitter reads shell text without being a shell. Codex-hosted role
agents are covered by their own twin of this hook
(`templates/codex/hooks/dispatch-proxy-guard.mjs`), which carries the same
`DESTRUCTIVE_GIT` rule and must be changed with it. Isolation (`--isolate`) is the protection for two
concurrent implementers; the hook only catches the reflex.

`.fadeno/local/` is per-machine session state (sticky dials at `.fadeno/local/dials`, proxy
prompt relays) and is never committed — `init` appends `.fadeno/local/` (along
with `.fadeno/progress/` and `.fadeno/dispatches.jsonl`) to the repo's
`.gitignore`.

The runner skill *can* hand-edit these files, but the CLI keeps them schema-valid.

## The diagram renderer (`src/lib/diagram.ts`)

`renderDiagram(playbook, format)` is pure and deterministic — no 2-D edge routing,
so it stays correct for any playbook.

- **ASCII** — a top-to-bottom column of boxed **cards**, one per step. `▼` =
  sequential fall-through; `⋮` = the next card is reachable only via a labelled
  `▶` arrow (a gate branch, router route, loop exit, or explicit jump). Loop
  bodies are inlined into the loop's card rather than drawn as separate cards.
- **Mermaid** — a `flowchart TD` (renders on GitHub/docs); explicit edges solid +
  labelled, implicit fall-through dotted.

Verbose primitive `kind`s are abbreviated **for display only** via `KIND_LABEL`
(`actor_call` → `actor`, `evaluator` → `eval`, `human_gate` → `ask`, …). The
schema and vocabulary keep the full names. If you add a step kind, teach `detail()`
(its annotation), `edges()`/`branchLines()` (its out-edges), and `mermaidNode()`
(its node shape).

## Templates & the plugin

### `templates/` is the single source of truth

Everything `init` emits and everything the plugin bundles comes from `templates/`:

```
templates/
  common/                 # identical across targets
    fadeno/               # → .fadeno/ : vocabulary, playbooks, schemas, enforcement
    opencode-agents/      # → .opencode/agents : read-only executor policy
    skills/               # shared SKILL.md bodies + references (sigil-free)
    commands/             # /fadeno:* slash-command files (plugin)
    plugin/               # shared plugin launchers + session hooks
    hooks/                # pre-commit, CI workflow, README (tier-2 scaffold)
  codex/                  # Codex adapter: AGENTS.md, host + steering agent TOML, openai/*.yaml
  claude/                 # Claude adapter: CLAUDE.md, agents, enforcement + steering hooks
   grok/                   # Grok Build adapter: AGENTS.md, grok-agents/*.md
   opencode/               # OpenCode adapter: AGENTS.md, opencode-agents/*.md
   omp/                    # omp adapter: AGENTS.md, omp-agents/*.md
```

`runInit` (`src/commands/init.ts`) composes these: always copy `common/fadeno` →
`.fadeno/` and the OpenCode executor policy → `.opencode/agents/`; unless
`--data-only`, also install skills (shared body + per-target
dir/policy), subagents, and the bootstrap file; optionally the hooks scaffold
(`--with-hooks`); and on Claude, merge a `Bash(fadeno:*)` allow-rule into
git-ignored `.claude/settings.local.json` (plugins can't grant themselves Bash
permissions, so `init` is the seam for this). Grok receives the shared
capabilities and host `.grok/agents` definitions without an automatic
`.grok/config.toml` mutation or permission grant.

Steering is enabled by default for Codex and Claude; `--no-steering` is the
explicit opt-out and `--with-steering` remains a compatibility alias. On Codex,
`runInit` renders honest unmaterialized brokers through the same template
`steering apply` uses, resolving the relay identity from the catalog it just wrote.
`fadeno setup --codex` records the Codex installation and materializes managed agents in
the user Codex home. When setup is invoked from a plugin, it first copies the
bundled CLI to the stable user data directory and records runtime and harness
ownership in the user state directory. Managed agents point at that stable
runtime, never at a versioned plugin cache path. Setup is strictly user-scoped
and does not modify the current repository. For Claude it also merges one exact
stable-runtime Bash allow rule into user settings; uninstall removes only that
recorded rule. `fadeno dial` never writes `~/.codex/agents/*`: the managed
agent is a frozen identity, so a dial that moves an archetype's model leaves
Codex spawning the old one until the files are re-materialized. Both surfaces
now say so instead of leaving it to be discovered. `fadeno status` judges each
managed file's `model`/`model_reasoning_effort` against what
`steering resolve` reports for that archetype (`codexAgentIdentityStatus` →
`current` | `stale` | `missing` | `not_applicable`, the last for a slot the
dial resolves onto another provider's command lane, whose file identity is
reported but not judged), and prints the drift with the fix for the file it
actually judged. `fadeno dial` returns the same fact as
`codex_materialization` when the archetype it just set has drifted. File
EXISTENCE was the whole test until 2026-09-05, which reported `current` at the
exact moment it mattered least.

The file both surfaces judge is the file Codex would actually LOAD, resolved
through `effectiveCodexAgentCandidates` — project-over-user, where a
`<repo>/.codex/agents/<archetype>.toml` makes the managed user-scope file
invisible rather than merely lower priority. `doctor` had applied that
precedence since it grew shadow-drift findings; `status` and `dial` read the
user path alone until 2026-09-06 and so could vouch for a file no session
loads, which is the ordinary state of any repo `fadeno init` has scaffolded.
`codexAgentIdentityRow` is the one builder both go through, and it adds the two
verdicts that are about the file's standing rather than its identity:
`unmanaged` (Codex will load it, Fadeno did not write it, and matching
model/effort keys do not license vouching for the rest of it) and `shadowed` (a
project-scope command broker shadows the host agent a host-lane dial needs, so
the dialed identity can never spawn there — and a broker's relay identity is
not drift). Each row carries the `scope` and `path` it judged, because the fix
depends on them: `CODEX_IDENTITY_REMEDIATION` (`--scope user`) rewrites a file
a project copy is shadowing, `CODEX_PROJECT_IDENTITY_REMEDIATION` re-cuts or
deletes the project copy, and `CODEX_UNMANAGED_IDENTITY_REMEDIATION` says to
move the file, because no apply overwrites one Fadeno did not write.
`codexIdentityRemediation` is the single place that mapping lives. `fadeno steering apply --codex --scope project` remains the explicit project override and
then materializes every required slot into session-static role TOML: host slots
become host agents using their configured model/effort, while command slots
become cheap brokers that delegate through `fadeno dispatch`. Before each task,
matching host executor → host, command executor → dispatch proxy, a different
host executor with `fallback_command` → authenticated out-of-process fallback,
and a host executor without one → restart required. Locked engine fallbacks use
`dispatch-fallback`, not ordinary `dispatch`, and record command transport
without claiming host attestation. On Claude, init emits a local
`PreToolUse` script under `.fadeno/local/` and non-destructively merges one
`Agent` hook into `.claude/settings.local.json`. The hook first asks the CLI
whether any dial is active; only then does it map worker, reviewer, and judge
launches to the corresponding dispatch proxy. Only agents that name an
archetype are steered: `general-purpose` is the harness's catch-all, so
capturing it turned every generic spawn in a Fadeno repo into an external
dispatch. It, Explore, Plan, unrelated specialists, and a call that omits
`subagent_type` altogether are never *rewritten* — but they are no longer
unseen. Outside host mode the hook records each one as a `native_spawn` row
(`model_inherited` is always null: a Claude `PreToolUse` event carries no
session model) and lets it through; while session-scoped host mode is on it
**denies** them with the Codex guard's own predicate,
`generic_spawn_in_host_mode`, naming the model the spawn would have run on, the
role agents to use instead, and the `/fadeno:host off` escape. Omitting the
field is refused like any other generic spawn, so dropping it is not a way
around the rule. A director that names
`dispatch-<archetype>` itself is resolved the same way rather than taken at its
word: the transport belongs to the dial, and a host slot is pulled back to
the host agent instead of shelling out to a subprocess of this same harness —
which would load the same plugin, re-read the prompt as director work, and
re-dispatch one level down. A spawn it steers to a host role
agent gets a best-effort `host_delivery` evidence row plus a prompt snapshot
under `.fadeno/local/prompts/`; that path can pin the requested model but not
reasoning effort (the Agent tool schema has no effort parameter), so the row
records `reasoning_effort: "inherited"` rather than the target's declared
effort. Grok currently rejects the flag. A spawn it steers the OTHER way —
**off** the host lane and onto a dispatch proxy, because the dial's lane is
`command` or because a shadow pair was selected — gets a `host_rewritten` row
instead (`reason` names which, with the `challenger` and `rate` on the pair
case) and a one-line `systemMessage` so the session sees the lane change as it
happens. Only a spawn that was actually on the host lane: a caller that named
`fadeno:dispatch-<archetype>` itself is resolved like any other archetype spawn
but never recorded or announced as a rewrite, because nothing was diverted.
That path writes no snapshot and no delivery row: the kernel owns
both downstream, and the two are joined by content, since the hook's
`prompt_sha256` is the **caller prompt digest** — sha256 of `tool_input.prompt`
before any kernel decoration, with trailing newlines stripped — which the
kernel records as `caller_prompt_sha256`. That one digest is also what the
shadow-pair roll is keyed on at both ends; until 2026-09-05 the kernel rolled
on its decorated snapshot instead, so a hook-selected pair could silently
arrive as no pair at all. The newline strip is what carries that agreement
across the relay: the proxy hands the prompt over in a quoted heredoc and the
shell adds a terminator the spawn side never saw, so the two hash the same
canonical bytes rather than the same literal ones (the proxy guard's
`proxy-dispatches.jsonl` marker and the hook's `pending-relays.jsonl` stash
use the same rule, which is what lets `relay_attested` match at all). A
`relay_attested: false` — a proxy marked itself for these bytes and the
spawn-side record disagrees — is a boundary refusal with predicate
`relay_fidelity`, raised before the executor spawns; `--allow-relay-mismatch`
proceeds and stamps `relay_mismatch_allowed: true` on the row, and the dispatch
stays quarantined in every reader afterwards. An *absent* `relay_attested`
never refuses: it says nothing was claimed.

The Codex side has two rungs of that ladder, and both are **guards rather than
rewrites**. The first is `templates/codex/hooks/spawn-guard.mjs`, registered by
the Codex plugin on `PreToolUse`/`Agent`. It classifies each `spawn_agent` by whether
`agent_type` resolves to a managed role agent, and the test is exact: the
`# fadeno:managed` header, project `.codex/agents/<a>.toml` shadowing user
`fadeno-<a>.toml`, and the file's own `name` key equal to the spawned type —
Codex resolves a custom agent by that key, not by its filename, so
`fadeno-worker` is not itself a spawnable type and a `fadeno-worker.toml` that
says `name = "reviewer"` is not a worker. While session-scoped
host mode is on, a **generic** spawn — `default`, `explorer`, any unmarked
custom agent — is denied with predicate `generic_spawn_in_host_mode`, naming the
model it would have inherited from the parent session; `$fadeno-host off` lifts
the refusal. A **managed** spawn is resolved through `fadeno dial resolve` and
drift-checked. Drift is adjudicated for **every host-adapter dial**, whatever
lane the resolver named: `dial resolve` reads the session's effort from
`CLAUDE_EFFORT`, which Codex never publishes, so a *pinned* host dial always
answers `lane: command` with `lane_reason: session effort unobserved` while the
spawn runs in-host on the agent file anyway. The file is the proof the resolver
lacked — the same substitution `decideLane` makes for `hostEffortProven` — so a
file whose baked `--host-executor` and identity match the dial records
`lane: host`, `lane_reason: host agent pins the same effort`, and the row
carries **the lane the guard established**, not the one the resolver guessed.
Only a command-adapter dial skips the check, because a broker file bakes only the relay's own model and effort and no `--host-executor`; the dial's identity travels out of process in the dispatch argv, so nothing in that file can drift from it. If the agent file's `model`, `model_reasoning_effort`,
or baked `--host-executor` disagrees with the dial, host mode denies with
`agent_file_drift` and the fix is `fadeno steering apply --codex` plus a fresh
session; a resolver that fails, times out, or exits 0 with output the hook
cannot read is denied in host mode too (`resolver_error`/`resolver_timeout`),
because an identity nothing established is not a verified one.
The guard never rewrites a spawn, because on Codex **a custom agent
file's `model`/`model_reasoning_effort` win over explicit spawn values** — a
stamped model would change what the evidence claims, not what runs. Every spawn
is recorded in either mode: `host_delivery` (with `agent_file`, `drift`, and
the Claude row's own `model_applied` — the file's model when it declares one,
else the inherited session model for a `current-host` slot) for
managed ones, and a `native_spawn` row carrying `model_inherited` for generic
ones that host mode allowed, so an unsteered subagent never again reads as no
subagent at all. Adding this hook changes `hooks/hooks.json`, so an upgraded
plugin only starts guarding once Codex's review-and-trust flow accepts it at the
next session start.

The second rung is `templates/codex/hooks/dispatch-proxy-guard.mjs`, registered
on `PreToolUse` for the shell tool — Codex fires `PreToolUse` for every tool,
and a shell call arrives as `tool_name: "Bash"` with the command bytes in
`tool_input.command` (measured against the shipped binary, 0.153.4). It carries
the **dispatch-side half of relay attestation** and the role agents'
**destructive-git refusal**, and its shape follows from how a Codex relay
differs from a Claude one. Codex has no dispatch-proxy agent type: the managed
role agent brokers its own dispatch, writing the prompt it received to a file
under `.fadeno/local/prompts/` and running `fadeno dispatch --archetype <role>
--prompt-file <path>`. So the bytes are not in the command — the path to them
is, and the hook reads that file (only under the prompts dir; a path anywhere
else is left unattested rather than read) and writes the same
`proxy-dispatches.jsonl` marker the Claude proxy guard writes, under the same
caller-prompt digest. Its partner is `spawn-guard.mjs`, which now stashes
`pending-relays.jsonl` for **every managed role spawn it lets through**, host
lane included: a host-adapter role agent resolves per task and dispatches on
`mode=command`, and stashing only the command lane would leave those dispatches
carrying a marker with no spawn-side row of their own — which the kernel reads
as defection. Refusals stash nothing, because nothing was handed over. The two
halves ship together on purpose: a proxy marker without a spawn-side stash can
turn an unrelated session's fresh rows into a `relay_attested: false` for a
dispatch that never defected.

What this rung deliberately does **not** carry is the Claude proxy guard's
relay grammar, which allows a dispatch proxy exactly one shape of Bash. That
contract is safe on Claude because `dispatch-worker` exists only to relay; on
Codex the same `worker` is also the host-lane implementer, so an allowlist
would refuse it every legitimate command it runs. The destructive-git list is
byte-identical to the Claude guard's (`checkout`, `switch`, `restore`, `reset`,
`stash`, `clean`; `git stash list|show` and `git clean -n` pass), with the same
stated limits: identification is by `agent_type`, so a role brief handed to a
generic Codex subagent is not covered, and the statement splitter reads shell
text without being a shell. Heredoc bodies are stripped before the git scan —
they are the user's task prompt, and a prompt that mentions `git checkout` must
not read as running one. This entry is appended after the `Agent` group in
`hooks/hooks.json` so Codex's per-group trust keys leave the spawn guard's
existing trusted hash valid and put only the new group through review.

The Claude `claude-agents/` dir carries two kinds of subagents: the host role
subagents (`worker`/`reviewer`/`judge`) and the **dispatch proxy agents**
(`dispatch-worker`/`dispatch-reviewer`/`dispatch-judge`). Claude Code can't run
non-Anthropic inference in-session, so cross-harness subagents go out-of-process
through these proxies. Each is `tools: Bash`, `model: sonnet` — the proxy does
no thinking about the task: one Bash call (run with the tool's `timeout`
raised to 600000 ms) pipes the received task prompt **verbatim** to
`fadeno dispatch --archetype <a>` as a quoted heredoc on stdin, then relays
the report verbatim. The kernel snapshots stdin prompts to
`.fadeno/local/prompts/` and writes the evidence rows itself; the bare
`fadeno` spelling keeps the call inside the `Bash(fadeno:*)` permission rule
init pre-approves. On a non-zero exit the proxy reports the failure and never
attempts the task itself — silently substituting which provider does the work
is an explicit non-goal. (Sonnet, not haiku: a 2026-08-12 dogfood A/B caught
haiku defecting on the relay contract; the proxy guard hook backstops the
contract in either case, and the steering hook's relay attestation checks the
one remaining LLM copy step.) Routing is by description by default and is made deterministic at
the host boundary by default with `init --claude`; `--no-steering` opts out.
Resolution stays in
the CLI. The
permission boundary stays loud: the external executor a proxy dispatches runs
*outside* the harness's permission fences, under its own sandbox flags — a
deliberate user choice made by binding that executor via a dial, with the
dispatch evidence row as the audit trail.

Two non-obvious template rules:

- **Traces are lazy.** Runtime directories are created by the first command that
  needs them; no committed `.gitkeep` is required.
- **`emitBootstrap` is idempotent.** It wraps the Fadeno section in
  `<!-- fadeno:begin … -->` / `<!-- fadeno:end -->` markers: absent file → create;
  markers absent → append; markers present → skip (or replace under `--force`).

### The plugin is generated from the same templates

`fadeno plugin` (`runPlugin`) emits a Claude Code plugin from the **same**
`templates/common/skills` bodies (rewriting `name: fadeno-runner` →
`name: runner` for the short `fadeno:runner` namespace), plus the shared
`commands/`, the Claude `claude-agents/`, a setup skill and hook, and a manifest.
The build adds a standalone CLI plus immutable built-in definitions under
`plugin/bin/`; every skill also gets an executable private launcher under
`scripts/fadeno.cjs`, so plugin operation does not depend on shell `PATH`. Plugin
users can run starter playbooks without project init. `/fadeno:host` explicitly
enables a root-session coordinator policy; a plugin hook stores only a hashed
session marker in the plugin's private data directory, reinforces the policy on
later prompts and after compaction, and removes it on `/fadeno:host off` or
session end. It never edits `CLAUDE.md` or another repository instruction file.
`init --data-only` is the project-data seam (definitions plus executor policy,
without host capability). `vendor` deliberately
emits the full project capability surface plus definitions and a lock.

`npm run build:plugin` runs `fadeno plugin ./plugin --force` **and**
`build-bin.mjs`. The resulting `plugin/` is **committed** (unlike `dist/`, which is
gitignored) so a git-URL install yields a working plugin with no build step. The
bundled binary carries the complete `templates/` tree, including the Grok adapter,
so its `fadeno init --grok` path is self-contained even though `fadeno plugin`
itself remains a Claude Code plugin generator.

`fadeno plugin --codex` (`runCodexPlugin`, `npm run build:plugin:codex`) emits a
**Codex** plugin into the committed, visible `plugin-codex/` (parallel to the
Claude `plugin/`) from the same `templates/common/skills` bodies — but full-named
(Codex invokes `$fadeno-runner`) and carrying each skill's `agents/openai.yaml`
invocation policy (runner implicit; builder/driver explicit-only), the setup
skill, bundled CLI, and immutable definitions. User-scoped host agents are
materialized outside the plugin; project overrides remain available through
`init`, `vendor`, or `steering apply --scope project`. The only piece that must live in a dot dir is the
marketplace pointer `.agents/plugins/marketplace.json` — a fixed Codex convention
(`codex plugin marketplace add owner/repo` looks there), the analog of the Claude
plugin's hidden `.claude-plugin/marketplace.json`; the **marketplace root is the
repo root** and the entry's `source.path` (`./plugin-codex`) is relative to it.
Together they make the repo installable via `codex plugin marketplace add
CrocSwap/fadeno` → `codex plugin add fadeno@fadeno`. The manifest
`interface.category` is a capitalized bucket (`Engineering`) and the version is
single-sourced from `package.json`, both verified against a real `codex plugin add`.
The Codex spelling is `$fadeno-host`; its plugin-bundled lifecycle hook uses
`PLUGIN_DATA` for the same session-only activation and reinjection contract.

### Keeping the plugin in sync (the no-drift guard)

Because `plugin/` is generated but committed, it can drift from `templates/`.
`test/plugin.test.ts` guards this — but **narrowly**: it asserts a freshly
generated `skills/builder/SKILL.md` equals the committed one, and that
`plugin/bin/fadeno` exists, is executable, starts with the node shebang, and is
pinned to CommonJS. The broader drift suite also covers Codex payloads, target
invocation policy, generated templates, and the committed marketplace pointer.
Practical rule: **after editing any template or bumping the version, run both
plugin build commands and commit the generated payloads.**

## Build & module system

The same `src/` is consumed two ways, which drives several otherwise-surprising
choices.

| | Dev / `dist/` build | Bundled plugin binary |
|---|---|---|
| Tool | `tsc` (`npm run build`) | `esbuild` (`scripts/build-bin.mjs`) |
| Module format | ESM | CJS (`format: 'cjs'`) |
| Output | `dist/` (gitignored) | `plugin/bin/fadeno` (committed) |
| Deps | resolved from `node_modules` | inlined (ajv, yaml bundled in) |
| Version | read from `package.json` | baked via `--define __FADENO_VERSION__` |
| Templates | sibling `../../templates` | copied to `plugin/bin/templates` |

Consequences you must respect:

- **Erasable TS only.** `tsc` uses `allowImportingTsExtensions` +
  `rewriteRelativeImportExtensions`: source imports use `.ts` extensions and tsc
  rewrites them to `.js` on emit. This is what lets `node --test` run the `.ts`
  files directly (Node ≥ 22.6 type-stripping) with no test framework, while still
  producing clean ESM. It only works because the syntax is fully erasable
  (`erasableSyntaxOnly`).
- **Dual module-dir resolution.** `paths.ts` computes `moduleDir` from
  `__dirname` when present (the CJS bundle) and `import.meta.url` otherwise (ESM).
  `templatesDir()` probes binary-adjacent, then `../templates`, then
  `../../templates`. Don't reach for `import.meta` or `__dirname` unguarded.
- **`plugin/bin/package.json` pins `"type": "commonjs"`** so the extensionless
  bundle runs as CJS even though the repo root is `"type": "module"`.

## Toolchain gotchas

Footguns that cost time and aren't obvious from the final code:

- **TS 6 does not auto-include `@types/node`.** `tsconfig` sets `"types":
  ["node"]`; without it every `node:*` import and `console`/`process` fails.
- **Import Ajv as a named import:** `import { Ajv } from 'ajv'`. Under
  `module: nodenext` + `verbatimModuleSyntax` the default import types as the
  namespace and isn't constructable.
- **Playbook YAML must use block-style sequences** for `input`/`output`:
  `- ReviewReport[]`, never flow style `[ReviewReport[]]` — the `[]` in
  `ReviewReport[]` opens a nested flow sequence and breaks the parser. Anyone
  editing playbooks/schema examples hits this.
- **Templates are real files**, not strings in `src/`. `templatesDir()` resolves
  them relative to the module dir, which works in dev, `dist/`, and the bundle.

## Tests (`test/`)

- **Framework:** `node:test` + `node:assert/strict`. No test-framework dep.
- **Sandboxing:** `helpers.ts` exports `tempRepo(t)` (a throwaway dir auto-removed
  via `t.after()`), plus `exists` / `read`. Tests build a temp repo, call a
  `run*()` function, and assert on the returned data and the files on disk.
- **No CLI spawning.** Tests import and call `runInit` / `runValidate` / … directly
  with `cwd`/`repoRoot`/`now` injected — fast and hermetic.
- **Coverage** (hundreds of cases): `init` (Codex, Claude, and Grok targets;
  hooks, dial steering, force/idempotency),
  schema + reference + semantic validation, run-ledger lifecycle + gate, diagram
  rendering, and plugin generation + the no-drift/binary guards.

When you add behavior, add a test next to the matching command and follow the
`tempRepo` → `run*()` → assert pattern. Inject `now` for anything time-dependent.
