# Fadeno

**A meta-harness for subagent work — neutral across harnesses and models.**

> **Fadeno** /fah-DEH-no/ — Esperanto for *"thread."* The thread that runs through every agent task.

You delegate constantly: a worker to implement, a reviewer to check it, a scout
to go read something. Across two or three harnesses, on models you pick per job.
Fadeno makes that routine instead of fiddly. It does four things and nothing
else:

- **Routing.** Name a model once, point roles at it, change the binding at user,
  repo, or session scope with one command.
- **Spawning.** Launch a subagent from inside your session on the right model,
  in its own git worktree, with a contract it has to answer.
- **Logging.** A durable record of what was delegated, on what, and how it
  ended — written without anyone asking for it.
- **Context.** Your session knows which archetypes exist, where they route, and
  what is still open.

It is not a workflow engine. It has no daemon, no cloud service, no scheduler,
and no opinion about what your work should look like. Composing a sequence of
dispatches is the intelligence's job; Fadeno wraps each one and keeps the books.

---

## Quickstart

Install the plugin for your harness, start a fresh session, and activate host
mode.

```text
$fadeno-host                        # Codex
/fadeno:host                        # Claude Code
Add CSV export to the reports module, then have it reviewed.
```

There is no required setup command. On its first Codex activation,
`$fadeno-host` installs the model-neutral `fadeno-*` archetype names into the
user agent directory. Codex reads those names at session start, so that first
activation may ask for one more fresh session; later activations are an
idempotent check. Claude ships its vocabulary inside the plugin. `fadeno setup`
remains available only when you want a convenient `fadeno` link on your shell
`PATH` (and, on Claude, its CLI permission).

That is the whole workflow. When the session spawns a subagent named after an
archetype, Fadeno resolves the model, cuts a worktree, injects the contract, and
records the dispatch. When the agent stops, the stop hook records that too. You
close it when you have decided what to do with the work:

```bash
fadeno dispatch                       # what is still open
fadeno dispatch csv-export             # the detail, including the report
fadeno dispatch run sol                # launch by registered model ref
fadeno dispatches                      # compatibility spelling for reads
fadeno logs csv-export              # the command-lane internal activity stream
fadeno dispatch-close csv-export --merged
```

Requires **Node.js ≥ 20**.

---

## Archetypes and dials

An **archetype** is a role. Five ship, and the set is open:

| Archetype | What it is for |
|-----------|----------------|
| `worker` | Implements a described change in its own worktree, commits it, and reports what the tree holds. |
| `reviewer` | Reviews a change for correctness, edge cases, safety, and tests. Reports findings, changes nothing. |
| `judge` | Evaluates candidate attempts against stated criteria and picks a winner. |
| `scout` | Explores and reports. Searches, gathers facts, summarizes, changes nothing. |
| `director` | Coordinates a whole task: decomposes it, spawns the others, integrates, reports. Never does the work itself. |

A **dial** binds an archetype to a model:

```bash
fadeno dial                          # every archetype, where it goes
fadeno dial worker sol@high          # bind one
fadeno dial reviewer opus --session  # this checkout only, until cleared
fadeno dial worker+reviewer grok     # several at once, atomically
fadeno dial clear reviewer
```

Dials cascade **binding → session dial → repo pin → user dial → base**, most
specific wins. An archetype with no dial anywhere runs on your session's own
model, which is the sensible default and needs no configuration.

Codex model names may change; the agent files do not follow them because they
contain no model or reasoning effort. `host` always means the current session
model, while named aliases resolve from the current catalog at every spawn.
After a provider or Codex upgrade, `fadeno models verify` checks named model
deliveries against the backend listing. With no refs it checks every named
delivery in the effective archetype dials; pass one or more registered aliases,
provider/id identities, or delivered ids to check them directly, including an
alias no archetype currently dials. A removed model is an error to fix with a
dial or catalog change, never a silent fallback.

Routing is invisible by default: you name an archetype and Fadeno applies the
model. Two escape hatches exist and are not encouraged — `fadeno dial resolve
--archetype worker` to inspect one, and an explicit model on a spawn to escalate
a task that keeps failing.

## Lanes

Every dispatch takes one of two lanes, and **which one is Fadeno's business, not
yours**:

- **Host lane** — the model is one your session can deliver, so the dispatch is
  a subagent inside your session. The spawn hook rewrites the call in place.
- **Command lane** — the model lives somewhere else, so Fadeno spawns that
  harness's CLI as a process. On Claude the spawn is retargeted to a minimal
  **dispatch proxy** whose only job is to invoke it, so the session still sees
  an ordinary subagent.

Both lanes do the same four things: resolve the model, choose the lane, cut a
worktree, and record the dispatch.

## The worktree contract

Every dispatch gets its own git worktree under `.fadeno/local/worktrees/`, on a
branch named `fadeno/<name>`, cut from HEAD by default. `--from` accepts a
dispatch name or id and follows the ledger to that dispatch's reachable branch;
it never substitutes the dispatch's opening `workspace.base`, because that may
omit the work the dispatch produced. A shared-tree dispatch has no attributable
retained result and cannot be used as a baseline. If a referenced branch/result
is unavailable, commit the desired state and pass that Git ref or commit SHA
instead. Existing Git refs and commit SHAs continue to work.

If a value matches both a dispatch reference and a Git ref, Fadeno refuses to
guess: qualify the Git ref (for example `refs/heads/main`) or use the
dispatch's full UUID. An exact dispatch name that is another dispatch's id
prefix is likewise ambiguous and requires a full UUID. `--shared` and `--from`
are incompatible; choose the shared tree without `--from`, or remove
`--shared` to cut the named baseline. The agent is told where it is, which
modifications and commits belong in that assigned tree, and that its final
message must say what it did and where the work lives. A caller-authorized
read-only inspection outside the assigned tree is allowed; modifications and
commits stay in the assigned tree.
Implementation and integration tasks carry commit and upstream duties; review,
scouting, judging, and other report-only tasks change nothing and recommend
`reviewed`. Two agents never share a tree.

If a task needs uncommitted work, commit it first — or ask for the live tree
explicitly (`--shared` on the command lane), and the agent is told it is sharing
and given the git rules that protect other people's work. An invalid explicit
`--from` is refused, and a worktree-creation failure does not silently turn
that requested baseline into a shared-tree run. Without `--from`, an
environmental worktree failure may still use the shared tree and says why.

**Fadeno performs no merge.** It never touches your branches, never rebases,
never resolves a conflict. Merging is judgment, and judgment is yours.

## The ledger

`.fadeno/dispatches.jsonl` is append-only and holds three row types, because
"started", "the agent stopped", and "the host decided" are three facts recorded
by three parties at three times:

```
opened   id · name · at · session · parent · archetype · model · effort
         explicit_model · lane · harness · workspace{path,branch,base}
         task · prompt · process_group

stopped  id · at · final_message · dirty · model_observed

closed   id · at · verb · note
```

`task` holds the first ~300 characters of what you asked; the full prompt lives
at `.fadeno/prompts/<id>.md`. The log records **what was asked, never what
Fadeno injected** — the injected text is identical every time.

`model_observed` is the model the agent reported running on, read from its
transcript. It is the only way to catch a harness that quietly ignored the model
the spawn passed.

### Closing, and the nag

Closing takes exactly one verb — `--merged`, `--kept`, `--discarded`,
`--failed`, or `--reviewed` — with an optional note. `--reviewed` is a neutral,
report-only acknowledgement; it makes no claim about where the work landed.
At every spawn and every host user turn your session gets a reminder derived
from every unclosed dispatch **in this repository**, by name. Unclosed rows are
advisory state: they never refuse another spawn.

The scope is deliberate. A director that spawns three workers and exits leaves
dispatches with no owner; session scope would hide them forever, which is
exactly where nesting happens. Grandparents inherit orphans.

`fadeno worktrees` is the cross-session safety net: every Fadeno worktree
holding uncommitted paths or unmerged commits, joined to the dispatch that owns
it. A tree it cannot read is reported as unreadable, never as clean.

---

## Commands

| Command | Does |
|---------|------|
| `dial` | Show, set, clear and resolve archetype bindings. With no arguments, the reference to read before delegating. |
| `models` | Inspect the model registry; verify dialed deliveries or explicit registry refs against their backends. |
| `model run` / `models run` | Run one registered model directly with a positional, stdin, or file prompt in temporary scratch. |
| `dispatch` | List or inspect dispatches, or run one on the command lane. Launch with the legacy `--archetype`/`--model` flags or `dispatch run <archetype-or-model>`; the launcher emits a command-process liveness echo to stderr every five minutes by default while the executor is in flight (`--heartbeat 0` disables it, and `--heartbeat <seconds>` overrides it). |
| `dispatch-wait` | Block until a dispatch stops, then print its report — for work that outruns the caller's shell timeout. Only a `stopped` row is report-ready; a close-only command dispatch remains running until its process stops or is reconstructed after the settle window. |
| `dispatches` | Compatibility alias for the `dispatch` list, detail, and report reads. |
| `logs` | Read a command-lane dispatch's internal activity stream; `--tail <lines>` selects the latest lines and `--follow` streams until it stops. |
| `dispatch-close` | Record the terminal decision. |
| `cancel` | Stop a running command-lane dispatch by signalling its process group. |
| `worktrees` | Every worktree holding work that is not on HEAD. |
| `context` | What a host session is told: archetypes, rules, open dispatches, and the compact host-turn reminder. |
| `feedback` | Record friction with Fadeno itself, or read what has been recorded. |
| `prompt-stage` | Stage plaintext for Codex's sealed-prompt spawn handshake; returns a one-use `task_name`. |
| `status` | Effective routing, harness integration, and whatever needs a person. |
| `clean` | Remove machine-local scratch — never prompts, never the ledger. |
| `setup` | Optionally link the CLI onto PATH; Codex host mode uses its narrow agent-vocabulary mode automatically. |
| `plugin` | Generate the harness plugin from this checkout. |
| `completion` | Shell completion. |

`dispatch-open` and `dispatch-stop` also exist; they are the hooks' entry
points, and nothing else should need them.

A dispatch must return its own report. If a process tries to close the dispatch
whose id is in `FADENO_DISPATCH_ID`, `dispatch-close` refuses and tells it that
the caller/host must close it; a parent process may still close a child it
opened. This prevents a close row from hiding a live command-lane report.

For a one-shot smoke test that is not a dispatch, run a registered model
directly. The alias may include the usual effort and harness ref syntax, such
as `sol@high on codex` (quote it as one shell argument):

```bash
fadeno model run sol "Reply exactly: Hello, World!"
printf '%s\n' 'Reply exactly: Hello, World!' | fadeno models run sol
fadeno model run sol --prompt-file prompt.txt
```

The command harness receives the compiled model id and effective effort, and
runs in a fresh temporary directory. Its stdout, stderr, and exit status pass
through unchanged. This creates no dispatch ledger row, prompt evidence,
worktree, branch, or close obligation. Additional positional prompt words are
joined with single spaces; do not combine them with stdin or `--prompt-file`.

Run `fadeno <command> --help` for exact usage and only that command's options.

## The catalog

`.fadeno/executors.yaml` holds the model registry and the harness table. A
shipped catalog covers the common models and every harness below, so a repo
needs no catalog at all; a project or user file extends or overrides it under
the same layering rules.

```yaml
schema_version: 4
models:
  sol: { provider: openai, id: gpt-5.6-sol, effort: high }
harnesses:
  codex:
    provider: openai                 # models of this provider come home here
    host: { effort_channel: agent-file, relay: luna@high }
    command: [ codex, exec, --model, "{model}", "-" ]
dials:
  worker: sol                        # a repo pin, committed
archetypes:
  auditor:
    description: Checks a change against the compliance checklist.
```

Older catalogs may still contain `unclosed_limit`; Fadeno reads it for
compatibility, reports that it is retired, and ignores it. Spawning is
unlimited.

A harness is a **host** when Fadeno can run inside it (`host:`) and an
**executor** when Fadeno can spawn it (`command:`). Most are both. A harness has
exactly one command lane — an argv and nothing more. Every shipped lane carries
its vendor's headless-approval flag and no restricting one; to run something
restricted, declare your own harness entry with its own flags, where a reader
can see them.

## Harness support

| Harness | Host | Driver | Note |
|---------|------|--------|------|
| Claude Code | yes | yes | Ships Node; hooks work out of the box |
| Codex | yes | yes | Hook trust is a prerequisite for host use |
| omp | yes | — | Reuses Claude-style hook manifests |
| Grok, OpenCode, Muse, Antigravity | — | yes | Driver-only |

A **host** harness is one where Fadeno can observe a spawn, which in practice
means Claude- or Codex-compatible hooks. Everything else is reached through the
command lane, which loses nothing: that is where Fadeno controls the process
outright.

On Codex, read `fadeno dial <archetype> --json` immediately before spawning
`fadeno-<archetype>` and put its resolved model and effort on the spawn. Resolve
the CLI as the Codex setup skill does (the plugin's sibling launcher when
present, otherwise `fadeno` on `PATH`). Before that spawn, stage the exact task
with the resolved launcher and `prompt-stage --name <semantic-name>
--prompt-file <file> --json` (or stdin), then put the returned `task_name` on
the spawn exactly. It contains a readable lowercase slug and an opaque
lowercase token, is bound to this repository, expires after ten minutes, and is
consumed once. `PreToolUse` reserves one same-session/same-archetype handoff
slot and recovers the staged plaintext even when Codex encrypts `message`;
`SubagentStart` then atomically claims that handoff, opens the dispatch, creates
the worktree, binds the agent id, and delivers the contract. A readable prompt
without a staged token remains supported for older Codex versions.

Codex native subagent threads have a runtime concurrency limit; command-lane
processes do not consume native slots. Keep the host lane for interactive work
and use the command lane for planned overflow or broad fan-out. If a correctly
routed spawn fails before opening with `agent thread limit reached`, retry the
identical archetype, model, effort, prompt, and worktree policy via direct
`fadeno dispatch`; do not substitute a model. Run it in a managed foreground
shell, never with `nohup` or a manually invoked executor argv, and use
`fadeno dispatch-wait` if the shell yields. A native capacity refusal creates
no dispatch, so omit `--dispatch` when recording that friction with
`fadeno feedback`.

Codex's inability to rewrite a spawn does not require the command lane. When
the resolved model belongs on that lane, the hook refuses the spawn with the
`fadeno dispatch` command for the host to run. Calling that command directly
explicitly chooses process execution rather than host delivery.

---

## What Fadeno does not do

Each of these was in the product and was removed on purpose.

- **Structure workflows.** No playbooks, gates, run ledgers, or repair loops. A
  workflow is a sequence of dispatches, and composing it is the intelligence's
  job.
- **Adjudicate models.** No shadow pairs, no blinded judging, no bakeoff.
- **Enforce or attest.** No prompt digests, no tamper detection, no `verify`.
  The ledger records; it does not police.
- **Materialize routing into agent files.** Codex needs user-scoped files to
  expose custom agent names, so Fadeno maintains the smallest possible files:
  archetype name, description, and contract bootstrap only. They contain no
  model or effort. Fadeno reports a hand-written same-named file rather than
  overwriting it, because its model could silently override what a spawn
  passes.
- **Police concurrent writes.** No lease, no lock, no overlap stamps. Worktrees
  and real merges remove the shared-tree world that machinery existed for.
- **Impose deadlines.** Nothing Fadeno launches is killed on a timer. You may
  stop it — that is `cancel` — but Fadeno never decides to on its own. A clock
  cannot tell slow from stuck. `dispatch-wait` bounds how long a caller BLOCKS,
  never how long the work runs; when it says "still running", asking again is
  the whole answer.
- **Decide what work is worth keeping.** It never destroys a worktree holding
  uncommitted work, and never judges whether output matters.

## Honest limits

- **Containment is the worktree, and the worktree contains file writes only.** A
  spawned agent can still reach the network, a package registry, and any
  credential in your environment. No shipped lane runs an OS sandbox; every one
  carries its vendor's headless-approval flag, because a command lane stricter
  than the host that spawned it converts a permitted action into a
  mid-assignment denial. Declare your own restricted harness entry if you want
  otherwise.
- **`final_message` records presence, never completeness.** On an interrupted
  Claude subagent the harness supplies no message at all, so its absence says
  nothing about whether the work finished.
- **Under Codex, the correction goes through the model.** The hook can refuse
  and check but not apply, so a session that ignores the refusal simply does not
  get a dispatch. Nothing runs unrecorded — but nothing runs, either.

## Contributing

`AGENTS.md` orients a contributor in sixty seconds; `docs/architecture.md`
explains how the code is built and `docs/extending.md` how to change it. The
design is specified in `docs/redesign/spec.html`, with the reasoning for each
call in `docs/redesign/decisions.html`.
