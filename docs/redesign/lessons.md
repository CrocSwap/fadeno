# Lessons for the rebuild

Harvested 2026-09-07 from the test suite before the trunk rewrite: the 42
surviving files at `fc5e1ae`, plus the scenarios in the deleted files at
`c53e201` whose subject has a successor in the spec. One line per behaviour
worth keeping, written in the spec's vocabulary rather than the old code's.
The tag after each line names the test it came from, so the reasoning is
recoverable with `git show c53e201:test/<file>.test.ts`.

Anything in a test that is not on this list was judged to belong to a
subsystem the spec deletes. A rebuild that finds itself re-implementing
something absent here should stop and check `spec.html` §09.

The recurring theme, stated once so it need not be repeated below: **the
worst bug is a confident wrong answer.** Absence of evidence must render as
"cannot say", never as "clean"; a reader that meets a row it does not
understand counts it, never drops it; a write that fails must not change the
decision it was recording.

---

## 03 Routing

**Resolution**

- An archetype with no dial resolves to current-host, source `base`; no dial
  means no model, no harness, host lane. (dials-kernel: cascade; catalog-v4:
  bare shell)
- The cascade is per archetype: session → repo → user → base. A session dial
  for `worker` never binds `reviewer`. (session-dials; dials-kernel: cascade)
- A dial pointing at another archetype is followed to a terminal model; a
  cycle is refused at parse time and at resolve time. (generator-archetype:
  fallback cycle; dials-kernel: cascade fallback chain)
- Effort rides with the model: `ref@effort` parses and formats as one unit,
  and the resolved effort is reported separately from the pin so a reader
  can tell "asked for" from "got". (dial-cli: pin vs resolved effort)
- The same ref resolves in-session under its own harness and as a spawned
  process under another; one table, no per-host branches. (catalog-v4;
  executor-harnesses: reachable from every host)
- Resolution never depends on which harness the caller sits in for an
  identically shaped route. The old gate refused under Claude and allowed
  under Codex for the same dial: a coin flip, not a safety property.
  (dispatch-delivery-gate, deleted)
- A bare shell is `standalone`: no memo on disk, no last-setup guess, no
  inherited frame from a parent host. An executor child sheds the host frame
  its parent had. (harness-frame; low-friction-journey: nested hosts abstain)
- `dial set` validates against the registry only. It does not narrate the
  lane and does not refuse on eligibility, because both are questions about
  a call, not a binding, and the answer changes per terminal. (dial-set)
- Setting several archetypes at once is atomic: one refusal writes nothing.
  (dial-set: set many)
- Reserved words and duplicates are refused at set time with a single error
  shape. (dial-set)
- Clear without an archetype wipes session and user dials and preserves repo
  pins. A plain clear falls through to whichever layer actually holds the
  dial. (dial-set: clear)
- The repo file is edited through a document parser so comments survive a
  dial write. (dial-set: --repo preserves comments)
- A dial that introduces a provider nothing else uses says so. (dial-set)

**Catalog**

- A misspelled top-level key fails loudly, names the file that carries it
  even under user/project layering, suggests a near match when there is one,
  and gives the key list when there is not. A bad guess is worse than no
  guess. (catalog-key-strictness; cli-flag-scope: bad guess)
- A key known in one layer but illegal in this one keeps its own precise
  message instead of "unknown key". (catalog-key-strictness)
- Every advertised top-level key survives the merge and reaches the parsed
  profile: the tripwire that caught a declaration silently thrown away.
  (catalog-key-strictness)
- Exactly one home harness per provider; every model must reach some
  harness; a harness that is neither host nor driver is refused at load.
  (dials-kernel; executor-harnesses)
- An undeliverable model in the USER catalog is dropped with a note; the same
  model declared in the PROJECT catalog is a load error. Dialing the dropped
  alias fails loudly and names the fix. (catalog-v4: regression ×4;
  model-fallback)
- A user alias falls back into a self-contained project catalog when its
  harness resolves there; a project model of the same name wins and the user
  entry neither overrides nor drops. (model-fallback)
- Legacy spellings (`via`, `delivery:`) are read and translated, never
  written back, and never reach a parse throw. (catalog-v4: user layer)
- An obsolete key gets migration instructions, not a did-you-mean.
  (catalog-key-strictness: pre-dials catalog)
- Prototype hardening: catalog lookups use own-property checks.
  (dials-kernel)

**Command lanes in the catalog**

- Every shipped command lane carries its vendor's headless-approval flag and
  no restricting one, because a headless run DENIES an unresolved permission
  prompt rather than leaving it pending; a new lane must be added to the
  list that asserts this. (catalog-v4; executor-harnesses)
- No lane carries an empty argv element. (executor-harnesses)
- The Antigravity lane keeps the three flags that stop it exiting 0 having
  done nothing. (executor-harnesses)
- A lane that can be listed declares its listing command. (executor-harnesses)
- Whether an argv grants the fadeno shell is read from the VALUES of the
  permission flags in one predicate with two consumers; a bare tool name
  inside a multi-rule value counts. (argv-fadeno-shell; models: shipped
  catalog fadeno_capable ×2)
- A file-reading executor receives the prompt through a `{prompt_file}`
  placeholder substituted into its argv. (muse-executor)

**Models registry**

- The listing is parsed per line, not per whitespace token: one backend's
  `id<TAB>Description` turned 31 models into 100. (models --harness)
- A listing failure — non-zero exit, missing binary, timeout, throw — is
  reported, never thrown; an empty listing is a success with no ids.
  (doctor-model-listing)
- A dialed model the backend no longer lists is ONE warning naming the fix;
  an unlistable harness is silence, not a finding; current-host is never
  checked against a listing; a failed listing for a harness nobody dials is
  silent. (doctor-model-listing)
- `models verify` re-probes past the cache; a listing that omits the model
  deletes its cached rows and fails; an unreachable listing leaves the cache
  alone and passes unless `--strict`; an unmatched ref is an error, never an
  empty pass. (models-verify)
- `models remove` preserves comments and siblings, names a lower-layer file
  rather than touching it, refuses while a dial names the alias, and
  `--force` says what it strands. (models-remove)
- `model` is a registered alias of `models` for flag validation and help.
  (models; models-verify)
- Rows sort by home harness, then provider, then name; the home harness is
  stable while the caller-specific adapter changes. (models)

## 04 Spawning — host lane

The three hook files that survive (`dispatch-steering.mjs`, Codex
`spawn-guard.mjs`, omp `fadeno-steering.ts`) are the seed of the spec's
spawn wrapper. What they got right:

- The hook shells out to `fadeno dial resolve --archetype <a>` with a budget.
  A resolver that hangs is `resolver_timeout`; one that never started
  (ENOENT) is `resolver_error`; the two are told apart because "raise the
  budget" is the wrong advice for "fadeno is not installed".
  (codex-spawn-guard; steering-refusal, deleted)
- Unreadable resolver output fails CLOSED in host mode and fails OPEN outside
  it, and says which. (codex-spawn-guard; resolution-strictness: hook)
- In host mode a generic spawn — including one that names no subagent type
  at all, which is the most generic spawn there is — is refused, with the
  identity it would have inherited, the way out, and the instruction to
  report it. Outside host mode it is allowed, unrewritten, and recorded.
  (codex-spawn-guard; steering-refusal, deleted)
- A rewrite records what it applied (`model_applied`), distinct from an
  explicit override the caller passed. (resolution-strictness: hook)
- A failing evidence write never changes the spawn decision. (steering-
  refusal, deleted)
- A repo with no `.fadeno` is still guarded but never written to; the hook
  never conjures the tree. (codex-spawn-guard; dispatch-proxy-guard)
- A refusal reason is bounded and single-line on the row; the caller still
  gets the full text. (steering-refusal, deleted)
- Non-spawn tools pass through untouched. (codex-spawn-guard)
- A hook's evidence row carries the hook's own version stamp, replaced at
  plugin build from the package version; plugin hooks load once per session,
  so the stamp is how a stale hook is recognised. (dispatch-agents;
  plugin-codex)
- Codex: an agent file whose managed header, name, or path disagrees with
  the requested type is generic, and a filename is never a spawnable type; a
  path traversal in `agent_type` is generic. (codex-spawn-guard)
- Codex: a project-scope agent file shadows the user-scope one entirely.
  (codex-spawn-guard)
- The two harnesses' stop hooks ship one body and differ in one constant,
  so a fix cannot land on one side only. (agent-stop)

**Dispatch proxies**

- A proxy relays the prompt file verbatim; hostile bytes inside a heredoc
  body are never inspected — the body is the task, only the surrounding
  statements are grammar. (dispatch-agents; dispatch-proxy-guard)
- The proxy's Bash call gets the long timeout only when it matches the
  contract grammar; an already-long timeout passes through; a call with no
  dispatch statement is not rewritten. (dispatch-proxy-guard)
- A worker proxy may not dispatch as reviewer; reviewer and judge proxies
  enforce their own archetype; freelancing is denied with an actionable
  reason. (dispatch-proxy-guard)
- An unsubstituted `<placeholder>` in a proxy call is denied where the
  message can name the substitution, not passed to a kernel that rejects it
  later. (dispatch-proxy-guard)
- A proxy is told in so many words what the completion verdict means and
  that any attestation-like field is not one; on 2026-08-22 a proxy relayed a
  killed executor as completed. (dispatch-agents)
- The main session is never guarded and never marked; only role agents are.
  (dispatch-proxy-guard; codex-dispatch-proxy-guard, deleted)
- Role agents are refused the six git subcommands that destroy shared work
  (checkout, switch, restore, reset, stash, clean), with the harm named;
  `stash list`, `stash show` and `clean --dry-run` stay allowed because they
  only read; env assignments and wrappers do not launder it; the word
  appearing in ARGUMENTS or a heredoc body is not an invocation; `commit` is
  deliberately not on the list. Every other Bash call is theirs.
  (dispatch-proxy-guard; codex-dispatch-proxy-guard, deleted)
- The guard keys on the agent type; a `general-purpose` agent spawned by a
  director is unguarded, and one ran a bare `git stash` in a worktree during
  this session. Under the spec every spawn passes through the hook, so the
  guard should key on "is this a Fadeno dispatch", not on the type name.
  (session notes, 2026-09-06)
- A proxy-addressed prompt handed to an executor makes it re-dispatch
  itself (the 2026-08-31 recursion); an executor learns which dispatch it
  is and may not dispatch again by default; a director carries `allow` and
  does not hand it down. Provenance is written, never merely omitted.
  (dispatch-nesting)

## 04 Spawning — command lane

- An empty or whitespace-only prompt is refused before anything is spawned;
  empty stdin is a clear error, not a silent empty dispatch. (dispatch-
  papercuts)
- Unknown `--model` is rejected with the list; `--archetype` is required
  unless `--model` bypasses. (dispatch-cli, deleted)
- The executor's exit code is propagated and recorded. (dispatch-cli,
  deleted; dispatches-cli: FAILED)
- A per-call harness override escalates this one dispatch and never moves
  the dial. (dispatch-host-lane-guidance, deleted)
- The executor transcript is retained on disk and the PATH is relayed, not
  the bytes; a failing dispatch gets a bounded excerpt that names the sample
  and where the rest is; truncation is never silent; the retained file is
  bounded too and its marker says it is a floor. (dispatch-stderr-transcript)
- Exit 0 with no output is reported as "the executor wrote NOTHING", never
  as a path to an empty file. (dispatch-stderr-transcript; dispatches-cli:
  `empty`)
- A nonzero executor exit gets one stderr diagnosis line; stdout stays pure.
  (dispatch-papercuts)
- A blocking wait heartbeats elapsed time to stderr so a long healthy run is
  distinguishable from a dead one; elapsed reads like a clock at every
  magnitude. (dispatch-output)
- Supervision is invisible: stdin, stdout and exit code pass through
  unchanged; a nonzero exit is verbatim; a signal is relayed as a signal,
  not translated to an exit code. (supervisor, deleted)
- A missing executor binary is told apart from an executor that itself
  exited 127, by the supervisor's own marker and nothing else. (supervisor,
  deleted)
- Killing the CLI reaps the executor instead of orphaning it; the dogfooded
  failure was twenty files landing after the dispatch was reported failed.
  (supervisor, deleted)
- A dispatch that completes normally leaves no supervisor behind; the row is
  written after the child closes, so a recorded end time is itself evidence
  nothing is still running. (supervisor, deleted)
- Harness identity variables are stripped from the executor child's
  environment so a nested run does not inherit the parent's frame.
  (runtime-sync, deleted; harness-frame)

## 04 Worktree

- Cut from HEAD; the caller's dirty tree is untouched and never carried.
  (dispatch-isolation, deleted: cut from HEAD; spec 19 supersedes the
  advisory in dispatch-dirty-base-advisory — it becomes a refusal)
- Untracked files alone are not "dirty" for the purpose of refusing a cut;
  only tracked changes count. (dispatch-dirty-base-advisory)
- Cutting a worktree neither consults nor creates any repo-wide state; two
  cuts never collide. (dispatch-isolation, deleted)
- A non-git directory refuses before creating anything; a caller's explicit
  isolation request that cannot be honoured is a refusal, never a silent
  run in the tree. (dispatch-isolation, deleted; dispatch-cli, deleted:
  --isolate without git)
- Path segments are validated: `.`, `..`, absolute, slash-bearing and
  symlinked segments are rejected. (host-workspace)
- A worktree registration that is broken (dangling `.git` pointer) degrades
  without deleting the plain directory; a plain directory at the recorded
  path is never staged or deleted. (host-dispatch-isolated, deleted)
- Removal proves the path is the exact registered worktree before removing
  it; a sibling dispatch's worktree is never touched. (host-workspace;
  host-dispatch-isolated, deleted)
- `clean` deregisters real worktrees rather than orphaning them, tolerates a
  directory already gone, tolerates a repository git cannot read, and is a
  dry run by default. (clean)
- A worktree holding gitignored output (`data*/` was the field case) is
  never destroyed: merged or not, the tree is kept and the receipt says
  where and why. (ignored-output, deleted; dispatch-adhoc)
- A wholly-ignored directory is one git entry; a filename is not a reading
  of contents; a scan that cannot enumerate takes the loud form, never the
  quiet one; only git saying "nothing" counts as nothing. (ignored-output,
  deleted; spec §11)
- `.fadeno/` is excluded from output scans on a path boundary, not a string
  prefix. (ignored-output, deleted)
- Merge-back stages nothing: the caller's index is exactly as they left it.
  Conflict markers stay in the retained worktree as an ordinary dirty tree,
  never in the caller's. (merge-back, deleted — the merge is now the
  worker's or host's, but the invariant about the caller's tree stands)

## 05 / 07 The ledger and its reader

- Two rows for one dispatch (opened, then a terminal) correlate into one
  entry; an opened row with no terminal is marked open, never dropped.
  (dispatches-cli)
- The reader reads what the writer writes: one round-trip test through the
  real kernel, not a hand-built fixture. (dispatches-cli; dispatch-output)
- A malformed row is counted and skipped, never fatal; a row from a newer
  major format is counted apart from unreadable ones; an unknown minor
  within the known major is read best-effort; a missing or empty log is a
  friendly answer. (dispatches-cli)
- Every event kind Fadeno itself writes is known to the reader, so an intact
  log is never reported as damaged — AND a genuinely unknown row is still
  counted, so widening the known set never turns the counter off.
  (dispatches-withdraw; agent-stop)
- A row that lost its object field still renders as its kind, never as a
  clean tree or an empty trailing field. (agent-stop: malformed stop;
  steering-refusal, deleted)
- The log is append-only; the ledger is never rewritten by a reader.
  (dispatch-cli, deleted; workspace-overlap, deleted: append-only)
- Rows record the resolution path: which scope the dial came from.
  (dispatch-papercuts; session-dials)
- A dispatch nobody named is recorded without a name rather than with a
  null. (dispatch-tag)
- Verdicts come from the row's own facts: nonzero exit is FAILED, exit 0
  with no output is `empty`, and an open dispatch has no verdict — the
  facts are null until the terminal lands. (dispatches-cli; dispatch-output)
- `--output last` prefers the open dispatch over a newer completed one and
  refuses to guess between two open ones; two concurrent dispatches that
  both finished make `last` refuse. (dispatches-cli; dispatch-tag)
- Reading by name: a name still in flight refuses a second launch and says
  how to reach the first; an unknown name says which names the log holds;
  a malformed name is refused before anything is spawned; the spawn echo
  names the handle. (dispatch-tag — `tag` becomes `name`)
- An unreadable ledger never blocks a launch on bookkeeping. (dispatch-tag)
- Ledger rows and output snapshots are written to `.fadeno/`, which the repo
  ignores; a repo already ignoring `.fadeno/` entirely gets no extra entry.
  (dispatch-papercuts)
- Structured output (`--json`) is the same data the text view renders, so a
  script never parses the line. (dispatches-cli; steering-refusal, deleted)

**Terminal decisions**

- The terminal-receipt list is the single reading of "is it over?"; every
  surface asks it. (dispatches-withdraw)
- A repeated close with the same decision replays its receipt; a different
  decision is refused. (dispatch-adhoc; dispatches-withdraw)
- Close refuses a name it cannot resolve and says how to name one.
  (dispatch-adhoc)
- Closing a dispatch whose process is still live is refused. (dispatches-
  withdraw)

## Cancel (decision 34)

- The CLI cannot record the executor's pid: `spawnSync` yields it only after
  the child exits. The process that launches the executor must publish the
  process group while the executor is running, and that claim is what cancel
  signals. (supervisor, deleted: superviseArgv)
- Cancel signals the supervisor if alive, else the negative process group,
  else the executor pid; it refuses when no live claim exists and refuses to
  guess between several. (cancel, deleted; dispatch-cancel, deleted)
- A SIGKILLed supervisor cannot reap its detached executor, so the claim must
  outlive the supervisor and still name the live group. (crash-boundary,
  deleted)
- A cancelled dispatch leaves its recorded process group dead (ESRCH), and
  the next launch under the same name succeeds. (tool-repairs, deleted)
- Liveness is conservative: only a proven-missing pid counts as dead.
  (supervisor, deleted)
- The claim is removed only after the child closes; under load the claim may
  not be written yet, so a reader polls with a deadline rather than a fixed
  sleep. (supervisor, deleted)

## Stop hook (decision 32)

- When a host agent dies — a 429, credit exhaustion, a kill — it leaves a
  row saying so, with a path-by-path snapshot of what is uncommitted in the
  tree it worked in, and no verdict on the work. (agent-stop)
- A clean tree is a claim; an unanswerable one (`git` unavailable) is not
  collapsed as clean and never worded like it. (agent-stop)
- A stop identifies its dispatch from the worktree path it stopped in, and
  refuses to name a dispatch it cannot place. (agent-stop)
- A stop after the terminal does not reopen a settled dispatch; a terminal
  arriving after a stop retires the mark instead of contradicting it.
  (agent-stop)
- Stop rows are ranked by risk, not recency: an unsettled dispatch outranks
  a clean uncorrelated stop; in one dirty tree the agent that was cut off
  takes the slot over the one that signed off; ranking never takes a slot
  from a row that is not a stop. Rank decides what fits, chronology orders
  what fits. (agent-stop)
- Collapsed rows say what they counted and stay reachable; `--stops` on a
  log with none says so rather than saying nothing. (agent-stop)
- Five agents killed in-session survive a tail the work after them would
  fill. (agent-stop)

## 06 Context delivery

- Host mode is session-scoped: the hook enables it on the command and clears
  it at session end; it survives compaction on Codex; it ignores unrelated
  prompts and malformed input. (host-mode-hook)
- Every sentence of the hook's policy text survives in the host skill,
  compared as a session receives it (template evaluated), not as the source
  spells it. (host-mode-hook)
- Both halves carry the failure-reporting policy: a Fadeno failure stops the
  work and is reported, never answered with a generic subagent on a frontier
  model reported to nobody (the 2026-09-04 receipt). (host-mode-hook)
- Skill bodies are sigil-free; a harness's invocation sigil lives only in
  its own bootstrap. (init, deleted)

## 08 CLI surface

- A flag belonging to one command is rejected under another, not silently
  ignored; the option table is per command; an unknown command accepts
  everything rather than nothing; every command is in the registry so
  validation is never skipped; every flag a command actually reads is in the
  registry. (cli-flag-scope)
- A retired flag is tolerated on the commands that used to take it and
  advertised by none: agents cache skills at session start, and under host
  mode a failed CLI call stops the work. (cli-flag-scope)
- A retired flag or option names its replacement instead of "unknown".
  (dial-harness-column)
- Help and completion are derived from one registry of public paths; help
  routes on the longest public path and preserves aliases; global help
  stays under 40 lines and does not run command bodies; focused help is
  terminal-width friendly. (cli-help)
- Every bundled CLI knows the same commands as the source; the bundle bakes
  the version so a forgotten rebuild is caught by `--version`.
  (cli-help; plugin)
- Help short-circuits before any preflight or repository work. (cli-help)
- Completion offers only values that the command will accept: it does not
  suggest bare executor names where the parser wants `role=executor`.
  (completion)
- Column headings say what the flag that sets them says. (dial-harness-
  column)
- Table rows follow the canon archetype order, extras alphabetical after; a
  registry default never renders as a pin; the effort column shows the pin
  and `inherit` where there is none. (dial-cli)

## 10 Plugin

- Skills are generated from one shared body per skill; the generator asserts
  the frontmatter `name` matches the directory before renaming, because a
  `String.replace` on an absent needle is a silent no-op that once shipped
  the wrong name. (plugin)
- The committed plugin directories match a fresh generation file for file,
  in both directions, so an added or removed template is caught, not just
  an edited one. (plugin; plugin-codex; plugin-omp)
- The bundled binary is self-contained (CJS + templates) and runs with no
  `node_modules`; its `package.json` version matches without executing it.
  (plugin)
- The Codex plugin carries no subagents and no commands; its skill policies
  travel inside the plugin; the marketplace file points at the plugin.
  (plugin-codex)
- The omp plugin's agents satisfy omp's task-agent contract and its
  extension resolves the bundled CLI relative to itself. (plugin-omp)
- Surface descriptions carry the version stamp. (dispatch-agents)

## Test infrastructure

- The suite is hermetic against the developer's user scope: `HOME` and the
  `FADENO_*_HOME` variables are redirected per test, and a canary test fails
  if a temp-repo test ever resolves user dials under the real home.
  (helpers-isolation; helpers.ts)
- Harness identity is pinned explicitly in every resolving call; the one
  file that tests the bare-shell frame passes no harness at all.
  (harness-frame)
- Hook tests run the real script the way the harness runs it: stdin JSON
  in, exit code out, evidence on disk, with a fake `fadeno` on PATH that
  prints a canned resolve answer. (codex-spawn-guard; agent-stop)
- A process-reaping test with a 15s wait is load-sensitive; a failure under
  parallel agents that passes alone and on a clean rerun is load, not a
  regression. Always do a clean full rerun before calling anything a flake.
  (tool-repairs, deleted; session notes)
- Tests that spawn a background writer bound it in time, because a teardown
  cannot run when the runner itself is killed. (supervisor, deleted)
- A doc/source claims registry (one list, two consumers: tokens that must
  appear in both a doc and the source that implements them) catches the
  drift a prose review misses. Rebuild it for the new surface. (docs-
  claims, deleted)
- Literal counts in tests are change detectors, not properties; assert the
  set equality they were standing in for. (cli-help, this session)

## Deliberately NOT carried

Subjects the surviving tests still exercise that the spec removes. Listed
so the rebuild deletes them knowingly rather than porting them by habit.

- Tags as handles (→ UUID plus semantic name, decision 26).
- Relay attestation, prompt digests, `[attested]`/`[never attested]`/
  `[effort mismatch]` rendering, quarantine banners (decision 03).
- Shadow attachments, pair ids, `dial shadow`, `shadow.routable`, bakeoff
  rows (decision 02).
- Overlap windows, `concurrent_write` stamps, the window log and its
  compaction, the writer lease (decision 22).
- Declared carries, hardlink fingerprints, carry-mutation detection
  (decision 22).
- The `ignored_output` policy flag and its two-row echo (the worker reports
  untracked output in prose; the worktree is kept regardless).
- `workspace_changed` and `[no workspace change]` (the stop row's `dirty`
  and the worker's report replace it).
- `withdraw` as a distinct verb (→ `closed: discarded` or `failed`).
- The `restart_required` lane and session-effort matching (the hook applies
  effort at spawn; decision 18).
- The dirty-base advisory (→ refusal to cut from dirty state, decision 19).
- Materialization status rows for Codex, OpenCode and omp (decision 14).
- Persisted-state schema stamps, migrations and audits (decisions 05, 06).
- Managed runtime copies and version-skew handling (decision 07: one copy,
  a symlink).
