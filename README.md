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

Install the plugin for your harness, start a fresh session, and delegate
normally.

```text
/fadeno:setup                       # Claude Code — links the CLI onto your PATH
Add CSV export to the reports module, then have it reviewed.
```

That is the whole workflow. When the session spawns a subagent named after an
archetype, Fadeno resolves the model, cuts a worktree, injects the contract, and
records the dispatch. When the agent stops, the stop hook records that too. You
close it when you have decided what to do with the work:

```bash
fadeno dispatches                   # what is still open
fadeno dispatches csv-export        # the detail, including the report
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
branch named `fadeno/<name>`, cut from HEAD. The agent is told where it is, what
branch it owns, and that its final message must say what it did and where the
work lives. Two agents never share a tree.

If a task needs uncommitted work, commit it first — or ask for the live tree
explicitly (`--shared` on the command lane), and the agent is told it is sharing
and given the git rules that protect other people's work.

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
`--failed` — with an optional note. At every spawn your session is reminded of
every unclosed dispatch **in this repository**, by name. At five unclosed, the
next spawn is refused until you deal with some.

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
| `models` | Inspect the model registry; verify an alias resolves against its backend. |
| `dispatch` | Run one dispatch on the command lane, start to finish. |
| `dispatch-wait` | Block until a dispatch stops, then print its report — for work that outruns the caller's shell timeout. |
| `dispatches` | List dispatches, show one, print a report. |
| `dispatch-close` | Record the terminal decision. |
| `cancel` | Stop a running command-lane dispatch by signalling its process group. |
| `worktrees` | Every worktree holding work that is not on HEAD. |
| `context` | What a host session is told: archetypes, rules, open dispatches. |
| `feedback` | Record friction with Fadeno itself, or read what has been recorded. |
| `status` | Effective routing, harness integration, and whatever needs a person. |
| `clean` | Remove machine-local scratch — never prompts, never the ledger. |
| `setup` | Link the CLI onto PATH. A symlink, never a copy. |
| `plugin` | Generate the harness plugin from this checkout. |
| `completion` | Shell completion. |

`dispatch-open` and `dispatch-stop` also exist; they are the hooks' entry
points, and nothing else should need them.

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
unclosed_limit: 5
```

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

One asymmetry worth knowing: a Codex `PreToolUse` hook can **refuse** a spawn
and nothing else — it cannot rewrite one. So the host lane there is a two-pass
handshake. The first spawn is refused with the dispatch already open and the
exact call to make: agent type, model, reasoning effort, and the path to the
contract-bearing prompt. The retry carries that contract, Fadeno checks it names
a dispatch that is open and is being spawned on the model it was opened for, and
lets it through in silence. A repeated first pass returns the same dispatch
rather than opening a second.

It costs one round trip, and the correction is visible rather than applied
behind your back. A model Codex cannot deliver in-session still takes the
command lane, refused with the `fadeno dispatch` command that runs it.

---

## What Fadeno does not do

Each of these was in the product and was removed on purpose.

- **Structure workflows.** No playbooks, gates, run ledgers, or repair loops. A
  workflow is a sequence of dispatches, and composing it is the intelligence's
  job.
- **Adjudicate models.** No shadow pairs, no blinded judging, no bakeoff.
- **Enforce or attest.** No prompt digests, no tamper detection, no `verify`.
  The ledger records; it does not police.
- **Materialize agent files.** Model and effort are set at spawn time, so
  nothing is written to `~/.codex/agents` or `.claude/agents` and nothing goes
  stale. Fadeno does *report* a hand-written agent file, because such a file can
  silently override what a spawn passes.
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
