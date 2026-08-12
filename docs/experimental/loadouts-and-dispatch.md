# Loadouts and the dispatch kernel

**Status:** layered catalog, safe-native defaults, user-scoped selection, and
explicit external dispatch implemented; strict mode remains deferred
**Decision date:** 2026-08-09
**Relationship:** extends the executor profile of
[`next-protocol.md`](next-protocol.md); sibling of
[`host-dispatch-contract.md`](host-dispatch-contract.md). Inherits the
next-protocol constraint set: no daemon, no cloud service, no scheduler.

## Observed need (admission receipts)

Two recurring behaviors from people using Fadeno in the wild:

1. **Subscription cycling.** Users run metered subscriptions across several
   inference providers and rotate which one does the expensive work as each
   quota depletes — e.g. Opus as the standard worker until the Anthropic sub
   runs low, then GPT‑5.6 Luna or Grok. The unit they think in is *"who is my
   worker / reviewer / judge right now,"* never a per-role YAML edit. Today
   that swap means hand-editing a dozen `bindings:` lines keyed by
   playbook-specific role names.
2. **Cross-harness subagents outside playbooks.** Users driving one harness
   (e.g. Fable in Claude Code) want their *subagents* to run on another
   provider (e.g. Luna via `codex exec`) — including subagents the harness
   launches automatically — because that is where their remaining quota or
   preferred model lives.

Both needs resolve to the same primitive: **role → archetype → executor
resolution, switchable at session level, invokable outside a playbook run.**
That primitive is the *dispatch kernel*. The playbook engine becomes one
client of it; ad-hoc subagent dispatch is the second.

## Vocabulary

- **Archetype** — the functional class of an actor: `worker`, `reviewer`,
  `judge` are the seeded three (matching the plugin's existing role-subagent
  trichotomy). Open set; bare lowercase identifiers.
- **Loadout** — a named mapping of archetype → executor. The switchable unit.
  ("Loadout," not "profile" — `ExecutorProfile` already names the parsed
  `executors.yaml` document in `src/lib/executors.ts`.)
- **Dispatch** — one resolution + invocation + evidence record, playbook-run
  or ad-hoc.

## Schema

`.fadeno/executors.yaml` gains two optional top-level keys beside the existing
`executors:` and `bindings:`:

```yaml
executors:
  opus-xhigh:        { adapter: command, command: [claude, -p, --model, opus, --effort, xhigh], model: opus }
  luna-cli-xhigh:    { adapter: command, command: [codex, exec, -m, gpt-5.6-luna, -c, 'model_reasoning_effort="xhigh"', -s, workspace-write, "-"], model: gpt-5.6-luna }
  terra-high:        { adapter: host, model: gpt-5.6-terra, reasoning_effort: high, agent_type: reviewer }

loadouts:
  anthropic-primary: { worker: opus-xhigh,     reviewer: terra-high, judge: terra-high }
  openai-primary:    { worker: luna-cli-xhigh, reviewer: terra-high, judge: terra-high }

default_loadout: anthropic-primary   # optional

bindings:                            # per-role pins; now optional if loadouts exist
  opus_reviewer: opus-xhigh          # deliberately-multi-model playbooks pin here
  "*": luna-cli-xhigh
```

Validation: every loadout slot must reference a declared executor; loadout
names and archetype keys are bare identifiers (`[a-z][a-z0-9_-]*`);
`default_loadout` must name a declared loadout. `bindings` may be omitted when
`loadouts` is present (previously it was required).

Playbook roles gain one optional field:

```yaml
roles:
  implementer:
    purpose: Make the code change.
    archetype: worker
```

`archetype` is advisory identity, not routing config — the playbook stays
harness- and provider-neutral. Validator checks the identifier shape only.
Template playbooks must not encode model names in role names
(`luna_implementer` → `implementer`); genuinely multi-model playbooks (e.g.
dual-model review) are the legitimate use of per-role `bindings` pins.

## Resolution

For each role, at dispatch time:

1. explicit `bindings[role]` pin;
2. active loadout's slot for the role's declared `archetype`;
3. `bindings["*"]`;
4. otherwise a hard, actionable error naming the role, its archetype, and
   what to add.

The **active loadout** is resolved: explicit `--loadout` → run-persisted intent
→ `FADENO_LOADOUT` → `.fadeno/local/loadout` → user state
`<state>/fadeno/loadout` → highest-layer `default_loadout` → bundled `native`.
The simple `fadeno use <name>` command writes user state; compatibility
`fadeno loadout use <name>` continues to write the repository-local pin.

`.fadeno/local/` is per-machine session state and must never be committed:
repos that commit `.fadeno/` should gitignore `.fadeno/local/` (scaffolding
adds this). This is what makes a loadout switch session-scoped instead of a
repo edit that dirties git for a quota condition that expires tomorrow.

**Resolution is computed at dispatch time, inside the CLI, never cached in
config emitted elsewhere.** Any integration (plugin agents, hooks) stays dumb
and calls `fadeno`; switching loadouts mid-session takes effect on the next
dispatch with no config churn.

## CLI

- `fadeno setup` / `fadeno use` / `fadeno status` / `fadeno doctor` — the
  low-friction setup path, user selection, effective state, and read-only checks.
- `fadeno loadout` — show the active loadout, its source, and the full
  archetype→executor table.
- `fadeno loadout list` / `fadeno loadout use <name>` / `fadeno loadout clear`
  — `use` writes `.fadeno/local/loadout`; `clear` removes it.
- `fadeno dispatch --archetype <a> [--role <name>] [--loadout <name>]
  [--executor <name>] [--prompt-file <path>]` — prompt from `--prompt-file`
  or stdin; resolves per the order above (`--executor` bypasses resolution
  for debugging); invokes the executor; report to stdout; appends one
  evidence row. Only `command` adapters are directly invokable — resolving
  to a `host` executor outside a host-dispatch session is a clear error
  ("bind a command executor for this archetype or run via host dispatch").

**Resolution echo:** every run start (`new-run`/`drive`) and every dispatch
prints where each actor landed, so a user burning a metered subscription
never wonders which provider a run is spending:

```
implementer → luna-cli-xhigh (gpt-5.6-luna) [loadout openai-primary]
opus_reviewer → opus-xhigh (opus) [binding]
```

## Evidence

- Playbook runs: the run ledger records the resolution snapshot — active
  loadout name + source, and per-role `(executor, model, resolution source)`
  — at first engine contact (`drive`), re-appended only when the resolution
  changes, so two runs of the same playbook under different loadouts are
  distinguishable artifacts after the fact. (Refined from "at run creation"
  during implementation: `new-run` never loads the executor profile, and
  snapshotting at drive time is the honest expression of "resolution is
  computed at dispatch time" — `new-run` still echoes a non-ledger preview.)
- Ad-hoc dispatch: append-only `.fadeno/dispatches.jsonl`, one row per
  dispatch: timestamp, archetype, role (if given), loadout + source,
  executor, model, exit status, duration, prompt digest, output digest.
  (Refined during dogfooding: each row also records `resolution` — how the
  executor was chosen: `binding` | `loadout` | `fallback` | `executor-flag`;
  and the file is per-machine evidence, gitignored by scaffolding — auditable
  locally, never committed, mirroring the `.fadeno/local/` rationale.)

This makes Fadeno the only layer that sees cross-provider usage — the natural
future home of per-provider burn reporting (a later `fadeno usage`; not in
this boundary), which closes the loop on the subscription-cycling need.

## Host steering integration

The harness will never run non-Anthropic inference natively (custom-agent
`model:` accepts Claude models only), so cross-harness subagents go
out-of-process: **dispatch proxy agents**, shipped in the plugin, one per
archetype (`dispatch-worker`, `dispatch-reviewer`, `dispatch-judge`):

- `tools: Bash`, `model: sonnet` — the proxy does no thinking, so the smallest
  model looked right; a dogfood A/B (2026-08-12) revised that. Haiku defected
  on the relay contract — performed a survey task itself with no dispatch and
  no evidence, and when it did comply it dropped the prompt's first line and
  asserted an evidence row that was never written. Sonnet relayed flawlessly,
  and a proxy turn is only a few relay tokens, so the upgrade costs cents.
- Behavior: ONE Bash call (tool `timeout` raised to 600000 ms — external
  executors routinely exceed the 2-minute default) that pipes the received
  task prompt **verbatim** to `fadeno dispatch --archetype <a>` as a quoted
  heredoc on stdin, then relays the report verbatim. The kernel writes the
  prompt snapshot to `.fadeno/local/prompts/` and the evidence rows itself —
  a single writer, so the recorded digest attests exactly the bytes it
  received. The call is spelled with bare `fadeno` first so the
  `Bash(fadeno:*)` rule `init` pre-approves also covers dispatches under
  default permissions (the `$CLAUDE_PLUGIN_ROOT/bin/fadeno` spelling is the
  not-on-PATH retry). One LLM copy step — prompt into heredoc — remains
  unavoidable; the relay attestation below checks it.
- The Agent-tool contract — self-contained prompt in, final report out, no
  shared conversation context — is byte-for-byte the one-shot executor
  contract, which is why this substitution is architecturally honest.

Steering ladder:

1. **Description routing** (shipped): proxy descriptions carry "use proactively /
   MUST BE USED for <archetype>-shaped subtasks when a Fadeno loadout is
   active." Soft but supported.
2. **PreToolUse rewrite hook** (shipped by default for Claude): match the `Agent` tool,
   return `updatedInput` rewriting worker-shaped `subagent_type`s to the
   dispatch proxies. Deterministic — covers automatically-launched
   subagents. The hook stays dumb; resolution stays in the CLI.
3. **Proxy contract guard** (shipped): a `PreToolUse` Bash hook scoped by the
   hook input's `agent_type` to the dispatch proxies. It allowlists exactly
   the contract call — the single stdin-heredoc dispatch statement, with the
   heredoc *body* (the user's task prompt) deliberately never inspected, plus
   the prompt-file retry and the legacy prompt-file-write shapes older
   init-emitted agents still use — denies everything else with an actionable
   reason, and rewrites the dispatch call's Bash `timeout` up to 600000 ms.
   The routing rungs steer *to* the proxy; this rung is tier-2 enforcement
   that the proxy *body* honors verbatim relay — instruction-only proxies
   were observed defecting (see the model note above). Caveat: the guard
   keys on the harness supplying `agent_type` in hook input; on harness
   versions that omit it the guard no-ops silently and the contract degrades
   to advisory.
4. **Strict mode** (deferred, opt-in): disable built-in agent types via
   `permissions.deny` / harness env flags so proxies are the only targets.

**Relay attestation.** The one unverifiable step left is the proxy copying
the prompt into its heredoc. The spawn-side steering hook closes it: whenever
a subtask heads to a dispatch proxy (rewritten *or* explicitly targeted), it
stashes `{timestamp, prompt_sha256}` of the Agent call's prompt to
`.fadeno/local/pending-relays.jsonl`. At dispatch time the kernel matches the
received prompt against fresh stashes (content-keyed, so concurrency is safe;
tolerant of the single trailing newline a heredoc appends; entries expire
after an hour) and marks the evidence row `relay_attested: true` (consumed
match), `false` (fresh stashes pending but none matched — the relay altered
the prompt), or omits the field (no hook flow in play). Evidence-only: it
never blocks a dispatch.

Codex does not expose the same spawn-rewrite hook. Project `init` installs
safe native broker agents by default; `--no-steering` selects the static legacy
agents instead. `fadeno setup --codex` records the harness and materializes
user-scoped managed agents; later `fadeno use <loadout>` refreshes them
automatically and requires a fresh session only when they changed. Explicit
project overrides remain available with `fadeno steering apply
<loadout> --codex --scope project`, which
materializes every loadout slot: host slots become session-native agents and
command slots become cheap brokers. Each role checks the kernel before every
task: a matching host slot runs locally, a command slot dispatches out-of-process
immediately, and a different host slot uses its declared `fallback_command`
when present. Only a host executor without a fallback returns
`restart_required`. Locked engine requests use `dispatch-fallback`, which
authenticates the run snapshot and records command transport rather than native
attestation. Applying changed agent definitions requires a fresh Codex session
to make the new model native; fallback-capable switches take effect at the next
role invocation without one.

This ambient precedence applies to ordinary ad-hoc role invocations and to
future engine requests before they are minted. Once `fadeno drive` records a
`host_dispatch_requested` event, that request is immutable: its delivered agent
must resolve the run/dispatch pair against the run's profile snapshot, and the
minted executor takes precedence over later environment, sticky-local, default,
or live-profile changes.

**What stays native:** Explore/Plan-style read-only scouting — cheap, tightly
integrated with the harness's codebase tools, and not where quota pressure
lives. The rewrite hook must be selective (worker-shaped types only). The
arbitrage win is expensive worker turns.

**Permission boundary (must stay loud):** an external worker invoked with its
own sandbox flags (e.g. `codex exec -s workspace-write`) runs *outside* the
host harness's permission fences. Enabling dispatch proxies is an explicit
user opt-in with this stated plainly; the dispatch evidence row is the
compensating audit trail.

## Non-goals

- **No auto-fallback.** Quota exhaustion pauses and offers explicit
  substitution (same-archetype executors from other loadouts as one-action
  choices). Silently swapping which model produced an artifact mid-run
  corrupts what the run's evidence means.
- **No resident router, daemon, or scheduler** (next-protocol constraint).
- **Loadout slots bind to executors, never bare model names** — effort and
  permission flags are harness-specific; the executor stays the unit of swap.
- **No harness-config caching of resolution** — the CLI is the single
  resolver.

## Sequencing

1. **Kernel:** schema (`loadouts`/`default_loadout`/`archetype`) +
   resolution + `fadeno loadout` + `fadeno dispatch` + evidence + echo.
2. **Plugin surface:** dispatch proxy agents + description routing +
   prompt-file relay convention.
3. **Host steering** (default for Codex/Claude): Claude hook rewrite + Codex role overrides.
4. **Strict mode** (deferred).

Slices 1–3 are shipped; strict mode would only sharpen routing, never change
resolution semantics.
