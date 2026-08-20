# Extending Fadeno

Recipes for common changes. Each lists the files to touch *together* — most
changes here are deliberately multi-file because the schema, validator, renderer,
runtime instructions, and docs all describe the same vocabulary and must agree.
Read [`architecture.md`](architecture.md) first for the patterns these assume.

After **any** change that touches `templates/`, run `npm run build:plugin` and
commit the regenerated `plugin/`. After any code change, `npm test`.

---

## Add a CLI command

Example: a hypothetical `fadeno list`.

1. **`src/commands/list.ts`** — export `runList(opts)` returning a plain result
   object; `throw` a typed error on failure; **no `console.*`**. Accept
   `cwd`/`repoRoot` (and `now` if time matters) for testability. Resolve the repo
   with `findRepoRoot()` from `lib/paths.ts`.
2. **`src/cli.ts`** — import `runList`; add any new flags to the `parseArgs`
   `options`; add a `case 'list':` that calls it and formats the result to stdout;
   set the exit code. Add a line to the `HELP` string and an example.
3. **`test/list.test.ts`** — `tempRepo(t)` → (init if needed) → `runList(...)` →
   assert on the return value and files. Follow the existing test shape.

Keep all printing in `cli.ts`; the command stays a pure function over the FS.

The low-friction commands follow the same rule: `setup`, `use`, `status`,
`doctor`, `vendor`, and `evidence promote` each return structured results and
keep rendering in `cli.ts`. User-level paths must accept injectable
`UserPathOptions`; project writes must use non-destructive `emitFile` or the
managed marker helpers. Add tests for no-init execution, malformed layer
errors, idempotency, and stale pins before adding convenience output.

Definition and executor changes use the effective layers rather than creating a
second resolver. Built-in files are immutable plugin assets; project files
shadow them by logical name, and user executor/dial entries merge by key.

---

## Add a step kind (primitive)

The playbook vocabulary is defined in **five** places that must stay in lockstep.
To add a `kind` (or a field on one):

1. **`templates/common/fadeno/schemas/playbook.schema.json`** — add the value to
   the `kind` enum, any new property under `definitions/step/properties`, and a
   conditional `allOf` entry making the kind's required fields required.
2. **`src/lib/playbook-validate.ts`** — if the kind introduces a new
   step-reference field, add it to `SINGLE_REF_FIELDS` (or handle it like `body`/
   `routes`) in `referenceIntegrity`; if it references roles or
   produces/consumes artifacts, extend `semanticChecks`.
3. **`src/lib/diagram.ts`** — teach `detail()` what to annotate, `edges()` +
   `branchLines()` its out-edges, and `mermaidNode()` its node shape. Add a
   `KIND_LABEL` entry if the name is verbose.
4. **`templates/common/skills/fadeno-runner/references/runtime.md`** — document
   how the runner *executes* the primitive under "Executing each primitive."
5. **`templates/common/fadeno/vocabulary.md`** — add the term + the primitives
   list, keeping it short and orthogonal.

Then `npm run validate:self` (and add a starter or test that exercises it).

> **Note:** five primitives — `router`, `replicate`, `join`, `artifact_op`,
> `subworkflow` — are schema-valid and documented but **unused by any starter and
> have no executor demonstrated**. They're documented contracts, not proven
> behavior (see `docs/roadmap.md`). Wiring one up end-to-end (starter + runtime
> example + test) is a clean contribution.

---

## Add a gate condition

Gate conditions are the deterministic core — keep them computable from a
**structured artifact on disk**, never a model call.

1. **`src/commands/gate.ts`** — add a condition-registry entry with accepted
   logical artifact names, a schema kind, and a pure evaluator. `runGate` validates
   the concrete `--artifact` file before evaluating it, logs `gate_evaluated`, and
   returns enough detail for `cli.ts` to print a useful failure. Exit code follows
   `pass`.
2. **Artifact schema** — if the condition reads a *new* artifact shape (e.g. a
   fact-check report), add a schema under `templates/common/fadeno/schemas/`, wire
   it into `SCHEMA_FILE`/`SchemaKind` in `playbook-validate.ts` and the
   `--schema` choices in `cli.ts`, and teach `detectKind` to recognize it.
3. **`templates/common/skills/fadeno-runner/references/runtime.md`** — extend the
   "gate" bullet so the runner computes the same condition the CLI does.
4. **`templates/common/fadeno/enforcement.md`** — document the equivalent CLI
   invocation so the condition is usable as a real (tier-2) check.
5. **`test/run-gate.test.ts`** — cover pass and fail.

The invariant: the runner (now), a hook/CI (tier 2), and a future runtime must all
be able to evaluate the condition from the artifact **without re-asking a model**.

---

## Bind roles to executors (models, routes, dials)

`fadeno drive` and `fadeno dispatch` resolve every actor through
`.fadeno/executors.yaml` (parsed by `src/lib/executors.ts`). Version 3 separates
model identity from delivery: **models** are a uniform registry (model + effort
as separate dimensions, `spellings:` per driver), **routes** say how each
harness reaches a provider, and **dials** select the model per archetype:

```yaml
schema_version: 3
models:
  sol:   { provider: openai, id: gpt-5.6-sol, effort: high }
  opus:  { provider: anthropic, id: opus, effort: high, spellings: { opencode: anthropic/claude-opus-4.8 } }
  gemini: { provider: google, id: gemini-3.1-pro, effort: high }

routes:
  codex:
    openai: { host: true, command: [codex, exec, --model, "{model}", "-"] }
    anthropic: { command: [claude, -p, --model, "{model}"] }
  claude:
    anthropic: { host: true, command: [claude, -p, --model, "{model}"] }
    openai: { command: [codex, exec, --model, "{model}", "-"] }

dials:                        # repo pins — project layer only, per-archetype
  judge: sol                  # this repo always judges with sol; worker/reviewer defer to user dials

bindings:                     # explicit role pins; win before any dial
  opus_reviewer: opus         # deliberately-multi-model playbooks pin here

unregistered_model_driver: opencode   # fall-through for unknown model ids
```

A model name resolves to `provider → route → driver → command` via the
registry; `--via <driver>` overrides the home driver using `spellings:` for id
translation, and `effort_encoding: model-suffix` on driver routes (e.g. `agy`)
delivers `model@effort` as a suffixed id rather than a flag.

### See what is declared

`fadeno dial` (no args) prints the effective dial table — the complete
per-archetype resolution, not a preset:

```
archetype  model          effort    harness        source
worker     grok-4.6       high      grok           user dial
reviewer   current-host   inherit   current-host   base
judge      sol @ xhigh    xhigh     codex          session dial
generator  → worker       —         grok           base (via worker)
  ~ shadow: kimi-k3 via opencode [rate 0.25]
```

`model` is the registry key or verbatim unregistered id; ` @ effort` appears
only when dialed off the registry standard. `source` names the cascade layer
that won (`binding | session dial | repo pin | user dial | base`). The
`HARNESS` is the model's frame-neutral home driver. Whether the active caller
reaches it through a host agent or a command route is resolved later;
`write_access` only ever describes the command delivery.

### Add a model

Declare it under `models:` with `provider` (the route key / credential family),
`id` (the provider's model id; defaults to the model name), `effort` (its
standard effort; defaults to `default`), optional `spellings: {driver: id}`,
and optional per-archetype `eligibility: { archetype: eligible | shadow_only | forbidden }`.
A `models:` entry is harness-neutral — no `routes` key per model — so adding
one needs no harness table. To test an unregistered model immediately, dial it
directly (`fadeno dial worker kimi-k3`) — it routes via
`unregistered_model_driver` with the id passed verbatim.

### Add a driver route

Add a route entry for the provider under **every** host table, since how a
driver is invoked does not depend on which harness invokes it. Each row may
declare `driver:` (the `--via` alias; defaults to the provider key),
`models_command: [driver, models]` for dial-time verification, and
`effort_encoding: model-suffix | flag` (the Antigravity quirk as a one-line
driver declaration).

### Add a driver (reuses the route recipe above)

A **driver** is a harness Fadeno spawns as a subprocess (see
[`architecture.md`](architecture.md) → *Glossary*). Adding one is a
catalog-only change — no `templates/` tree, no `init` flag, no `HarnessId`:
declare a model under `models:` for the provider, then add a `command:` route
entry for that provider under **every** host table (as described in *Add a
driver route*), since how a driver is invoked does not depend on which harness
invokes it. The contract each driver must meet is the command-delivery
contract: **prompt on stdin, report on stdout, chatter on stderr, non-zero
exit on failure.** Verify that by hand before shipping the entry — a headless
mode that stalls on an approval prompt exits 0 having done nothing, which is
the failure this project keeps finding.

Drivers shipped in the starter catalog:

| Provider key | Driver | Read base | Write variant | Effort dial |
|---|---|---|---|---|
| `openai` | Codex | `--sandbox read-only` | `--sandbox workspace-write` | `-c model_reasoning_effort=` |
| `anthropic` | Claude Code | `claude -p` | `--permission-mode acceptEdits` | — |
| `xai` | Grok | `--sandbox read-only --always-approve` | `--always-approve` | `--reasoning-effort` |
| `google` | Antigravity (`agy`) | unavailable | `--new-project --dangerously-skip-permissions` | in the model id |
| `openrouter` | OpenCode | `--agent fadeno-readonly --auto` | `--auto` | `--variant` |
| `muse` | Muse Code | `--disable-write --disable-shell` | write/shell enabled | `--reasoning-effort` |

The gotchas the shipped entries encode, each found by probing rather than by
reading docs:

- **Antigravity** replaces gemini-cli, which is retired for individuals and
  dies at auth with `IneligibleTierError`. Its two traps both exit 0 having
  done nothing. `agy -p` requires a value and `agy -p -` does *not* read stdin
  — it answers the literal `-` with "How can I help you today?"; piping with no
  `-p` is what actually delivers the prompt. And without `--new-project` it has
  no active workspace, so it writes to `~/.gemini/antigravity-cli/scratch/`,
  reports "I have created the file", and leaves the repo untouched
  (`--add-dir .` does not fix this; only an absolute path does, which a static
  route cannot express). Its `--effort` accepts only `low|medium|high`, so
  passing `{reasoning_effort}` would hard-fail any `default`-effort target;
  effort lives in the model id instead (`gemini-3.1-pro-high`).
- **Antigravity read-only remains unavailable:** a live
  `--mode plan --sandbox` probe denied mutation but exited 0 without the
  requested report after the denied tool call. A route must satisfy both
  confinement and the command-delivery contract, so it remains write-only.
- **OpenCode** is multi-provider — `-m` takes `provider/model` — so its provider
  key is the credential holder and the route prefixes it: `-m openrouter/{model}`.
  Its CLI has no argv-only sandbox; `init` emits
  `.opencode/agents/fadeno-readonly.md`, and the base route selects that
  explicit deny-policy agent.

A route entry may also declare `write_access: <bool>` — whether that route's
**command** delivery can mutate the workspace — beside an optional top-level
`archetypes:` mapping whose values accept `requires_write`, `ignored_output`,
`fallback`, `distinct_provider_from_inputs`, and `brief`.
`ignored_output` is `kept` | `discardable` (absent is `discardable`): `kept`
means this archetype's gitignored output is load-bearing, so it must not be
paired — a shadow pair merges the primary back through `git add -A`, which
drops ignored paths. Declaring it costs a comparison, never work.
`requires_write` is `required` | `forbidden` | `none`; booleans alias
(`true` → `required`, `false` → `none`). `fallback` names another archetype
whose *binding* is used when this one has no slot (never its policy).
`distinct_provider_from_inputs` is `advisory` | `required`; absent is no
check:

```yaml
routes:
  claude:
    anthropic: { host: true, command: [claude, -p, --model, "{model}"], write_access: false }

archetypes:
  worker: { requires_write: required }
  generator: { requires_write: forbidden, fallback: worker }
  reviewer: { distinct_provider_from_inputs: advisory }
```

A model (or v1 executor) may declare `eligibility:` — a mapping of
archetype → `eligible` | `shadow_only` | `forbidden` (default `eligible`).
`forbidden` refuses at dial time and dispatch time; `shadow_only` dispatches
and stamps `gate_eligible: false`. Gate consumption is unchanged in this
phase.

Top-level `constraints.command` is an optional argv run at the dispatch
boundary with the resolution context as JSON on stdin. Exit 0 allows; exit 2
refuses (stderr is the reason); any other exit, spawn failure, or signal is
a constraint-system error (loud, never an allow).

`fadeno dispatch` then refuses *before spawning* when the resolved command
route says `write_access: false` and the archetype says `requires_write: required`
(or boolean `true`) — and the inverse, `requires_write: forbidden` onto
`write_access: true`. The same check fires at dial time (`fadeno dial <archetype> <model>`),
which also refuses dialing an archetype onto a model whose eligibility for
it is `forbidden`. The write-posture error advertises `--force` as a
deliberately discouraged escape hatch. `fadeno dial <archetype> <model>
--force` persists `force_write_posture: true` on that direct dial, emits a
prominent warning, and lets dispatch/drive/steering honor the mismatch. It
does not bypass eligibility, provider, or external constraint checks, and a
fallback archetype never inherits another archetype's forced posture.
The original case is a commit task routed to a headless `claude -p` that has no
approver for a write. Either side undeclared imposes no constraint (existing profiles are
unaffected). When declared, `write_access` joins the evidence-row identity, and
a dispatch that proceeds on a read-only route echoes `[write_access: none]`.
Enforcement is not kernel-only: `drive` refuses the same conflict before
spawning (the run pauses in `executor_failed`), and `steering resolve`/`apply`
surface `mode: write_conflict` and decline to materialize a broker for the
conflicted slot — one shared helper keeps the refusal text identical.
Rationale: `docs/experimental/loadouts-and-dispatch.md` → *Write access*.

### Add a tool binding

A **tool** is a logical capability a `tool_call` step names. The registry is strict: add it under top-level `tools:` in `.fadeno/executors.yaml` (parsed by `src/lib/executors.ts`, layered via `src/lib/config-layers.ts`, snapshotted into `profile.yaml` for the run).

```yaml
schema_version: 3
tools:
  test_runner:
    command: [npm, test]          # static argv — no shell, no interpolation, no placeholders
    timeout_ms: 300000            # optional positive integer ms
  lint:
    command: [npm, run, lint]
    timeout: 60                   # seconds — use one of timeout / timeout_ms, not both
```

Rules enforced identically at catalog and snapshot parse boundaries:

- tool name is a bare lowercase identifier (`[a-z][a-z0-9_-]*`);
- `command` is a non-empty array of non-empty, non-whitespace strings;
- no interpolation/placeholders: rejects `{`, `}`, `$`, `` ` ``, newline, or null;
- unknown keys rejected (`command`, `timeout`, `timeout_ms` only);
- `timeout` / `timeout_ms` is a positive integer (`timeout` in seconds, `timeout_ms` in ms); `timeout: 0` is invalid there — use `--timeout 0` on the CLI to disable a registry deadline for one invocation;
- exactly one of `timeout` / `timeout_ms` when present.

Layering follows existing profile precedence: `builtin` → `user` → `project`; a self-contained project catalog (`models:` + `routes:`) suppresses builtin/user. `tools:` merges by key like `bindings:`/`models:`.

`fadeno tool-run <run> [--tool <name>] [--timeout <seconds>]` then executes the ready `tool_call` only when its `tool` is registered and its artifact schema is `test-result`; `--tool` is a race guard. `Diff`/`PostResult` stay manual via `fadeno tool-complete <run> --output <path>` (which shares the same generation-scoped claim/lease discipline, so one attempt wins). `fadeno drive` auto-executes registered `test-result` tools inline and otherwise returns `needs_decision`.

Every model name and dial ref must use bare lowercase identifiers
(`[a-z][a-z0-9_-]*` for archetype/dial keys; model ids may contain slashes for
unregistered namespaces). Playbook roles opt into dial routing with one
advisory field — `archetype: worker` — validated for identifier shape only, so
the playbook stays harness- and provider-neutral.

**Resolution order** — the dial cascade (per role, computed at dispatch time
inside the CLI, never cached anywhere else):

1. explicit `bindings[role]` pin;
2. session dial for the role's declared `archetype`
   (`fadeno dial <archetype> <model>[@effort] [--via <driver>]`);
3. repo pin for the archetype (`dials:` in `.fadeno/executors.yaml`);
4. user dial for the archetype (`$FADENO_STATE_HOME/dials.json`);
5. host-native base (`current-host`, `inherited` effort).

When the declared archetype has a `fallback`, steps 2–4 re-enter along that
chain (session → repo → user, at each step) before the base terminal. A row
bound this way carries `resolved_via`.

Switch a dial per archetype (no preset to author):

```bash
fadeno dial worker grok --user           # user default — applies across repos
fadeno dial worker grok --repo           # repo pin — committed in .fadeno/executors.yaml
fadeno dial worker grok --session        # local override — this checkout only
fadeno dial worker grok                  # updates session → repo → user; creates user if none
fadeno dial clear worker --session       # explicit checkout-local clear
fadeno dial                              # effective table with dial_source per row
fadeno dial shadow worker grok --rate 0.25  # shadow attachment (session only)
```

An adaptive `set` with no scope flag updates the highest existing dial layer
(session, then repo, then user), so it never writes a shadowed lower layer; if
no dial exists it creates the user default. `--session`, `--repo`, and `--user`
select a layer explicitly. `fadeno
dial <archetype> <model>` runs the archetype write-access check at dial time, refusing a
worker dial onto a read-only command route before any dispatch burns tokens.

`.fadeno/local/` (session dials + shadows) is per-machine session state — `init`
gitignores it — which is what makes a dial switch session-scoped instead of a
repo edit that dirties git for a quota condition that expires tomorrow. The
switch takes effect on the next dispatch. Evidence: runs record a
`resolution_snapshot` event in their ledger (the full dial table with
`dial_source` per row); ad-hoc dispatches append one row each to
`.fadeno/dispatches.jsonl` (also gitignored by `init` — per-machine evidence
like `.fadeno/local/`, auditable locally, never committed). Each row's
`resolution` field records how the executor was chosen
(`binding | session | repo | user | base | model-flag | shadow`); the `dial`
field carries the DialRef as dialed; `resolved_via` names the fallback chain
archetype that bound (absent when the declared archetype bound directly);
and `resolution_snapshot` events record the dial layers — verification replays
from the snapshot, never the live pin. Constraint-tier evidence is additive on
format `1.0`: ad-hoc boundary refusals append a `dispatch_refused` row
with `refusal: { predicate, message }` (`write_posture` | `eligibility` |
`provider_distinctness` | `constraint_command`); proceeding rows may carry
`input_provenance`, `provider_distinctness: "warned"`, and
`gate_eligible: false`. Engine command refusals are `actor_failed` with
reason `eligibility_forbidden` | `provider_conflict` | `constraint_refused`;
a `shadow_only` dispatch proceeds with `gate_eligible: false` on
`actor_dispatched`. `fadeno verify` recomputes that stamp from the snapshot
(absent = a claim of eligible); constraint-command outcomes are attested,
not recomputed.

Ad-hoc dispatch runs the same chain outside any playbook:
`fadeno dispatch --archetype worker` with the prompt on stdin or via
`--prompt-file <path>`. `--role <name>` additionally enables per-role binding
pins and evidence attribution (without it, step 1 above has nothing to match);
`--model <model>[@effort] [--via <driver>]` bypasses resolution entirely
(debugging). What it can invoke is a property of the resolved **route**, not
of the model: a command-delivered route runs its argv, and a `host: true`
route runs its fallback `command` when one is declared. A host-routed model
with no fallback command is a clear error naming the fix — run the task with
the in-session agent, declare a fallback command, or dial the archetype to a
command-delivered model.

Every command dispatch streams the executor's stdout to an output snapshot at
`.fadeno/local/outputs/<archetype|role|dispatch>-<dispatchId8>.md` (same
naming idiom as the prompt snapshot). The repo-relative `output_snapshot`
path is stamped on the `dispatch_requested` row *before* the spawn so a
killed dispatch's partial bytes stay discoverable from the ledger; the
completion row adds `output_bytes` (the snapshot file's byte length) and,
when both a pre-spawn and post-spawn git fingerprint could be taken,
`workspace_changed` (`true`/`false`). That last field is an attestation, not
a judgment: concurrent writers in the same repo can flip it, and the field is
omitted entirely when the fingerprint is unknowable (no git, or the probe
failed).

`fadeno dispatches [--tail <N>] [--json]` reads `.fadeno/dispatches.jsonl`
back. It correlates each `dispatch_requested`/`dispatch_completed` pair by
`dispatch_id` into one row per dispatch and renders `host_delivery` rows
beside them, so both delivery routes read as one history. A request row whose
completion never arrived is kept and marked — "no completion recorded (killed
or in flight)" — rather than dropped, since a dispatch that died mid-flight is
the one most worth seeing. Rows carry the markers that change their meaning:
`relay_attested`, `[write_access: none]`, `model_override`,
`[shadow-only]` (`gate_eligible: false`), `[refused: <predicate>]`
for `dispatch_refused` rows, `[shadow of <primaryId8>]` for shadow rows
(which are never candidates for `[no workspace change]`), and
`[no workspace change]` when a completed entry has `exit_code === 0`,
`write_access === true`, and `workspace_changed === false` (the legible face
of an exit-0 no-op). `fadeno dispatches --output <id|last>` prints the snapshot
bytes verbatim (`last` is the most recent request row that carries
`output_snapshot`; `id` is a full `dispatch_id` or a unique prefix of at least
8 characters) — and the same recovery works for shadow ids, whose snapshots
live at `.fadeno/local/outputs/shadow-<shadowId8>.md`. The reader attests the
file against the completion row's `output_sha256` (`incomplete` when the
completion never arrived — the killed-mid-flight case). `--tail <N>`
defaults to 10; `--json` emits the correlated rows for scripts, carrying
`shadow: boolean`, `primary_dispatch_id: string | null`, and
`diff_bytes: number | null` for shadow entries. Rows are format-stamped (`format: "1.0"`); pre-format rows from before the bump
render as `[legacy]` entries rather than being skipped, and rows from a newer
format major get their own count in the summary.

**Shadow attachments and the diff-as-artifact idiom.** A shadow is a
zero-risk challenger sampled alongside the primary dispatch:

```bash
fadeno dial shadow worker grok            # every worker dispatch
fadeno dial shadow worker grok --rate 0.2 # sampled trickle
fadeno dispatch --archetype worker --shadow grok  # one-shot opt-in
fadeno dial clear-shadow worker                   # clear one
fadeno dial clear-shadow                          # clear all
```

The shadow runs with the **byte-identical prompt** (`prompt_snapshot` and
`prompt_sha256` are the primary's) delivered isolated — a detached-HEAD
worktree at `.fadeno/local/shadow/<shadowId8>` — so a write-shaped shadow
yields a diff-as-artifact and never touches the workspace. Evidence fields:
`shadow: true`, `primary_dispatch_id`, `shadow_source: "attachment" | "flag"`,
`gate_eligible: false` (shadow rows are never gate-eligible, like
`shadow_only`), `output_snapshot: ".fadeno/local/outputs/shadow-<shadowId8>.md"`,
`diff_snapshot: ".fadeno/local/outputs/shadow-<shadowId8>.diff"`, and
`diff_bytes: <int>` (0 = clean). Shadow completions omit `workspace_changed`;
the diff is the change record. A `dispatch_refused` shadow carries
`shadow: true` + `primary_dispatch_id` and predicate `shadow_isolation` or
`shadow_resolution` (or the usual `eligibility`/`write_posture`/
`constraint_command`).

**Cancelling a running dispatch.** `fadeno dispatches --cancel tag:<handle>`
(or an id / 8+ character prefix) sends SIGTERM to that dispatch's supervisor,
which reaps the executor's whole process group:

```bash
fadeno dispatches --cancel tag:worker-parse-retry-header
```

This exists because a mid-flight correction otherwise had no path. A dispatch
proxy is right to refuse folding an amendment into a live dispatch — a second
executor would race the first on the same files — but until there was a way to
*stop* the first, a corrected instruction could be neither applied, safely
re-dispatched, nor aborted. The honest path is cancel, then re-dispatch with
the corrected prompt; the in-flight work is lost, which is the truth of it,
since the executor was working from instructions since withdrawn.

Delivering the amendment to the running executor is not possible and is not
attempted: every driver is a one-shot CLI that read its entire prompt from a
stdin that has since closed.

The supervisor publishes `{pid, started_at}` to
`.fadeno/local/inflight/<dispatchId>.json` while it runs and unlinks it on
exit — the kernel cannot publish this, because `spawnSync` yields a pid only
once the spawn has already finished. Cancel appends a `dispatch_cancelled` row
(`supervisor_pid`, `executor_started_at`) and stops there: the kernel still
writes the completion row when its spawn unblocks, normally
`signal: "SIGTERM"`. Cancel refuses — writing nothing — when the dispatch has
already completed, or when no claim exists on this machine, because either
would mean claiming to have stopped work this call never touched.

**Isolated host workspaces.** `fadeno dispatch-prepare <run> <dispatch-id> --isolate` is the opt-in isolated-host primitive: it validates `run` and `dispatch-id` against `HOST_WORKSPACE_SEGMENT_RE`, guards against traversal/symlink escape, serializes with `.fadeno/local/.host-workspace.lock`, creates an idempotent detached worktree at `.fadeno/local/host-worktrees/<run>/<dispatch-id>` from `HEAD`, and atomically records `workspace_mode: isolated` state at `.fadeno/local/host-workspaces/<run>/<dispatch-id>.json` (`workspace`, `base_commit`, `prepared_at`, plus `diff_snapshot`/`diff_bytes`/`finalized_at` after collection). After preparation, `dispatch-prompt` includes `workspace_mode: isolated` and the absolute workspace path (prompt bytes and digest unchanged); `dispatch-start` stamps `workspace_mode: isolated`/`workspace`/`base_commit` on `actor_dispatched` and bypasses the shared writer lease (read-only routes also bypass); `dispatch-complete`/`dispatch-fail` collect a binary staged diff to `.fadeno/local/outputs/host-isolated-<run>-<dispatch-id>.diff` before the terminal receipt (proving the worktree is the registered linked worktree before any `git add`/`diff` or removal), stamping `workspace_mode: isolated` plus `workspace`/`base_commit` and `diff_snapshot`/`diff_bytes` only when a diff was actually collected from the proven worktree. `dispatch-fail` degrades to a terminal receipt without diff keys whenever evidence is absent, unverifiable, or unrecoverable — including a missing or malformed machine-local state file — while a collection failure with the state present still refuses, preserving the worktree for retry; `dispatch-complete` may recover and collect from a verified ledger-named worktree when the state vanished but still refuses success when evidence cannot be collected. The worktree is removed only after the receipt is durable and only when proven registered (failures and degraded paths preserve the worktree for manual recovery; idempotent terminals reuse the receipt and retry cleanup only when verified; nothing auto-merges). `fadeno show` projects `workspaceMode`/`workspace`/`baseCommit`/`diffSnapshot`/`diffBytes` on `HostRequestView` (ledger-first, prepared-but-not-started degrades to isolated via machine-local state, missing state → shared/null, never throws) and prints isolated facts as non-gating observability; `verify` checks only ledger consistency and never requires machine-local state. See `src/lib/host-workspace.ts`, `src/commands/dispatch-prepare.ts`, `src/lib/host-dispatch.ts`.

**Cancelling a running engine attempt.** `fadeno cancel <run>` (or a unique run
prefix) targets the single live engine command claim for that run
(`engine-<runId>-<actorCallId>-a<attempt>.json`), signals the supervisor with
SIGTERM, or the negative executor process group when the supervisor is proven
dead (`ESRCH`), and never writes the run ledger. The active engine remains the
sole ledger writer and records the terminal `actor_failed` receipt. Cancel
refuses with a clear error when there are zero or multiple live claims rather
than guessing, preserves the workspace lease and inflight claim until
child-group termination is proven (`close`), and is safe against adversarial
process-group races. See `src/commands/cancel.ts`.

**Executor deadlines and idle observability.** Every command route in the
built-in catalog declares `timeout_ms: 1200000` (20 minutes); host routes may
not declare it. Arbitrary user catalogs may omit it (no deadline). The
supervisor owns the deadline: it sends SIGTERM to the executor process group
at `deadline_at = started_at + timeout_ms` and escalates to SIGKILL after the
5-second grace. Lease and claim release still waits for `close`, so a timeout
is not proven until the group is gone. CLI overrides: `--timeout <seconds>` on
`fadeno drive` and `fadeno dispatch` overrides the snapshotted route value; `0`
disables the deadline. Internal name is `timeoutMs`. Engine timeout receipts
are distinct: `actor_failed.reason = "executor_timeout"` with `timeout_ms` and
`deadline_at`, and ad-hoc `dispatch_completed.outcome = "timeout"` with the same
facts — process exit/signal facts remain present. Status-file timeout facts
(`timed_out`, `timeout_ms`, `deadline_at`) outrank the supervisor's exit
signal when classifying a receipt; wall-time is never inferred. Idle output
warnings are purely observational: `OUTPUT_IDLE_WARNING_MS = 300000` (5 minutes);
`HarnessObservedProcessView.outputIdleWarning` becomes true when a process is
alive and has emitted no output for five minutes (since start or since
`last_output_at`). CLI rendering is prominent but non-gating:
`WARNING: no output observed for <duration> (non-gating)` — idle never signals,
gates, or alters deadlines.

**Comparisons.** `fadeno dispatches --comparisons [--json]` scans the ledger,
pairs every shadow row with its primary via `primary_dispatch_id`, groups pairs
by challenger executor, and renders per pair: both id8s, archetype,
`primary executor (model) exit N, output B bytes` vs
`shadow executor (model) exit N, output B bytes, diff D bytes`, with a loud
`PROMPT SHA MISMATCH` flag if the two request rows ever disagree, and an
`[orphan]` mark when the primary row is missing. It then scans
`.fadeno/comparisons/*.md` (`kind: ModelComparison`) and renders one verdict
line per artifact under its challenger, plus a per-challenger tally
(`N pairs, M comparisons: X prefer_challenger / Y prefer_baseline / Z
tie/inconclusive`). Missing dir or no pairs is a friendly empty output, exit 0.

**Port-back.** Once a challenger has proven out, `fadeno shadow-apply
<pair-id|dispatch-id> [--arm challenger|primary] [--check]` gets its diff into
the real workspace — a kernel verb, not an instruction to a relay agent
(slots-and-archetypes.md, "Port-back is a kernel verb, not an instruction").
The id resolves either arm to its pair (full id or an 8+ character prefix,
same convention as `dispatches --output`/`--cancel`). `--arm` defaults to
`challenger`; `--arm primary` refuses on an ordinary paired primary — it
already shares the workspace, so there is nothing to apply — unless that
primary itself carries a `diff_snapshot` (it ran under `--isolate`). Applied
with `git apply --3way` against the pair's `baseline_commit`, so port-back
survives the main tree moving on while the pair ran; on any conflict it
stops, leaves the diff artifact exactly where it was, records the attempt,
and exits non-zero — it never auto-resolves. `--check` (`git apply --check
--3way`) reports applicability without mutating anything, including the
ledger. A successful (non-`--check`) attempt, clean or conflicted, is
recorded as a `shadow_apply` evidence row (`pair_id`, `arm`, `artifact`,
`baseline_commit`, `outcome`). A baseline commit that a `git cat-file -e` no
longer finds — for example, garbage collected after `fadeno clean --force`
removed its retained shadow worktree — is diagnosed by name rather than
surfacing git's own "lacks the necessary blob" error. See
`src/commands/shadow-apply.ts`.

**The adoption ladder:**

```
shadow (challenger, zero risk) → override (trial primary, instant revert) → dial (pin)
```

**MANDATORY confound.** A shadow runs against a detached-HEAD worktree, so
when the primary workspace was dirty the two saw **different trees despite
byte-identical prompts**. Every `ModelComparison` must state which case it was
in its `## Confounds` section (along with delivery transport, tool
availability, effort pinning, and isolation differences). The `model-tryout`
starter's judge prompt demands this, and the `judge-provider-differs`
guidance: the judge's provider should differ from both candidates, or the
conflict is recorded.

### Cross-harness subagents (dispatch proxies and steering)

`init --claude` and the plugin install three **dispatch proxy agents** beside
the host role subagents: `dispatch-worker` / `dispatch-reviewer` /
`dispatch-judge` (source: `templates/claude/claude-agents/dispatch-*.md`).
Each is a Bash-only `model: sonnet` agent whose single Bash call pipes the
received task prompt verbatim to `fadeno dispatch --archetype <a>` as a
quoted heredoc on stdin and relays the report verbatim — so a Claude Code
session can route worker/reviewer/judge-shaped subtasks to whatever executor
the active dial binds, including a non-Anthropic one. The kernel snapshots
the prompt under `.fadeno/local/prompts/` and writes the evidence rows; the
bare `fadeno` spelling keeps the call inside the `Bash(fadeno:*)` rule init
pre-approves. On a non-zero exit the proxy reports the failure plainly and
never attempts the task itself as a fallback.

`fadeno init --claude` installs two local `PreToolUse` hooks by default; use
`--no-steering` to opt out. The **spawn-rewrite hook** calls the structured
`fadeno dial resolve --archetype …` surface with the Claude harness identity
and rewrites command-delivered worker, reviewer, and judge `Agent` calls to
proxies — agents that name an archetype, never the `general-purpose`
catch-all. Host targets are rewritten to the matching Fadeno
role agent and requested model; the `current-host` default remains inert. It
preserves the rest of the Agent input and leaves general-purpose, Explore/Plan,
and unrelated specialists unsteered. Plugin users can combine the flag with `--data-only`; the
hook then targets the plugin-scoped `fadeno:dispatch-*` agents.

When it steers a spawn to a host role agent instead, the same hook appends a
`host_delivery` row to `.fadeno/dispatches.jsonl` (archetype, agent_type,
dial, executor, model, model_override, `reasoning_effort: "inherited"`,
`transport: "host"`, prompt_sha256, `hook_version`) plus a verbatim
prompt snapshot at `.fadeno/local/prompts/host-<sha8>.md`, so the file audits
both delivery routes. The kernel is not in the host path, so the hook is the
only possible evidence writer there; the row is best-effort and never changes a
steering decision. Caveat when editing the hook: host delivery can pin the executor's
**model** (the Agent tool's `model` parameter) but not its reasoning effort —
the Agent tool schema has no effort parameter, so `opus-xhigh` lands as opus at
the session's inherited effort, which is why the row records `"inherited"`
instead of the target's declared effort.

The **proxy relay guard** (`dispatch-proxy-guard.mjs`, also shipped in the
plugin's `hooks/hooks.json`) matches Bash and no-ops unless the hook input's
`agent_type` is a dispatch proxy. Inside a proxy it allowlists exactly the
relay-contract statements — this archetype's stdin-heredoc `fadeno dispatch`
line (the heredoc *body* is the user's task prompt and is never inspected),
the prompt-file retry, and the legacy prompt-file-write shapes older
init-emitted agents still use — denying anything else with an actionable
reason, and rewrites the dispatch call's Bash `timeout` up to 600000 ms.
Caveat: on harness versions that omit `agent_type` from hook input, the guard
no-ops silently (advisory-only). This is the tier-2 backstop for the proxy
body's instructions: source `templates/claude/hooks/dispatch-proxy-guard.mjs`,
tests `test/dispatch-proxy-guard.test.ts`.

The steering hook also stashes a **relay attestation** — `{timestamp,
prompt_sha256}` of the Agent call's prompt, appended to
`.fadeno/local/pending-relays.jsonl` — whenever a subtask heads to a dispatch
proxy. The kernel consumes a matching stash at dispatch time and marks the
evidence row `relay_attested` (true / false / absent), turning the proxy's
"verbatim" from an instruction into a checked claim.

> **Hook generations are ambiguous from the inside.** A harness binds hook
> *registrations* (like the agent and skill surface) at session start, but the
> script body is read from the plugin cache and has been observed refreshing
> mid-session after a plugin update — so never assume which generation of a
> hook is running. Test hook changes in a fresh session; in a running one, a
> just-fixed rung and a genuinely broken rung are indistinguishable without
> evidence. Hook-written evidence therefore carries `hook_version`: `dev` in the
> committed template under `templates/claude/hooks/`, and the package version
> in every copy `build:plugin` and `init` emit — so a row identifies the
> generation that wrote it, and "the fix doesn't work" separates from "the fix
> isn't loaded yet" from the evidence alone. Preserve the stamp when editing a
> hook that writes evidence.

Codex has no equivalent spawn-rewrite hook, and project custom-agent model
configuration is session-static. `fadeno init --codex` installs honest broker
definitions named `worker`, `reviewer`, and `judge`; `fadeno setup --codex`
records the harness, and later `fadeno dial` switches automatically refresh
the user-scoped agents when needed.
Use `fadeno steering apply --codex --scope project` for a project
override. Each host-routed slot becomes a host agent with that slot's
model and effort; each command-routed slot becomes a cheap broker that
delegates through `fadeno dispatch`. Before each task the role resolves the
active dials: a command-routed slot switches immediately, a matching host
slot runs in-session, and a different host slot uses its declared fallback
command when present. A fresh session activates changed host definitions;
it is required only when the selected host slot has no fallback command. The Codex plugin
bundles the CLI and built-in definitions; it does not overwrite unrelated user
agents. Existing files remain protected unless `--force` is supplied.

What stays unsteered: Explore/Plan-style read-only scouting — cheap, tightly
integrated with the harness's codebase tools, and not where quota pressure
lives. The arbitrage win is expensive worker turns.

> **Permission boundary:** the external executor a proxy dispatches runs
> *outside* the host harness's permission fences, under its own sandbox flags
> (e.g. `codex exec -s workspace-write`). Binding that executor via a dial is the explicit opt-in; the `.fadeno/dispatches.jsonl` evidence row
> is the compensating audit trail.

---

## Change templates (skills, playbooks, schemas, agents, hooks)

`templates/` is the single source of truth. The catch is that `plugin/` is a
committed copy generated from it.

1. Edit under `templates/`. (Skill bodies live in
   `templates/common/skills/*/SKILL.md` and are **shared across targets** —
   keep them sigil-free.)
2. `npm run build:plugin` — regenerates `plugin/` (skills/commands/agents) and
   rebuilds the bundled `plugin/bin/fadeno`.
3. Commit the regenerated `plugin/`. `npm test` runs the no-drift guard; if it
   fails, you skipped step 2.

Never edit files under `plugin/` directly — they're build output.

---

## Add a starter playbook

1. **`templates/common/fadeno/playbooks/<name>.yaml`** — first line must be the
   modeline `# yaml-language-server: $schema=../schemas/playbook.schema.json`.
   Use **block-style** sequences for `input`/`output` (see the YAML gotcha in
   architecture.md). Prefer explicit roles, typed artifacts, bounded loops, and
   structured gates.
2. `npm run validate:self` (or validate a temp `init`) — must pass with no errors.
3. **`templates/common/skills/fadeno-builder/SKILL.md`** — list it in the
   builder's "adapt a starter" catalog. This is test-enforced: a guard in
   `test/validate.test.ts` fails on any starter missing from the catalog.
4. `npm run build:plugin` + `npm run build:plugin:codex` + commit `plugin/`.

The test registries need no edits: completion, diagram, init, and validate
coverage all derive from `starterPlaybooks()` in `test/helpers.ts`, which
reads the playbooks directory itself.

Starters ship to **all supported targets** (they're under `common/fadeno`) and
are available from the bundled plugin runtime. `init` / `init --data-only` and
`vendor` remain the explicit project-copy paths.

---

## Add a harness target

This section is about adding a **host** — a harness Fadeno runs *inside*. A
harness Fadeno merely *drives* as a subprocess needs none of this; it is just
the `command:` of a route entry. See
[`architecture.md`](architecture.md) → *Glossary: harnesses, hosts, and drivers*,
which also records the `Target`/`targets:` collision this section straddles.

Adding a host (e.g. Cursor) is mostly **adapter work** — the skill *content* is a
cross-harness standard and is reused unchanged. Define the four adapter surfaces
alongside the current Codex, Claude Code, and Grok Build adapters:
install dir, bootstrap file + invocation sigil, invocation policy, and subagent
format.

1. **`templates/<target>/`** — the bootstrap file, subagent definitions in the
   host's format, and any invocation-policy file.
2. **`src/commands/init.ts`** — extend the per-target branches (skill dir,
   subagent copy, bootstrap name, any policy emit). Keep every write
   non-destructive via the `fsutil` helpers.
3. **`src/cli.ts`** — add the target to the `Target` type, the `SIGIL` map,
   `requireTarget`, the `parseArgs` options, and `HELP`.
4. **README** + the current adapter note/table in `docs/kickoff-memo.md` — document
   the new adapter row and distinguish host handles from namespaced plugin
   commands where applicable.
5. Tests in `test/init.test.ts` for the new tree, plus built-boundary assertions in
   `test/cli-integration.test.ts` and `test/plugin.test.ts` when bundled templates
   or CLI flags change.

If the host lacks host subagents, that's fine — the runner skill already
degrades to separate role-passes (and says so in the ledger).

---

## Release a version

1. Bump `version` in **`package.json`** (and add a `CHANGELOG.md` entry).
2. `npm run build:plugin` — this rebuilds `plugin/bin/fadeno` with the new version
   baked in (`--define`) and regenerates `plugin/.claude-plugin/plugin.json`.
3. `npm run build:plugin:codex` — the Codex plugin is generated by a separate
   script, and its manifest also carries the version; the no-drift test fails on
   a stale `plugin-codex/`.
4. Commit the regenerated `plugin/` **and** `plugin-codex/` along with the bump.
   The marketplace cache is **version-keyed**, so plugin users only pick up
   changes when the version changes — shipping template/skill edits to plugin
   users *requires* a bump.
5. `npm test` (includes the no-drift + binary guards).

The version is single-sourced from `package.json`: `packageVersion()` reads it in
the ESM build, and `build-bin.mjs` bakes it into the bundle as
`__FADENO_VERSION__`.
