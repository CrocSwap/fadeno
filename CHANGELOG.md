# Changelog

All notable changes to Fadeno are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Removed — BREAKING

- **Executor deadlines, entirely.** `--timeout` is deleted from `fadeno
  dispatch`, `fadeno drive` and `fadeno tool-run` (passing it is an
  unknown-option error), no deadline is ever armed, and the supervisor no
  longer takes deadline argv slots or schedules a timer. rc.59 had already
  removed the DEFAULT deadline on the grounds that *a clock cannot tell slow
  from stuck*; the opt-in survived, and its existence was enough. On 2026-09-06
  a Codex director in basanos opted in and five dispatches were killed at their
  deadlines — `2c5828a2`, `2ec47db8`, `0ba58a70` at 2,400 s, `18ec1a9a` at
  1,800 s ("0 bytes of output were captured before the kill"), `0bbac080` at
  1,200 s — all exit 143, all with empty or zero-byte reports, and in every
  case the work itself survived in the diff. These are print-at-exit executors:
  the deadline destroyed only the report. Ending a long attempt is a decision
  for whoever can look at it — `fadeno show`, then `fadeno cancel` or `fadeno
  dispatches --cancel`. **Cancellation is untouched**, TERM→KILL grace
  included, because stopping something on purpose is a decision, not a guess.
  A `timeout_ms` declared in a catalog or a snapshot is accepted, parsed, and
  never armed: catalogs written before this release declare it, so refusing
  would break them over an inert key. The loader records a note and `fadeno
  doctor` raises it as an `ignored-deadline-key` warning. Ledgers written
  earlier still read: `dispatch_completed.outcome = "timeout"` and
  `actor_failed.reason = "executor_timeout"` render exactly as before.

- **The repo-wide writer lease.** `acquireWorkspaceLease`,
  `releaseWorkspaceLease`, `heartbeatWorkspaceLease`, `isWorkspaceLeaseAlive`,
  window leases and their wait loop, every pid and process-group probe behind
  them, and the `workspace_lease_recovered` / `workspace_lease_reclaim_denied`
  audit rows are gone. It is the same defect as the deadline, one layer down:
  the lease had to answer *"is this holder still alive?"*, and Fadeno cannot.
  `isWorkspaceLeaseAlive` returned **true** for a record with no
  `supervisor_pid` — nothing could prove it dead, so nothing ever reclaimed it
  — and a host dispatch never has a pid, because it runs inside another agent's
  session. Every shared host delivery therefore took a lock that was immortal
  by construction: a 429-killed agent wedged the repo permanently, refusing
  every later writer including the recovery of the very run that took it.
  `.fadeno/local/workspace-lease.json` is now vestigial — read only so `doctor`
  can report a leftover one and say, without hedging, that deleting it is safe.

### Added

- **Overlap detection (`concurrent_write`), which is what replaced the lock.**
  Deleting the lease without this would trade a loud wedge for silent lost
  writes, which is worse, so it is not optional. Contention is INVERTED: a
  delivery that is not the sole writer is isolated automatically and the
  receipt says so — "you must wait" became "you get your own tree", which turns
  overlap into two diffs against a common base. Every delivery records a window
  in `.fadeno/local/dispatch-windows.jsonl` (append-only, machine-local, never
  ledger, never gating) and at its terminal receipt intersects its changed
  paths with every window that overlapped it in time. A non-empty intersection
  lands as `concurrent_write` on the receipt, naming the other dispatch and the
  paths, with `attribution: delivery` (an isolated arm's own diff, so
  attributable) or `workspace` (a shared tree's delta, an attestation only). An
  overlapping window that has not closed yet is `pending`; the later-closing
  side carries the concrete intersection, so each of the pair names the other.
  Conflicts route to an integrator through the existing merge-back rebase.

- **`fadeno dispatch-open` / `fadeno dispatch-close` — the host dispatch
  protocol without a playbook run.** Fadeno is supposed to PREFER the host lane,
  and the preference was advisory while the capability was one-sided. `fadeno
  dispatch` isolates by default and merges the primary diff back, and it needs
  no run: a worktree, a dispatch id and a terminal receipt from one invocation.
  The host lane's equivalent was run-scoped all the way down —
  `hostWorktreePath(runId, dispatchId)` takes a run id, `dispatch-prepare`
  requires one, and `requestHostDispatch` is only ever called by the engine — so
  a director doing ad-hoc parallel work had exactly ONE way to get isolation
  plus receipts, and it was the lossy lane. That is not a wording problem, and
  it is what a real Codex-director session did on 2026-09-05: a five-lane
  campaign onto the command lane, five reports lost.

  `dispatch-open` cuts the worktree, mints the id, opens the overlap window and
  records the request; the host spawns its in-session agent against the printed
  workspace (Fadeno cannot spawn into its own parent session, and does not
  pretend to); `dispatch-close` collects the diff, merges it back, stamps
  `concurrent_write`, closes the window and writes the terminal receipt.
  `--reason <text>` records a FAILED outcome and merges nothing; `--no-merge`
  records success and keeps the diff. The worktree is torn down on exactly one
  condition — the work landed in the caller's tree — so no ending can destroy
  work that has nowhere else to be.

  The worktree comes from the SAME `prepareHostWorkspace` the engine's host lane
  uses, with `adhoc` filling the run path segment: that argument is validated as
  a path segment, not resolved as a run, and no `YYYY-MM-DD-HHMM-slug` run id
  can collide with it. There is no `dispatch-start` on this lane, because the
  host spawns out of band and Fadeno never sees the process — so there is ONE
  terminal receipt rather than a `complete`/`fail` pair, and its `outcome` is
  STATED by the host, never derived from an exit code that does not exist.

  **Where the record lives.** `.fadeno/dispatches.jsonl`, beside the command
  lane, not a synthesized ledger under `.fadeno/runs/adhoc-*`. A run-shaped
  record would have made every existing verb work unchanged, and it loses on the
  reader count: that log has one entry reader (`foldEvidenceRow`), where
  `.fadeno/runs/` has `listRuns`, `resolveRun`, `verify`, `show`, `runs`,
  `status`, `clean`, `doctor` and the persisted-state audit — and a
  `run.schema.json` that REQUIRES a `playbook`, so a runless run is either a
  schema violation or a fiction with a made-up playbook name in it. Teaching all
  of those that some runs are not runs is the one-list-many-consumers failure
  this repo keeps re-committing. The two new event names ship with their
  `foldEvidenceRow` cases in the same change, because a row kind that reader
  does not handle is counted as unreadable DAMAGE — the exact regression a838a0a
  fixed for the rows that already existed.

  **`fadeno verify` is not this lane's auditor, and now says so.** It audits run
  ledgers: attempt contiguity, the playbook snapshot's digest, gate coherence,
  the host-dispatch lifecycle. An ad-hoc host dispatch has none of those by
  construction, so `verify` never sees one and can never falsely fail it — but
  handed an ad-hoc dispatch id it used to answer "No run matching `<id>`", which
  reads as *your evidence is gone* rather than *you are asking the wrong
  command*. It now names what the id is, whether it is open or closed, why there
  is nothing here to verify, and where the receipt actually is.

  **`dispatch-prepare --isolate` stays required.** Confirmed, not assumed:
  `HostWorkspaceState.workspace_mode` is the literal `'isolated'` and
  `readHostWorkspaceState` refuses a state file that says anything else, so a
  `--shared` prepare could not record what it had done; and a shared host
  delivery needs no preparation at all, because `startHostDispatch` derives
  `isIsolated` purely from whether that state file exists. The flag is not a
  mode selector with one value filled in — there is no second mode.
- **Readers for `concurrent_write` and `ignored_output_discarded`, because
  neither had one.** Both fields are written by the kernel at a terminal
  receipt and, until now, `grep -c` across `verify.ts` and `show.ts` returned
  `0` for each. That makes the detection above worth what the relay-fidelity
  warning was worth before `7c7a0f6`: `concurrent_write` reached one echo on
  `fadeno dispatch`'s stdout, which is exactly what the recover-by-tag path
  discards, and `ignored_output_discarded` reached only the `fadeno dispatches`
  listing — which is not where anyone noticed a `data/research/` directory
  disappear, twice, from a repo whose `.gitignore` carried a broad `data`
  wildcard. The safety story of deleting the writer lock was "detect and
  report"; nothing reported.

  `fadeno verify` grows two findings, `concurrent-writes` and
  `discarded-output`, and a fourth `FindingStatus`: **`warn`**. The existing
  three share one axis — recomputed and holds, recomputed and does not, could
  not recompute — and on that axis both attestations are `skip`, which is how
  they stayed invisible: a skip reads as "nothing here". `warn` says the
  opposite, and never fails the run. That restraint is the point rather than
  timidity: a failing `verify` exits non-zero and makes `fadeno evidence`
  refuse to promote the run, with `--allow-failed` ("accept an honest failed
  terminal") as the only escape. An overlap is not proof of damage — path
  granularity means two agents editing different functions in one file land
  here — and discarding gitignored output is the DECLARED behaviour of the
  `ignored_output: discardable` default, which `verify` cannot tell apart from
  a lost deliverable. Gating on either would make ordinary runs unpromotable
  and teach readers to reach for `--allow-failed`, which is the same outcome as
  rendering nothing. `doctor` draws this line already with `ok | warning |
  error`.

  `fadeno show` renders a `DISCARDED OUTPUT` section and a `concurrent writes`
  section directly under the workflow — **above** `active artifacts`, not down
  with `failures`, because a reader who meets the artifact list first concludes
  it is the whole product, which is precisely how the loss went unnoticed.
  `fadeno dispatches` renders overlaps inline; that log is the only home of an
  ad-hoc dispatch's stamp, so without it half the detection had no reader
  anywhere.

  On `fadeno dispatches --output` the two findings deliberately travel on
  different channels. A discard is prefixed onto the returned **bytes**, beside
  the relay banner, because it changes what the report means: a report that
  says "wrote the analysis to `data/research/`" is describing files that are
  not in your tree. An overlap is stated on stderr only — it does not make the
  report false, and an in-band banner readers learn to scroll past protects
  nothing. The banner is not hashed into `attested`: the digest on the
  completion row is the executor's output.

  One parser (`src/lib/receipt-attestations.ts`) backs all four surfaces.
  Rendering stays local — a bracketed fragment on a one-line listing is not a
  section heading in a run projection — but *whether there is a finding* is
  decided once. Two readers wording a discard differently costs a re-read; two
  readers disagreeing about whether there was one costs the output.

### Fixed

- **The engine recorded "I could not tell what was destroyed" as `[]`.**
  `drive.ts` wrote `ignored_output_discarded` as a bare `string[]` while
  `dispatch.ts` wrote the object with `truncated` and `note`. The scan is
  capped (`IGNORED_OUTPUT_MAX_ENTRIES`) and a git failure returns a partial
  listing, so on the engine path a floor was indistinguishable from a complete
  set — and the worst case, a truncated scan that enumerated nothing, was
  written as an empty array, byte-identical on the wire to a listing that found
  nothing. It now writes the same object the ad-hoc path does. Rows already on
  disk still read: an array is parsed as `truncated`, with a note saying it
  carried no completeness flag, because a row that cannot state its own
  completeness does not get assumed complete.

### Changed

- **`src/lib/workspace-lease.ts` split.** Its own header always said it was two
  modules — "Repo-wide writer leasing **and** isolated worktree delivery" — and
  only one of them was a lock. Isolated worktree delivery, declared
  `worktree_carry`, carry-mutation fingerprinting and the gitignored-output
  scan moved to `src/lib/workspace-isolation.ts` unchanged (`WorkspaceLeaseError`
  → `WorkspaceIsolationError`); the new `src/lib/workspace-overlap.ts` holds the
  window log and detection; `workspace-lease.ts` keeps only the vestigial-file
  reader.

- **The host-lane note on `fadeno dispatch`.** It advertised `--timeout`, which
  no longer exists, and sold the command lane on an isolated worktree, a
  dispatch id and a terminal receipt — all three of which the host lane gives
  inside an engine run (`dispatch-prepare --isolate`, the request's dispatch id,
  `dispatch-complete`/`dispatch-fail`). It now names the host dispatch protocol
  as the third option and keeps only what is genuinely command-lane-only:
  `--diagnostics`, and a shadow pair, which forces both arms onto the command
  lane by design. With `dispatch-open` it names the RUNLESS pair first: the
  caller reading that note is doing ad-hoc work, and "the host lane gives all
  three inside an engine run" was an answer that required a playbook they did
  not have — whose honest reading was *so use the command lane*.

### Changed — BREAKING

- **A failed relay-fidelity check now REFUSES the dispatch.** `relay_attested:
  false` — a dispatch proxy marked itself for these exact bytes and the
  spawn-side record disagrees — is a boundary refusal with predicate
  `relay_fidelity`: a `dispatch_refused` row, a non-zero exit, and no executor
  spawned. It was warn-only, on stderr, and the E25 dispatch of 2026-09-06
  showed what that is worth: Fadeno detected that the bytes reaching the
  executor were not the bytes the caller wrote, said so on a stream the relay
  contract discards, and returned a **success verdict** for work on the wrong
  prompt — correct only because the director happened to read the whole diff by
  hand.

  `--allow-relay-mismatch` (on `fadeno dispatch`) proceeds anyway and records
  `relay_mismatch_allowed: true` beside `relay_attested: false`, so the ledger
  shows a person chose it rather than the kernel forgiving it. The Claude proxy
  guard's relay grammar does not admit the flag: the party whose fidelity is in
  question cannot wave away its own finding. A dispatch that proceeds is
  quarantined, not forgiven — `fadeno dispatches --output` prefixes the returned
  **bytes** with the failure (stderr does not survive the recover-by-tag path,
  which is precisely where the warning was lost), the listing renders it as
  `[RELAY FIDELITY FAILED — relay_attested: false]`, and `fadeno dispatches
  --merge` refuses without its own `--allow-relay-mismatch`.

  An **absent** `relay_attested` is unchanged and must stay so: it is the
  absence of a claim, not a finding. Failing closed is licensed only because
  `false` requires a proxy marker to match first, which makes it positive
  evidence of defection.

- **Catalog v4: harness-neutral dials and one `harnesses:` table.** A dial names
  WHO runs an archetype and, optionally, WHICH HARNESS runs it — never a lane, a
  driver, or an argv. The HOST harness is discovered at dispatch time from
  ambient signals and never from stored state; the pair *(dial harness, host)*
  plus policy decides the lane. The six `routes.<host>` tables were
  near-identical copies whose only real difference was which entry carried
  `host: true`, and that bit is a property of the call. Migration table, the
  resolution algorithm and the known gap:
  `docs/experimental/harness-neutral-dials.md`.

  Removed and **refused rather than ignored**, each with a migration note
  naming its v4 spelling: `routes:`, `driver:`, `host: true`, top-level
  `relay:`, `unregistered_model_driver:`, `models.<m>.delivery:`. A
  `schema_version: 3` layer still loads when it declares none of them — a
  personal `models:`-only catalog is not made wrong by the bump — and `doctor`
  reports it as a `catalog-version` warning. `spellings:` is keyed by harness
  id. Exactly one harness may claim a `provider:` as home.
- **`--via` is removed; use `--harness <id>`** — in `dial`, `dial shadow`,
  `dispatch`, `bakeoff`, `--help` and completion. A stale `--via` errors naming
  its replacement rather than answering "unknown option". `fadeno models
  --driver <alias>` is likewise `--harness <id>`, and the `fadeno dial` table's
  fourth column is `harness` again (it was `via`), marked `(home)` whenever the
  dial did not name one.
- **Dial-ref grammar: `model[@effort][ on <harness>]`.** `parseDialRef` accepts
  the legacy ` via <driver>` **on read only**, mapping
  `claude-exec`/`claude-cli` → `claude`, `opencode-direct` → `opencode`,
  `muse-code` → `muse`, anything else to itself; nothing emits `via` again.
  Persisted state that still spells a delivery that way is translated on read
  and reported once, never silently rewritten. **A shadow attachment that
  carried `via` re-rolls**: `shadowSampleRoll` is byte-identical and hashes the
  challenger's formatted ref, so a ref string that changes samples a different
  sequence. Preserving the old string would mean keeping the driver vocabulary
  alive inside the hash.
- **`fadeno dial` set-time validation is registry-only**: the model is known (or
  falls through with the existing verification note), the effort is legal, and
  `--harness` names a declared harness. The eligibility refusal and the
  host-lane/effort notes are gone from set time — both are questions about a
  CALL, and a dial is stored host-neutrally and re-resolved at every dispatch.
  `fadeno dial resolve` reports both, with the remedy.
- **JSON outputs: `driver` → `harness`, and `harness` → `host`**, moved together
  so no reader can be right about one and wrong about the other. `dial resolve
  --json`, `steering resolve --json`, `fadeno models` (`host`, `host_source`,
  `home_harness`, `deliveries`, `unregistered_model_harness`,
  `listable_harnesses`) and the constraint context (`harness`, `variant`,
  `host`) all move; a nullable `variant` names the command lane when policy
  chose a named one. `harness` is `null` for `current-host` in a bare shell —
  `standalone` is the no-host value, not a harness to look up.
- **Ledger format 1.1** (`.fadeno/dispatches.jsonl`). New rows write `host`,
  `harness`, `variant` and `dial: {model, effort?, harness?}`. Format 1.0 rows —
  where `harness` meant the host and `driver` the executor — are translated on
  read in one place and never rewritten. The Claude hook, the Codex spawn guard
  and the OpenCode/omp adapters stamp 1.1 too.
- **From a bare shell `current-host` is `restart_required`, not `host`.** The
  base dial names whatever session is running, and a bare shell has none, so an
  in-session answer there was a claim nothing could honour. `fadeno dial`'s lane
  echo and `fadeno new-run`'s resolution echo now annotate it.
- **The Claude command lane opens its shell: `--allowedTools Bash`.** v4's
  `harnesses.claude.command` was the plain `claude -p --permission-mode
  acceptEdits`, which auto-approves file edits and then leaves every other shell
  command needing an `--allowedTools` entry — and an unresolved permission
  request is denied by a headless `-p` run. So a non-director anthropic dial
  ejected to the command lane (`worker opus@high` under a Claude host) spawned a
  `claude` that could edit but not run the tests, git, or `fadeno attest`, and
  its receipts went away. It now carries the same headless trust every other
  vendor's command lane already carried — codex `--sandbox workspace-write`,
  grok `--always-approve`, agy `--dangerously-skip-permissions`, opencode
  `--auto`, muse `--trust-workspace --disable-approval
  --user-input-auto-resolve`. A **bare** `Bash` is the documented match-all rule
  ("Match all uses of a tool": `Bash` — "Matches all Bash commands"); the same
  page documents `Bash(*)` as equivalent to it, and the bare form is the one the
  permission table and the headless docs lead with, which is why the argv uses
  it. No OS sandbox is implied and none was added: containment is the
  isolated worktree, which contains file writes and nothing else — network,
  registries and ambient credentials stay reachable, as on the other five lanes.
- **The `claude` `exec` variant is now the same argv as the base lane**, and
  stays only as the `director` eligibility carrier. It no longer grants
  anything the base lane lacks (it dropped `--allowedTools "Bash(fadeno:*)"`
  for the wider bare rule): the base lane still declares
  `eligibility: { director: forbidden }` so policy falls through and the ledger
  row and run snapshot record `variant: exec`, which is what distinguishes a
  director dispatch from a worker dispatch that ran the identical command.
  `fadeno models --json`'s `fadeno_capable` reads both spellings — the bare
  `Bash` rule and a scoped `Bash(fadeno:*)` a user catalog may still pin — via
  one `argvGrantsFadenoShell` predicate, so the column did not silently flip to
  `false` for every anthropic delivery.

### Added

- **`fadeno dispatches --withdraw <id|tag:<tag>> --reason <text>` — the second
  move for a dead COMMAND dispatch.** `--cancel` refuses when there is no
  in-flight claim to signal — correctly; it will not claim to have cancelled
  work it never touched — and that refusal is unchanged. What was missing was
  anything else: two dispatches reported 2026-09-05 had absent executor pids
  and no completion row, so they read as open forever and "missing terminal
  receipts made dead workers look potentially live." A `dispatch_withdrawn`
  row is now the command lane's second terminal receipt. It signals nothing,
  is refused while any process behind the claim is still alive (cancel first),
  refused after a completion row, and idempotent for the same `--reason`.

  Unlike the host lane's `dispatch-withdraw` it removes **no workspace**: a
  host request is withdrawn before it starts, so its prepared worktree is
  empty, while a command dispatch is withdrawn after it died and a killed
  executor's uncommitted edits are the thing worth keeping. `--work-left
  <path>` records where they are, so `fadeno dispatches` shows an owner for a
  dirty tree without anyone reading a transcript.

  `commandDispatchTerminalState` (`commands/dispatch.ts`) is the ONE list of
  terminal receipts, read by the tag allocator, the output-record loader,
  `last` resolution, `--cancel`, `--merge` and the listing — so a withdrawn
  dispatch stops looking live everywhere at once instead of in whichever
  reader remembered. `foldEvidenceRow` collapses the tail-view and whole-log
  readers of `.fadeno/dispatches.jsonl`, which were byte-identical copies, into
  one: the receipt could otherwise have rendered in `fadeno dispatches` while
  staying invisible to `fadeno clean` and shadow-pair resolution.

- **Role agents are refused the git subcommands that destroy a shared tree.**
  A worker ran `git checkout -- <file>` in a shared tree on 2026-09-05 against
  its dispatch's explicit instruction; it lost and redid its own edits, and a
  shared file would have destroyed another agent's work. The Bash `PreToolUse`
  hook (`dispatch-proxy-guard.mjs`) now denies `checkout`, `switch`, `restore`,
  `reset`, `stash` and `clean` when `agent_type` names a managed `worker`,
  `reviewer` or `judge`, naming the harm and what to do instead; `git stash
  list|show` and `git clean -n` pass, and the main session is never guarded.
  The worker briefs carry the same rule at tier 1.

  The coverage is **partial and is documented as partial**: role agents are
  identified by `agent_type`, so a role brief handed to a plain `claude`-type
  subagent is invisible to it; Codex-hosted role agents were not covered (closed
  separately below — the gap was our wiring, not a Codex limit); and the
  statement splitter reads shell text without being a shell. Isolation
  (`--isolate`) remains the protection for two concurrent implementers — the
  hook only catches the reflex.

- **The host skill documents resume-by-id as the standard recovery** after a
  session limit or harness kill: resume each stopped agent by its id rather
  than re-dispatching (a resumed agent returns to its own transcript; a fresh
  dispatch puts a second implementer on the same tree), and report which files
  are dirty and which agent owns them before doing so.
- **Relay fidelity now works on a Codex host, and Codex role agents are guarded
  against destructive git.** Both sides of `relay_attested` were written by
  Claude-only hooks, so on a Codex host the verdict was permanently *absent* —
  "cannot say" — and the new `relay_fidelity` refusal could never fire there. A
  live Codex-director session had no protection at all against the exact
  substitution class the refusal was built for. That was never a Codex
  limitation, only the shape of our wiring: Codex fires `PreToolUse` for every
  tool, and a shell call arrives as `tool_name: "Bash"` with the command bytes
  in `tool_input.command` (measured against the shipped 0.153.4 binary, not read
  out of documentation).

  The new `templates/codex/hooks/dispatch-proxy-guard.mjs` writes the
  dispatch-side marker, and `spawn-guard.mjs` now writes the spawn-side stash.
  The two ship together on purpose: a proxy marker with no spawn-side stash lets
  an unrelated session's fresh rows turn an honest dispatch into a
  `relay_attested: false`, and *manufacturing* that finding is worse than not
  having it. The kernel needed no changes — it already reads both files without
  knowing which harness wrote them.

  The Codex relay is not shaped like the Claude one, and the implementation
  follows that rather than the other way round. Codex has no dispatch-proxy
  agent type: the managed role agent brokers its own dispatch, writing the
  prompt it received to a file under `.fadeno/local/prompts/` and running
  `fadeno dispatch --archetype <role> --prompt-file <path>`. So the bytes are
  not in the command — the path to them is, and the hook reads that file (only
  under the prompts dir; anything else is left unattested rather than read, so a
  guard cannot be turned into a file oracle with a hash for an output). The
  spawn side stashes **every** delivered managed role spawn, host lane included,
  because a host-adapter role agent resolves per task and dispatches on
  `mode=command` — stashing only the command lane would leave those dispatches
  carrying a marker with no row of their own, which the kernel reads as
  defection. Refusals stash nothing: nothing was handed over.

  Deliberately absent is the Claude proxy guard's relay grammar, which allows a
  dispatch proxy exactly one shape of Bash. That contract is safe on Claude
  because `dispatch-worker` exists only to relay; on Codex the same `worker` is
  also the host-lane implementer, so an allowlist would refuse it every
  legitimate command it runs. The **destructive-git** refusal does carry over
  byte for byte (`checkout`, `switch`, `restore`, `reset`, `stash`, `clean`;
  `git stash list|show` and `git clean -n` pass), with the same stated limits:
  identification is by `agent_type`, so a role brief handed to a generic Codex
  subagent is not covered, and the splitter reads shell text without being a
  shell. Heredoc bodies are stripped before that scan — they are the user's task
  prompt, and a prompt that mentions `git checkout` must not read as running
  one. A refused command writes no marker, because it never ran and therefore
  sent no bytes.

  The manifest entry is appended **after** the `Agent` group in
  `hooks/hooks.json`: Codex keys hook trust per matcher group by index, so the
  spawn guard's existing trusted hash stays valid and only the new group goes
  through review at the next session start. Until it is trusted, Codex role
  dispatches stay unattested and role agents stay unguarded — `fadeno setup
  --codex` now says so.

- **`fadeno dispatch-withdraw <run> <dispatch-id> --reason <text>` — retire a
  host request that was never started.** A minted request had exactly two exits,
  both of which claim work happened: `dispatch-complete` and `dispatch-fail`. A
  director who minted a request under the wrong executor, or simply changed
  their mind before starting it, had no honest way to retire it — the run stayed
  `awaiting_host_dispatch` forever, or the ledger got a failure receipt for work
  nobody did. `host_dispatch_withdrawn` is the third terminal receipt and the
  only one for work that never began: it carries the reason and
  `withdrawn_by`, removes a prepared isolated workspace if one exists (recording
  `workspace_removed`, and naming the leftover path rather than losing the
  receipt if removal fails), is refused once an `actor_dispatched` start exists,
  and is idempotent for the same reason. The request stops being pending, so the
  next `fadeno drive` mints attempt *n+1* for the same actor call under the
  current cascade or binding with `attempt_reason: withdrawn` (an executor that
  also changed still reads `executor_override`, which outranks it); the
  withdrawn attempt keeps its ordinal. That precedence is one ladder,
  `hostAttemptReason`, read by the serial member loop, the parallel wave and the
  compositional re-mint alike — the compositional path had its own copy with the
  `executor_override` arm missing, so the same fact recorded a different reason
  depending on which engine path ran. `verify` audits the new shape — a start after a withdraw is a
  finding, and a withdrawn request no longer trips "completed run has no
  `actor_dispatched` start". `show` renders the request as `withdrawn` with its
  reason and the actor call as pending again, through
  `hostRequestTerminalState`, now the one reading of the lifecycle that
  `verify`, `drive`, `show`, `dispatch-prepare` and completion all share — so
  `dispatch-prepare` refuses a withdrawn id instead of cutting an isolated
  worktree nothing could ever start, seconds after the withdraw removed the
  previous one. Its refusal says the request was *withdrawn* and that
  `fadeno drive` mints a fresh one, because a withdraw is retryable where a
  completion is not, and the message is the only place that difference reaches
  the operator.
- **`fadeno drive --unbind <role>`, and a loud refusal when a `--bind` is
  silently dropped.** `--bind role=executor` binds a role for the invocation
  that passes it. Any later `drive` of the same run that forgot the flag
  quietly resolved the role through the cascade instead and started new work on
  a different executor — a whole attempt delivered by the wrong model, visible
  only afterwards in the ledger. Before minting a host request or starting a
  command attempt for a role bound earlier in the run, the engine now refuses:
  `role "R" was bound to "X" earlier in this run; this invocation would start
  new work for it on "Y". Pass --bind R=X to keep the binding or --unbind R to
  release it.` A run that stops there is indistinguishable from one that was
  never driven: `events.jsonl` is byte-identical across the refusing invocation.
  That required moving the `resolution_snapshot` — derived bookkeeping that used
  to be appended at the top of every drive, which meant a refusing drive first
  recorded that the role resolves to the very executor it was about to reject.
  The row is now the invocation's prelude, written by the first thing the
  invocation actually records, and not at all when it records nothing.
  `--unbind <role>`
  (repeatable) releases the binding for good, recorded as a cleared
  `executor_override` that `warnDroppedBindings`, `verify` and `show` all read
  as "no binding". Continuing an already-minted request is unaffected.
- **`fadeno status` and `fadeno dial` tell the truth about Codex managed-agent
  identity.** File EXISTENCE was the whole test, so `status` reported the
  managed agents `current` at the exact moment it mattered least: a Codex
  director whose `reviewer` dial had moved to another model kept spawning the
  old identity, because the agent file is a frozen identity that no spawn value
  corrects. `status` now compares each file's `model`/`model_reasoning_effort`
  against what `steering resolve` reports for that archetype — the same resolver
  `steering apply` and the spawn guard ask, never a second cascade — and reports
  `current` | `stale` | `missing` | `not_applicable` per slot (the last for a
  slot the dial resolves onto another provider's command lane, whose identity is
  reported but not judged). A stale line names the drift and the fix:
  `Codex managed agents: stale — reviewer file gpt-5.6-luna/high vs dial
  gpt-5.6-terra/xhigh; run \`fadeno steering apply --codex --scope user\`, then
  start a fresh Codex session`. `fadeno dial` returns and prints the same fact
  as `codex_materialization` when the archetype it just set has drifted; it
  still never writes `~/.codex/agents/*`. One remediation string
  (`CODEX_IDENTITY_REMEDIATION`) and one formatter feed both surfaces, so they
  cannot drift apart. **Scope, stated because the review caught it:** both
  surfaces judge the USER-scope `fadeno-<archetype>.toml`. A project-scope
  `.codex/agents/<archetype>.toml` shadows that file for Codex entirely, and an
  unmarked (non-`managed`) file that happens to match is still reported
  `current` even though `findSpawnableCodexAgent` would refuse it. Judging the
  effective candidate is not done here.
- **A live command attempt can say what it is doing** — an ENGINE actor call;
  ad-hoc `fadeno dispatch` still passes no progress path and remains as opaque
  as before. Every engine actor prompt
  asks its agent to keep a cooperative progress sidecar, and nothing on the
  reading side had ever opened one for a *command* attempt: the file was written
  into the attempt's workspace — an isolated worktree, usually — and left there,
  so `show` could describe six minutes of work only as byte counters. The
  supervisor now mirrors that sidecar onto its in-flight claim on each heartbeat
  (plus at startup and at `close`, where the agent's last write usually lands).
  A sidecar that is absent, unreadable, unparsable or missing its `updated_at`
  clears all five fields, so the claim carries no progress at all rather than a
  self-report that stopped arriving still reading as current.
  `show` prints it as the agent's SELF-REPORT — `agent: "<phase>" (<state>) —
  <current>, <age> ago (agent self-report, non-gating)` — never as a
  measurement, and it never gates. The idle warning is honest about which of
  three things it knows (`describeIdleOutput`): the streams are quiet but the
  agent's own report moved during the silence; or there is no report and this
  executor (`claude -p`, `codex exec`) prints only at exit, so silence is its
  normal shape and not a stall signal; or neither, which keeps today's sentence
  byte-for-byte. New `src/lib/attempt-progress.ts` holds the pure readers, and
  `attemptProgressRelPath` delegates to the prompt's own spelling so the path
  the agent was told and the path the supervisor watches cannot diverge.
- **A human gate says what it is gating.** `fadeno drive` now prints the gated
  artifact's path, byte size and markdown headings under the decision line, so
  an approver can see what they are being asked to approve without going to find
  the file. Display only: derived at print time, recorded nowhere, and unable to
  affect the decision.
- **Four catalog-rot checks in `fadeno doctor`.** All four answer the same
  question — what in a setup that still *works* has quietly stopped being
  true?
  - `user-catalog-repairs`: one warning per note the layered loader produced
    for the USER catalog. `config-layers.ts` reads that one layer tolerantly
    (`repairUserLayer` translates what it can, `dropUndeliverableUserModels`
    discards what it must) so a single stale entry cannot brick every
    unrelated command — right, and until now silent: a dropped alias simply
    vanished and the first symptom was a dial failing on a model the user was
    sure they had added. The remediation names `fadeno models add` and
    `fadeno models remove`.
  - `model-verification-stale`: one warning per dialed `(harness, model_id)`
    whose verification row is missing or older than `VERIFICATION_MAX_AGE_DAYS`
    (30). Dial-time verification is existence-only, so a row written once
    vouches forever; `fadeno models verify` is the remediation, because it
    ignores the cache. It audits **every resolved dial** — including archetypes
    the catalog's own `dials:` mapping names and no stored layer does, and
    harnesses that declare no `models_command`. Nothing can re-probe an
    unlistable harness, so that finding's *remediation* says so (delete the row
    or re-dial) instead of naming a command that would report the pair
    `skipped`; dropping the finding would have been the doctor silently
    declining to run a check it reports on. `current-host` is skipped by both
    checks: it names the session, not a model.
  - `model-listing-missing` / `model-listing-unavailable`, behind
    **`fadeno doctor --probe-models`**: spawns each dialed *listable* harness's
    `models_command` and reports a dialed model the backend no longer names. It
    is the only part of doctor that spawns anything, so it is opt-in; without
    the flag doctor reports `model-listing-skipped` as `ok` and **always names
    the flag** — including when no dial resolves onto a listable harness, where
    the detail still says plainly that there is nothing to probe. The finding is
    the only place the check announces itself, so a skip that hid the flag hid
    the check.
    An unreadable listing is one `warning` per harness, never an error — a
    vendor CLI that is absent or slow says nothing about the dial. Membership is
    decided by `listingContains` in `src/lib/model-listing.ts`, which
    `src/commands/models.ts` now calls too: the dialed id is qualified with
    `models_prefix` and compared against the raw listing (`qualifyListedModelId`,
    the same call `fadeno dial`'s probe and `fadeno models verify` make). One
    rule, so the doctor cannot call a dial healthy that `fadeno dial` would
    refuse.
  - `persisted-state:<surface-id>`: one finding per surface in the new
    inventory (below). `fadeno doctor --json` now emits the findings as JSON,
    and the text renderer collapses a fully-`ok` inventory into one counted
    line — eighteen identical rows is how a diagnostic teaches people to stop
    reading it.
- **A persisted-state inventory, `schema_version` stamps, and a `fadeno setup`
  migration.** `src/lib/persisted-state.ts` declares `PERSISTED_SURFACES`: every
  file Fadeno writes, with its scope, format, version field, current version,
  and the reader and writer that own it. Three surfaces that were unstamped are
  now v1 — `dials.json` (`{schema_version, dials}`), `model-verifications.json`
  (`{schema_version, verifications}`) and `.fadeno/local/dials` (the stamp
  beside today's keys). **An unstamped document is version 0 and stays readable
  forever**; a stamp from the FUTURE is refused rather than half-read, because
  these files decide which model runs. `fadeno setup` migrates the three
  in-place, **backing each up first** — `<stateDir>/backups/<timestamp>/` for
  user files, `.fadeno/local/backups/<timestamp>/` for repo-local ones — and a
  migration that cannot back up does not rewrite. `fadeno doctor` reports and
  never migrates. **A stamp is not a schema:** the audit validates every stamped
  document through its own reader's rules (`validateUserDialsDocument`,
  `validateVerificationDocument`, `validateLocalDialDocument`,
  `validateInstallationManifestDocument` — each exported from the module that
  owns the reader, so the two cannot drift) before it says `ok`.
  `{"schema_version": 1, "dials": []}` carries the current version and yields
  no dials, and it is reported as an `error` naming the file and its backup
  directory; a document the reader gets *most* of is a `warning`. **Every**
  `error` names that backup directory, unreadable bytes and unknown versions
  included, so the advice to keep a copy points at the same place a migration
  would have written. `run-ledger` is one surface with **two** files: the
  `events.jsonl` beside `run.yaml` is audited row by row through `readEvents`
  itself, so a truncated append is an `error` naming the run and the line while
  a row in an older shape stays `ok` — events carry no stamp and history keeps
  the format it was written in.
  **The audit runs on every `fadeno doctor` invocation, including the one where
  `runStatus` throws** — which is very often a persisted surface refusing a
  future `schema_version`, so reporting only `configuration: error` withheld the
  `persisted-state:<id>` finding that names the file and its backup directory;
  both now appear together. **And being unstamped is not a reason to skip the
  read:** every unversioned surface goes through its real reader
  (`readWorkspaceLease`, `readInflightClaim`/`readSupervisorStatus`,
  `spawnMarkerRow`, `parseBakeoffFile` — moved to `src/lib/bakeoff.ts` so the
  audit shares it rather than copying it), and `host-workspace-state` is read
  member by member through `readHostWorkspaceState` instead of being reported
  from its directory name. A document any of those readers refuses is an `error`
  naming that file and the backup directory; `UNVERSIONED_READERS` is exhaustive
  with an explicit `null` for the three surfaces nothing reads, and
  `unversionedReaderFor` throws for an unlisted one just as `shapeValidatorFor`
  does. Directory scans are bounded by `MEMBER_AUDIT_SCAN_LIMIT` and say so when
  the bound is hit.
  `test/persisted-state-inventory.test.ts` is the drift tripwire: every path
  constant in `user-paths.ts` and every repo-local state path must appear in the
  inventory, and each declared `currentVersion` must equal what its writer
  actually stamps; `test/fixtures/persisted-state/` keeps a v0 sample captured
  from the pre-change writer so tolerance is asserted against the real legacy
  bytes rather than a remembered shape, plus a `malformed-v<current>` sample for
  every surface with a shape validator — a second tripwire requires one.
  Recorded and not fixed: `.fadeno/executors.yaml` shadows the user catalog
  with no `init`-time notice (`project-executors` `notes`), and
  `EXECUTORS_FILE` in `src/lib/executors.ts` is exported with zero consumers
  while `config-layers.ts` re-spells the same path five times.

- **`fadeno model remove <alias>`** (also `fadeno models remove`) — the other
  half of `model add`. Removes the alias from the USER catalog only, editing
  through the YAML document so comments and sibling keys survive; a builtin or
  project entry is refused by naming the file to edit, because that layer is
  committed policy rather than personal state. It refuses while any dial or
  shadow attachment still names the alias — the failure it prevents is the
  quiet one, where the dial outlives the model and the archetype falls through
  to something else without saying so — and `--force` removes anyway and
  reports every reference it stranded. The alias's rows leave the verification
  cache with it — including, on a harness that encodes effort into the model id
  (`effort_encoding: model-suffix`), rows cached under an effort nothing still
  references, such as a `personal@high` dial that has since been cleared or
  re-pointed. A row records neither the alias nor the effort and efforts are
  free-form strings, so there is no effort universe to resolve; those rows are
  matched by shape (`<base>` or `<base>-…` on that harness) and kept only when a
  surviving entry still delivers exactly that id at its default effort. The
  trade is deliberate: a surviving model shaped like `<base>-<something>` that no
  registered entry delivers may lose its row, and the next `fadeno dial` or
  `fadeno models verify` re-probes and rewrites it — over-invalidating a cache is
  the safe direction; a row outliving the alias it vouched for is not.
- **`fadeno models verify [<ref>...]`** (also `fadeno model verify`) —
  re-probes the models the dials actually point at against each harness's
  `models_command`, **ignoring the cache**. Dial-time verification is
  existence-only (`isModelVerified`), so a row written once vouches forever and
  a model the backend has since retired is discovered by a failed dispatch. A
  model still listed gets a fresh `verified_at`; one the listing definitively
  omits has its rows **deleted** and exits the command non-zero. A listing that
  cannot be read is `unavailable` — it says nothing about the model, so its
  rows are untouched and the exit stays 0 unless `--strict`. `--harness <id>`
  and `<ref>` (alias, delivered id, or `provider/id`) narrow the set; an
  unmatched ref is an error rather than an empty pass. User-invoked only: it
  spawns one listing per pair and must never run on a hook path.
- `removeVerifiedModels(options, predicate)` in `src/lib/user-paths.ts` — the
  verification cache could only ever grow before this.
- `docs/experimental/harness-neutral-dials.md` — the catalog v4 design record:
  the principle, the schema, the resolution algorithm, the shadow-pair
  consequence, the rename table, and the one known gap.
- `harnesses.<id>.variants.<name>`: named alternative argvs of a harness's
  command lane, chosen by POLICY. An archetype the base lane forbids falls
  through to the first variant that permits it — which is how `director opus`
  reaches the fadeno-capable `claude` lane without a dial naming it. Run
  snapshots carry the archetype-specific lane beside the plain ref, so `fadeno
  drive` and `fadeno dispatch` agree on which one a step gets.
- `harnesses.<id>.host.identity`: `model` (the default) or `session`. `session`
  says the host lane can deliver only the session's OWN identity, because that
  adapter rewrites the agent name and nothing else — `opencode` and `omp`
  declare it, restoring the v3 distinction where `host: true` sat on
  `current-host` alone. Without it a named model dialed onto either would have
  been accepted for in-session delivery and then silently ignored.
- A Codex `PreToolUse` spawn guard (`hooks/spawn-guard.mjs`, matcher `Agent`).
  While session-scoped host mode is on it **denies** any subagent spawn whose
  `agent_type` is not a managed Fadeno role agent (`generic_spawn_in_host_mode`),
  naming the model the spawn would have inherited from the parent session and
  the `$fadeno-host off` escape; it also denies a managed role agent whose file
  has drifted from its dial (`agent_file_drift`), since on Codex an agent
  file's `model`/`model_reasoning_effort` win over explicit spawn values and a
  hook can therefore only refuse, never correct. Drift is adjudicated for
  **every host-adapter dial**, whatever lane `fadeno dial resolve` named: the
  resolver reads the session's effort from `CLAUDE_EFFORT`, which Codex never
  publishes, so a *pinned* host dial always answers `lane: command` with
  `lane_reason: session effort unobserved` while the spawn runs in-host on the
  agent file regardless. The file is the proof the resolver lacked — the same
  substitution `decideLane` makes for `hostEffortProven` — so a file whose baked
  `--host-executor` and identity match the dial is recorded as `lane: host`,
  `lane_reason: host agent pins the same effort`, and the row carries the lane
  the guard established rather than the one the resolver guessed. Only a
  command-adapter dial skips the check, because a broker file bakes only the relay's own model and effort and no `--host-executor`; the dial's identity travels out of process in the dispatch argv, so nothing in that file can drift from it. A resolver that fails, times out, or exits 0 with
  output the hook cannot read (an empty answer, non-JSON, or an object naming
  no adapter) is refused in host mode too (`resolver_error`/`resolver_timeout`),
  with the spawn error code — `ENOENT` for a `fadeno` that is nowhere to be
  found — named in both the refusal text and the row. Classification of a
  managed agent is exact: `agent_type` must be a bare name (no `/`, `\` or
  `..`), and the file's `name` key must equal it, because Codex resolves a
  custom agent by that key and not by its filename. In **either** mode every
  spawn is recorded in `.fadeno/dispatches.jsonl`: `host_delivery` (now
  carrying `agent_file`, `drift`, and the Claude row's own `model_applied`) for
  managed spawns, and a new `native_spawn` row
  carrying `model_inherited` for generic ones — `fadeno dispatches` renders
  those as `[native] … [unsteered spawn]`. Before this, the Codex plugin
  registered no `PreToolUse` hook at all: a host session could spawn generic
  subagents on the parent's frontier model with no rewrite, no refusal, and no
  evidence row anywhere. **This adds a new entry to the plugin's
  `hooks/hooks.json`, so Codex re-runs its review-and-trust flow on the next
  session start; the guard is inert until you accept it.**

### Changed

- **The host skill: a `drive` you launched is yours until it exits.** Three
  bullets in the `fadeno-host` policy list, from the same dogfood session. Do
  not end your turn while a drive you launched is still running unless the user
  asked for a hand-off; if you background it, poll it and report each stop — and
  when it stops with `needs_decision`, the next thing you say is the gate: the
  question, the options, the decision id, and how long it has been waiting.
  Repeat a `--bind` on every later drive of the run (the engine now refuses to
  start new work for that role otherwise) and say in the reply which bindings
  each drive carried. Coordinator steps of a run — a plan, a contract, a final
  summary — are the session's to fulfil by default, because they need the
  context the session already holds; delegate one only when producing the design
  itself is the work, and say so.
- **The parallel-workstreams contract: collision avoidance is the purpose, and
  its weight is judgement.** The coordinator role prescribed the contract's form
  ("freeze the shared contract — names, schemas, interface tokens") and said
  nothing about why it exists, and the observed result was a 29 KB coordination
  contract for three workers on an already-designed feature. The purpose now
  leads: find where the parallel changes could collide — the same file, the same
  name, the same interface — and prevent it before any fan-out. The file-disjoint
  ownership manifest, every cross-cutting file belonging to the integrator, is
  named as the one invariant, with the reason (the engine fans out on it and the
  integrator reconciles against it); the rest is as short as the collision risk
  allows, citing design docs rather than restating them. The `Contract`
  artifact's own `instructions` — the operative text, the one the coordinator
  reads when it writes the document — says the same thing now, rather than
  "state the shared contract first: exact names, schemas and interface tokens
  every workstream must use verbatim"; the manifest invariant, the generation
  precedence and the closing reconciliation sentence are kept verbatim. On
  rejection, the
  sentence forbidding "a diff or patch" is gone: correct what the feedback names
  and keep everything it did not touch — still one complete document, highest
  generation authoritative. The `accept_contract` gate says what the approver is
  approving (ownership and interfaces, not a design review), and the runner
  skill now names the lighter path: when interfaces are settled and ownership is
  obvious, independent isolated role dispatches plus one review carry the same
  receipts without a contract gate. Prose only — every step id, gate, artifact
  name, `when_to_use` token and role name is byte-identical, and a new
  structural test pins that.
- **Two supervisor test fixtures are bounded.** The `sigkill-orphan` and
  startup-race fixtures ticked forever by design, on the assumption their
  `t.after` teardown would always run — which it does not when the test runner
  is itself SIGKILLed. One of them wrote 271,863 files that way. Both now stop
  at 600 ticks (60s), far beyond what either assertion needs.
- **Host mode now treats a Fadeno failure as a user-facing event.** The policy
  the host-mode hook injects (and its twin in the `fadeno-host` skill) says a
  refused, failed, timed-out or empty dispatch — plus a resolver error, an
  unspawnable or drift-refused role agent, an executor that cannot run the
  checks it was asked to run, or a stuck workspace lease — **stops the work and
  goes to the user before any fallback**, in the reply and not only in
  `.fadeno/feedback.md`, with the dispatch id or ledger row and the error text.
  Substituting a generic native subagent, a different model, or the host's own
  hands now requires the user's explicit go, and a proposed fallback must say
  what it runs on and what it costs. While dispatches are live, **every reply
  names what is running, waiting, failed and completed, with the model and lane
  of each**, so a substitution cannot hide inside a progress summary. The
  2026-09-04 receipt this comes from: a host whose command lane failed wrote a
  dutiful feedback entry and then quietly spawned three generic subagents on
  the session's frontier model.
- The Claude steering hook is now symmetric with the Codex spawn guard on
  generic subagents. While host mode is on it **denies** any `subagent_type`
  that names no Fadeno archetype (`general-purpose`, `Explore`, `Plan`, custom
  agents) — **and a call that omits the field entirely**, which starts the
  harness's default general-purpose subagent — with the same predicate the
  Codex guard writes, `generic_spawn_in_host_mode`, naming the model the spawn
  would have run on, the role agents to use instead (locally managed ones when
  the repo has them, otherwise the plugin's `fadeno:worker`,
  `fadeno:reviewer`, `fadeno:judge`), and `/fadeno:host off`. With host mode
  off the spawn passes through untouched as before, but is now recorded as a
  `native_spawn` row (`agent_type` null when none was named; `model_inherited`
  null — a Claude `PreToolUse` event publishes no session model;
  `reasoning_effort` is the caller's request, always null here, with the
  observed session level under `session_effort`). Archetype-named spawns keep
  their routing.
- Every refusal both plugins' `PreToolUse` hooks write now ends with the
  sentence `Report this refusal to the user instead of routing around it.` —
  on the Claude hook's `resolver_error`, `resolver_timeout`, `restart_required`
  and generic-spawn paths, and on every Codex guard denial. The evidence rows
  keep their compact reason; the instruction is for the caller.

### Removed

- `fadeno model add`'s direct-OpenCode discovery step. It registered a model
  onto the `opencode-direct` ROUTE, which v4 turned into the `direct` VARIANT
  of the `opencode` harness — and a variant is chosen by policy, so neither a
  dial nor a model entry can name one. Registering it anyway would write an
  entry that silently resolves onto the OpenRouter lane carrying a direct id.
  Discovery now uses the OpenRouter-qualified identity only, and an id that IS
  on the direct listing is refused by name, pointing at the design record's
  "Known gap".
- The stored default harness. `fadeno setup --codex|--claude` no longer
  records "the harness" in user state, and nothing reads such a memo:
  `activeHarness()` resolves `FADENO_HARNESS`, then a single ambient host
  marker, then `standalone`. A bare shell is standalone, always; host-specific
  compilation happens only inside a harness. `setup` and `uninstall` remove a
  leftover memo (and the dead `loadout` file) and say so. `fadeno models
  --json` no longer reports `harness_source: "user default"`.

### Fixed

- **`doctor` called a Codex agent file `ok` two lines under its own
  `unmanaged` warning about that same file.** The fix below added `unmanaged` —
  Codex will load this file, Fadeno did not write it — to the identity row that
  `status`, `dial` and `doctor`'s `codex-agents` check all print. `doctor`'s
  own `codex-agents-project` finding never learned it: an unmanaged
  project-scope file with no user-scope counterpart was reported as a
  "project-scope Codex broker … so nothing is being shadowed", severity `ok`,
  in the same report that had just refused to vouch for it. One file, two
  verdicts, in two commands a user runs side by side — and this instance was
  created by the fix for the previous instance of the same bug class.

  Both surfaces are kept, because they are asking different questions and both
  answers are true. `codex-agents-project` is RELATIONAL: does this project
  file override the managed user-scope set? With no user file underneath it,
  nothing is being overridden, and that is genuinely `ok` — a second warning
  about the same path would read as a second problem. `codex-agents` is about
  the file Codex would actually load: can Fadeno vouch for it, and does its
  identity match the dial? What was false was neither verdict but the finding's
  SCOPE CLAIM. It called every project file a "broker" — a Fadeno artifact
  noun, asserting a provenance the check never checked — and its unqualified
  `ok` read as a clean bill of health. It now says what it read and what it did
  not: the unmanaged file is named as carrying no managed header, the `ok` is
  stated as covering the shadowing relation only, and the file itself is handed
  to the `codex-agents` row. Its remediation stops promising that such a file
  "would win over" the managed set once `fadeno setup --codex` runs, without
  adding that it would then never be refreshable;
  `CODEX_UNMANAGED_IDENTITY_REMEDIATION` is interpolated rather than re-spelled.

  The point is not the wording, it is that the two surfaces can no longer drift.
  The shadow findings now take their file set from
  `effectiveCodexAgentCandidates` — the one encoding of Codex's
  project-over-user precedence — instead of re-sweeping `.codex/agents/`
  themselves, and their standing verdict from `codexAgentFileVouched`, which is
  `codexAgentIdentityRow` asked with a null dial. A null dial is the builder's
  own "unresolvable" input, under which no identity comparison happens and only
  the standing verdicts are reachable, and the helper asks for
  `not_applicable` rather than for NOT-`unmanaged` so that a standing verdict
  added later stops `doctor` vouching automatically instead of slipping past a
  predicate that knew one name. A second hand-rolled `!managed` test is exactly
  how these two came apart.

- **`fadeno status` and `fadeno dial` judged a Codex agent file that no session
  loads.** Both read `$CODEX_HOME/agents/fadeno-<archetype>.toml` and nothing
  else, while Codex resolves `<repo>/.codex/agents/<archetype>.toml` FIRST and
  never looks underneath it. So the identity comparison added on 2026-09-05 —
  the one that exists because an agent file is a frozen identity no spawn value
  can correct — was run against the wrong bytes: `status` printed `current`,
  `doctor` said "managed host-agent state is current", and the file that would
  actually spawn was a different one, possibly carrying a different model and
  effort, possibly not written by Fadeno at all. This is not an exotic state.
  `fadeno init` writes exactly those three project paths, so every scaffolded
  repo on a machine that has also run `fadeno setup --codex` was in it, and
  `doctor` — which has read the effective set through
  `effectiveCodexAgentCandidates` since it grew shadow-drift findings — was
  reporting one rule while the two identity surfaces applied another. One list,
  two consumers, disagreeing: the same shape as the digest skew above.

  `dial` failed the same way twice, and the second way was silent: its
  `if (state == null) return null` meant that when a project file shadowed an
  ABSENT user file, it concluded there was no managed agent to disagree with
  and printed nothing at all.

  Both now go through `codexAgentIdentityRow`, which feeds
  `codexAgentIdentityStatus` — unchanged, and still declining to judge a
  command broker — the file Codex would actually load. Each row carries the
  `scope` and `path` it judged, because a verdict you cannot attribute to a
  file cannot be acted on, and two new verdicts name what the identity
  comparison alone would have got wrong:

  - `unmanaged` — Codex will load it, Fadeno did not write it. Deliberately not
    judged on model/effort: a hand-authored file whose two identity keys happen
    to match the dial would otherwise be called `current`, which reads as a
    claim about the whole file. It is not one — nothing here verifies the
    instructions that make an agent resolve an envelope at all, and
    `steering apply` will never refresh it.
  - `shadowed` — a project-scope command broker shadows the host agent a
    host-lane dial needs. `stale` would have been a lie in the other direction:
    a broker carries the relay's model and effort by construction, so the
    accusation would be about an identity no apply would ever write there. What
    is actually wrong is structural — the host lane cannot be delivered in that
    repo at all.

  The remediation had to split with it. `CODEX_IDENTITY_REMEDIATION`
  (`--scope user`) is not merely unhelpful for a project-scope shadow, it is
  wrong: it rewrites the invisible file, the drift survives, and the next
  session loads the same identity — and `--scope user` resolves the user dial
  layer only, so it cannot bake the session or repo dial the row was judged
  against. `CODEX_PROJECT_IDENTITY_REMEDIATION` re-cuts or deletes the project
  copy; `CODEX_UNMANAGED_IDENTITY_REMEDIATION` says move the file, because no
  apply overwrites one Fadeno did not write and `--force` is a project-scope
  override only. `codexIdentityRemediation` is the single place that mapping
  lives, so the three surfaces still cannot drift apart on it.

- **One prompt digest for the shadow-pair roll — the hook and the kernel now
  agree.** The steering hook rolled a spawn's shadow attachment on the caller's
  prompt bytes; the kernel re-rolled the same attachment on the bytes it had
  already decorated with the archetype brief and `DISPATCH_RESULT_FOOTER`. Two
  digests, two independent coins: a spawn the hook selected as a pair — and
  therefore rewrote onto the dispatch proxy, because a selected pair takes the
  command lane on both arms — could reach a kernel that formed no pair at all
  and quietly delivered a plain dispatch. Observed 2026-09-05: hook digest
  `156ac11e…` SELECTED, kernel digest `fe4f9fc1…` not selected, no pair, and
  nothing anywhere saying so. The **caller prompt digest** (`callerPromptDigest`
  in `src/lib/executors.ts`) is now defined once as sha256 of the prompt bytes
  before any kernel decoration, and every consumer keyed on "which prompt is
  this?" reads it: the kernel's pair roll, the relay attestation, and
  `fadeno dial resolve --prompt-sha256` / `fadeno steering resolve
  --prompt-file`. The roll's other shared input is pinned the same way — the
  kernel now spells the challenger with `shadowAttachmentRef`, the expression
  both resolvers already used, instead of re-inlining it.
- **...and across the relay, not only the decoration.** The digest is taken
  over CANONICAL caller bytes: the prompt with its trailing newlines stripped
  (`canonicalCallerPrompt`). The two processes are separated by the dispatch
  proxy's quoted heredoc, and the shell feeds a heredoc as each body line plus
  a terminating newline — which a director's `tool_input.prompt` does not
  carry. Hashing raw bytes would therefore have split the hook's and the
  kernel's digests again, for every prompt that did not happen to end in a
  newline, with the decoration bug already fixed. The rule is stated once and
  applied by every writer of the digest — the kernel, the Claude steering hook,
  the Claude proxy guard's `proxy-dispatches.jsonl` marker, the OpenCode plugin
  and the omp extension: two prompts that differ only in trailing newlines are
  the same prompt, for pairing and for attestation, and nothing else is
  normalized. It also reconciles the two spellings of one prompt — an inline
  `--prompt-sha256` computed from a spawn's own string and a `--prompt-file`
  that, like most files, ends in a newline.
- **Relay attestation stopped missing on brief-carrying archetypes.**
  `consumeRelayAttestation` ran after the brief was composed in, so it hashed
  bytes no hook had ever seen: the proxy marker missed, and the row recorded
  `relay_attested` absent ("no proxy sent this") for a dispatch a proxy
  demonstrably had. Same skew, different consumer; it now reads the caller's
  bytes.
- **A rewritten spawn leaves a row and tells the session.** When the Claude
  steering hook takes a host-eligible spawn off the host lane and onto a
  dispatch proxy, it appends a `host_rewritten` evidence row (`archetype`,
  `agent_type`, `subagent_type_applied`, `model_applied`, the dialed
  `executor`/`model`, `lane`, `lane_reason`, `reason` ∈
  `shadow_pair_selected` | `command_lane`, `challenger` and `rate` on the pair
  reason, `prompt_sha256`, `host`, `harness`, `dial_source`, `hook_version`)
  and returns a one-line `systemMessage` beside the rewrite. Only for a spawn
  that was actually on the host lane: a caller that named
  `fadeno:dispatch-<archetype>` itself is resolved like any other archetype
  spawn (a host slot can still pull it back in-session) but is never recorded
  or announced as a rewrite, since nothing was diverted — its relay attestation
  is still stashed, which is about the bytes rather than the lane. Previously
  the rewrite was recorded nowhere: `host_delivery` is deliberately not written on
  that path, so the only trace was a kernel dispatch naming the relay rather
  than the spawn that caused it. `fadeno dispatches` renders it as its own
  `[rewritten]` kind — never a delivery, so it can neither read as in-session
  work nor absorb a `host_attestation` owed to a real one.
- `dispatch_requested` / `dispatch_completed` rows gain
  **`caller_prompt_sha256`** beside the existing `prompt_sha256`. The two answer
  different questions — the snapshot the executor received (brief and footer
  included) versus the bytes the caller wrote — and only the second is stable
  across `--brief`, which is what makes it the join key from a hook row to the
  kernel rows it produced. Additive under ledger format `1.1`, not a bump: the
  reader tiers on the format's MAJOR, so a new event name and a new field need
  no new version, while bumping would make every older reader skip *all* rows as
  "newer format".
- Isolated host workspaces now replay the caller's tracked and
  untracked/unignored changes as their synthetic baseline, so concurrent
  reviewers see the uncommitted implementation they were asked to review and
  their diff receipts contain only post-baseline work. Runner guidance now
  prepares an entire evaluative host fan-out before spawning any member,
  allowing reviewers and judges to bypass the shared-workspace lease safely.
- Locked Codex host dispatches no longer advertise a generic command broker or
  a role agent materialized for another executor as `delegate_to`; those
  agents would resolve the same envelope recursively instead of executing it.
- **Corrected the Codex agent-file precedence claim, and the two predicates
  built on it.** Five surfaces asserted that an explicit spawn value beats a
  custom agent file; on Codex the file's `model`/`model_reasoning_effort` take
  precedence over the value passed at spawn (the receipt is cited once, on
  `findSpawnableCodexAgent`). So `steering resolve` now offers `delegate_to`
  only for a managed agent whose **file identity equals the locked request**; a
  stale one is named in `detail`, with the `steering apply --codex` plus
  fresh-session fix, rather than offered as a spawn target that would silently
  run its own identity. `doctor`'s `codex-agents-fallback-avoidable` counts a
  command fallback as avoidable on the same basis. Runner guidance stops
  presenting explicit spawn values as the delivery mechanism: the file carries
  the identity, and passing `model`/`reasoning_effort` at spawn is harmless and
  overrides nothing.
- For **ordinary (unlocked) resolutions**, `steering resolve` no longer treats a
  matching `--host-executor` ref as proof that the host agent pins the dialed
  effort. The ref identifies which agent is asking; the proof is
  `model_reasoning_effort` in its managed file, so the file must carry it — the
  same check the spawn guard makes. Engine assignments are unaffected: the
  locked path never consults the lane predicate. **User-visible:** a pinned
  reference-frame-neutral dial (`worker: current-host@xhigh`) on Codex now
  resolves off-host — `restart_required` with the shipped catalog, which
  declares no fallback for `current-host` — because `renderCodexHostAgent`
  omits both identity lines for that sentinel, so its agent file can never
  carry the pin and Codex publishes no session effort to observe either. The
  refusal names the two real exits: drop the pin, or dial a concrete model.
  Previously such a dial resolved `mode: host` on a proof that did not exist.
- **A stale personal model alias could no longer fail the load.** Observed
  2026-09-05 against the working tree: one `fadeno model add` entry in
  `~/.config/fadeno/executors.yaml` (`ox`, provider `stealth`, registered
  before v4) made `fadeno dial` fail in every repo, with a message naming
  neither the alias nor the file. The user catalog is machine state, not
  catalog policy, so it is now read TOLERANTLY: `repairUserLayer` runs before
  the merge — and therefore before both the removed-key refusal and the
  parser — translating `models.<m>.delivery: {route, id}` into `harness:` plus
  `spellings.<harness>:`, mapping legacy driver aliases in `spellings` keys,
  re-emitting a ` via <driver>` in a user `dials:`/`bindings:` ref as
  ` on <harness>`, discarding a user-layer `routes:`/`relay:` with a note, and
  dropping anything it cannot translate. A user model the merged `harnesses:`
  table cannot deliver is still dropped; a spelling naming an undeclared
  harness is dropped with it; and a user override that would make a name the
  builtin or project layer already declares undeliverable **restores the lower
  layer's entry** and names the collision instead of removing the name from the
  catalog. Everything changed is reported in `modelFallback.repairs` and printed
  by `fadeno dial`. A **project or builtin** catalog in any of those shapes is
  still a load error with its migration note — a file someone edits is not
  machine state.
- **Every host-slot decision now reads `hostCandidateOf`, and every snapshot
  read carries its archetype.** `spec.adapter === 'host'` is not "can go out
  in-session": a host spec is also how a delivery with NO argv is represented,
  so `steering apply --opencode` wrote an in-session OpenCode role slot for
  `opus on omp` — a host nobody is sitting in — naming a model OpenCode was
  never handed. All six materialization sites, `fadeno status`'s
  materialization comparison, and `fadeno models`' `native` column now key on
  the lane. Separately, `--bind` on `fadeno drive`, `runDispatchFallback`, the
  `verify` host checks and `steering resolve` read the run snapshot through
  `snapshotExecutor(profile, ref, archetype)`, so a run that froze an
  archetype-specific lane (a policy-chosen variant) replays the lane it
  actually used rather than the base one; and the snapshot is cut with the
  PLAYBOOK's role archetypes as well as the catalog's, so a custom role
  archetype constrained only by a harness lane's `eligibility:` is specialized
  too.

## [0.6.1] — 2026-09-04

### Added

- Added explicit, session-scoped Fadeno host-coordinator mode for both plugins:
  `/fadeno:host` in Claude Code and `$fadeno-host` in Codex. Lifecycle hooks
  preserve the policy across later turns and compaction without modifying a
  repository's `AGENTS.md` or `CLAUDE.md`; `off` disables it for the session.

### Fixed

- Prevented command executors from accidentally recursively dispatching through
  Fadeno by carrying dispatch provenance across ad-hoc, shadow, fallback,
  engine-actor, and registered-tool spawn paths.
- Made dispatch tags unique recovery handles, including concurrent and
  in-flight reuse protection.

## [0.6.0] — 2026-08-22

The engine release. `fadeno drive` advances a run deterministically until it
is terminal or paused on a human decision (`fadeno decide`), dispatching each
actor call to an executor profile from `.fadeno/executors.yaml` — a command
harness (Codex, Claude Code, Antigravity, OpenCode) or the host session itself
— and recording every assignment as an immutable, digest-pinned request
envelope with a receipt. Around it: per-archetype **dials** replace named
loadouts (catalog `schema_version: 3`, snapshot `snapshot_version: 3`, no
compatibility for the pre-dials shapes); **shadow pairs** and `fadeno bakeoff`
put two arms of one task in evidence; **isolation** — members run in worktrees
under a repo-wide writer lease and merge back like a pull request, and the
write-permission system is gone; `--parallel` waves for map members; a
compositional map/loop runtime; and `fadeno verify` grows from 16 to 37
checks, with a receipt behind every artifact and a tamper matrix in the repo
that proves what each check catches. **Breaking: run-ledger format 0.3.**
Unversioned (pre-0.2) ledgers are refused unless `--legacy` is passed;
pre-dials catalogs and snapshots are refused outright. The Codex CLI plugin
(`fadeno plugin --codex`) ships alongside the Claude Code one.

Subsections stamped with a release candidate name the candidate that shipped
them.

### Fixed — `fadeno show` no longer calls an isolated engine attempt shared (0.6.0-rc.62)

The live-holder line under `fadeno show` projected every inflight engine claim as `workspace_mode=shared`, hard-coded, while the `actor_dispatched` row for the same attempt said `isolated` and named its worktree. Found watching a real isolated implementer in the regenerated 0.6 exhibit. The projection now reads the mode from the ledger row that named the claim (`supervisor_claim`), and a claim no row names still reads `shared`. Harness-observed and non-gating either way — but a watcher deciding whether a hung attempt holds the shared tree should not be told the wrong thing.

### Added — every artifact has a receipt (0.6.0-rc.61)

Two artifact classes carried no completion receipt, so nothing anchored them and either could be renamed out of the audit — the tamper matrix had measured this as a known gap on every run since rc.57. Both are receipted now, and both gaps are closed rather than tracked.

- **`collective_assembled`** — the engine's receipt for a map's collective, the artifact a gate reads. It names every member part in order (`parts`, `members`), the `step_execution_id`, and the digest of the reduction. `fadeno verify` gained **`collective-provenance`**: it parses the receipted parts from disk, reduces them through the same `reduceCollective` the engine used (`src/lib/collective.ts`, one function for both), and holds the receipt's digest, the manifest's digest, and the bytes on disk to that result. A collective rewritten with every digest "fixed" to match still fails — only the reduction from its parts is the truth, and `artifact-digests` cannot see that. Presence is read from the playbook snapshot with the flow cursor's own rule (an artifact on a map step that no member produced is the collective), so deleting the receipt is not a way back to the unanchored shape.
- **`tool_recorded`** — the receipt `fadeno tool-complete` now writes after the manifest: tool, `tool_call_id`, attempt, generation, `output`, `output_sha256`, and `recorded_by: host`. It is deliberately not `tool_completed`: that word means the kernel ran the tool and carries a command, an exit code, and a duration, none of which a hand-recorded result has. The measured checks (`tool-lifecycle`, `tool-command-digest`, `tool-result-coherence`) keep skipping for a recorded result — the receipt says by its name that there is nothing measured to recompute. `verify` gained **`tool-artifact-receipts`**: every artifact that completes a `tool_call` step is claimed by `tool_completed` or `tool_recorded`, and a recorded receipt's digest matches both the manifest and the bytes on disk.
- **`receipt-output-manifests`** anchors on all four receipts now (`actor_completed`, `tool_completed`, `tool_recorded`, `collective_assembled`).
- **Tamper matrix.** `unreceipted-artifact-renamed` is no longer a known gap — on a trace written since rc.61 it finds nothing to mutate and says so (`every artifact on this trace is claimed by a receipt`). Six fixtures attack the new receipts directly (`collective-renamed`, `collective-receipt-dropped`, `collective-forged`, `recorded-tool-renamed`, `recorded-tool-receipt-dropped`, `recorded-tool-forged`); all six are caught. The matrix now runs `verify` on the untouched copy first and **skips a trace that already fails** — a fixture "caught" by a failure that was already there proves nothing — and runs the checks from source (`src/cli.ts`) rather than a possibly stale `dist/`.

**A ledger written before rc.61 fails `verify` under rc.61 by design** wherever it has a collective or a hand-recorded tool result: the new checks say `(a ledger written before 0.6.0-rc.61 carries none — regenerate the trace)`. The three 0.6 dogfood traces in `fadeno-demo` are in that position; whichever becomes the exhibit needs one more drive. This is the decision the gap was held open for — a change to what a command writes, made before the freeze, not after.

### Changed — merge-back works like a pull request (0.6.0-rc.60)

The worktree is the branch, your working tree is main, and main moves while members run — sibling members merge back, you edit. The branch reconciles; main only ever receives a plain `git apply`, which lands every hunk or touches nothing. Your tree never carries a conflict marker from a merge-back again.

- **Rebase before apply.** When the tree moved, the kernel commits the attempt's work, moves the worktree to your HEAD, replays your current uncommitted state as a fresh baseline (`rebased_onto` on the stamp), and cherry-picks the work on top — all in the worktree, all under the one write window, so a clean rebase's re-apply cannot refuse. Two members editing different lines of one file both land; neither knew about the other.
- **`unresolved` replaces `conflicted`.** A rebase that conflicts stops with the worktree *retained* and the markers in it; the stamp names `conflicts`, the receipt names the worktree (`workspace`, `workspace_retained: true`). `conflicted` meant "your tree MAY be partly applied, go look" — nothing can produce it now, and the word is retired rather than reused with a different meaning.
- **The branch owner resolves.** An engine attempt whose merge-back is unresolved fails as `merge_conflict` and the executor is re-invoked *in that worktree* as a new attempt with `attempt_reason: merge_conflict` — the request carries the conflict list, the rebased `baseline_commit`, and a `conflict_appendix`; a resumed session keeps its context, like a PR owner would. Two rounds. A round that leaves markers in the named files is unresolved again, because git would have applied them as content. Past the cap: `merge_back_failed`, worktree still retained.
- **`fadeno attempt-accept <run> <actor-call-id>`** is the human's half. Resolve the markers in the retained worktree; it validates the executor's parked report (`attempt_output` on the failure) against the step's schema, merges — rebasing first if the tree moved again — writes the artifact, and records a `host_resolved` attempt with its `actor_completed`. The next `fadeno drive` continues; no executor re-runs. Refuses, touching nothing, while markers remain.
- **`fadeno dispatches --merge <id|tag:…>`** is the same for an ad-hoc dispatch, which has no engine to re-invoke its executor: `unresolved` there means retained for whoever launched it. Records a `dispatch_merged` row; `--output` reads the later fact.
- **`verify` gains `merge-conflict-rounds`:** every `merge_conflict` / `host_resolved` request must follow an `unresolved` failure of the previous attempt on the same call, retained worktree and all, naming the same conflicts and the same rebased baseline. A tamper fixture (`conflict-round-relabelled`) keeps it honest. Engine dispatch rows now carry `output_path` and `artifact_type` so an acceptance never recomputes them from a playbook that may have moved on.
- **Retired with it:** the `does not exist in index` working-tree fallback from rc.58 — a plain apply handles an untracked path natively, so the case it worked around no longer exists.

### Changed — no executor deadline by default, and the kernel's window leases can die (0.6.0-rc.59)

Two decisions from talking the 20-minute ceiling through, instead of the fix the previous entry deferred.

- **No deadline unless you set one.** Every command route in the committed catalog pinned `timeout_ms: 1200000`, and on 2026-08-22 that killed a legitimate implementation pass and two of six reviews. Agent work has a long tail, and a clock cannot tell slow from stuck; the only thing a deadline protected was what a hung executor *holds*, and an isolated executor holds its own worktree and nothing else — no lease, no shared tree. So the template declares no `timeout_ms`, `--timeout` is opt-in (`0` also means none), and ending a long attempt is a decision for whoever can look at it: `fadeno show` reports idle output and never acts on it; `fadeno cancel` / `dispatches --cancel` end it. The one behavioral change to know: a `drive` wave waits for every member, so a hung member now holds the run until you act, where it used to be killed at 20 minutes. Catalogs initialized before this release keep whatever they declare.
- **Window leases carry the kernel's pid.** The kernel's brief holds on the shared tree — a baseline capture, a merge-back — were taken with no pid, and a pid-less lease was treated as alive forever. A kernel killed inside a window (the `kill-drive mid-wave` test, about one run in three — not a flake, this) left a lease that refused every later writer, including recovery of the very run that took it. `withWorkspaceWindowLease` is now the one way to hold a window: it waits its turn (30 s, the only clock left in the system, and it bounds waiting for a turn, never anyone's work), stamps `process.pid`, and releases in a `finally`. Both the engine's windows and the ad-hoc dispatch's merge-back go through it — and so does the ad-hoc dispatch's *baseline capture*, which had been reading the tree with no lease at all while an engine member's merge-back could be writing it. Pid-less window leases written by older kernels age out after two minutes; a pid-less executor lease never does.

### Fixed — a deadline-killed dispatch read as success, and one untracked path dropped a whole merge-back (0.6.0-rc.58)

Both found in a second harness's loop on 2026-08-22, not in the dogfood runs: a `fadeno:worker` dispatch routed to an external executor was SIGTERMed at the 20-minute route deadline, its merge-back refused because the directory it edited was untracked in the caller's workspace, and the dispatch proxy reported "completed" with a 0-byte attested output. The kernel had recorded the truth the whole time — `outcome: timeout`, `signal: SIGTERM`, `output_bytes: 0`, `primary_merge.status: conflicted` — on a row nothing the proxy could run would show it.

- **`fadeno dispatches --output` leads with the verdict.** The recovery reader — the one command a proxy is told to run after its own Bash call dies — loaded only `completed` and `output_sha256` and printed `output attested: sha matches the completion row`. That is true of a killed executor: empty bytes hash to an empty row. The result now carries `outcome`, `exitCode`, `signal`, `outputBytes`, `timeoutMs`, and `primaryMerge`, and the stderr note reads `TIMED OUT: the kernel killed the executor at its 1200s deadline (SIGTERM); the work did NOT finish. 0 bytes …` / `FAILED: exit 2` / `NO OUTPUT: …` / `ok: exit 0, N bytes`, then any merge-back that did not land, then the attestation. The direct call says the same instead of `exited 1` — a signal-killed process has no exit status, and that 1 was a stand-in.
- **The four proxy templates relay the verdict.** Step 4 told a proxy to "report the exit code recorded", a fact the recovery never printed. It now names the four verdicts, says that `output attested` is not one, and that `TIMED OUT` is a kernel kill to report in those words and never as completed.
- **An edit to a path the workspace holds untracked merges back.** The baseline commits the caller's untracked files into the worktree, so the attempt's diff describes a tracked-file modification; `git apply --3way` implies `--index`, finds no index entry, and refuses the *whole* patch with `does not exist in index` — tracked hunks included — before writing anything. The receipt called that `conflicted`, which means "inspect the tree", about a tree it had not touched. `applyMergeBackDiff` (one helper, both merge-backs) now re-applies to the working tree alone when that is the only refusal, stamps `clean` with a detail naming the paths and that they landed unstaged, and stamps `blocked` — tree untouched — when even that refuses. The recovery pointer is `git apply <diff>` in that case, since `--3way` would reproduce the refusal.

**Left open, deliberately: the 20-minute ceiling itself.** Every command route defaults to `timeout_ms: 1200000`, `--timeout 0` lifts it, and the proxy contract call cannot pass it — the guard permits exactly one shape. A worker pass through the proxy therefore cannot exceed 20 minutes, and a real implementation pass routinely does. Raising the route default, giving the worker archetype its own, or letting the proxy pass `--timeout` are policy choices about how long an unattended executor may hold the tree, so they are recorded in `next-protocol.md` rather than decided here.

### Added — two verifier checks the tamper pass found missing (0.6.0-rc.57)

The pre-freeze adversarial pass is now `scripts/tamper-matrix.mjs` (`npm run tamper -- <run-dir>…`): it copies a real trace, applies one mutation per `next-protocol.md` fixture, and asserts both that `verify` fails and that the check which should have caught it is among the failures. Across the four dogfood traces: **47 caught, 0 uncaught, 3 known gaps, 2 not applicable**. Two fixtures verified *clean* before this change, which is how both checks were found.

- **`event-vocabulary`** — a pre-0.3 event name inside a current-format ledger is now refused. Renaming `artifact_created` to its old spelling `artifact_written` made every artifact check stop seeing the artifact — no manifest, no digest, no file required to exist — and `verify` reported zero failures. An unrecognized event was dropped from consideration rather than rejected, so the old name was a way to remove an artifact from the audit while the ledger still looked intact. The rename table is now one exported list with two consumers: `normalizeLegacyEvents` rewrites those names under `--legacy`, this check refuses them without it.
- **`receipt-output-manifests`** — the same trick with a name in *no* vocabulary at all, which no list of names can ever catch. This anchors on the receipt instead: a delivery that claims an `output` must be accounted for by a manifest. The host lane already had the cross-check (`host-dispatch-artifacts`); the command and tool lanes did not.
- **The `output_valid: false` exemption is conditional.** A failed attempt names the path it was *asked* for while its bytes are parked under `artifacts/attempts/`, so requiring a manifest there would fail every repaired run. The exemption is granted only when a later attempt supersedes the failed one — otherwise one field would excuse any missing artifact, and an escape hatch anyone can claim is not an exemption.

**Two gaps left visible rather than closed quietly.** A tool result recorded by hand with `fadeno tool-complete` emits only `artifact_created` — no dispatch, no receipt, three tool checks skipping — and an engine-assembled collective (`artifacts/parts/<step>.json`) has no receipt either, which makes the artifact a gate reads the one with the weakest provenance in the ledger. Both are measured every run by the `unreceipted-artifact-renamed` fixture and reported as tracked gaps. Closing either means emitting a receipt where none exists today, which is a decision to make before the schema freeze rather than a side effect of a fixture.

### Fixed — every surface that explains `--parallel` described a mechanism that no longer exists (0.6.0-rc.56)

Four surfaces tell you how `--parallel` obtains concurrency, and all four were wrong, in two directions from two different releases. `fadeno --help` and `fadeno drive --help` said command members "currently SERIALIZE regardless" and named worktree isolation as future work — in the release that ships it. The `fadeno-driver` and `fadeno-runner` skill docs were older still: "read-only members overlap; shared writers stay serialized by the workspace lease", explaining concurrency through `write_access: false`, a declaration deleted in rc.50. Those two are the surfaces an *agent* reads.

`drive.ts` itself was correct throughout, and correctly conditional — its runtime NOTE fires only under `!repoHasGit`, the one case where members still serialize. The truth simply never reached the four places that repeat it.

All four now say the same thing: in a git repo each member runs in its own detached worktree and merges back, so members overlap whatever they write; without git they share the tree and serialize on the repo-wide writer lease.

- **The tripwire pins the named mechanism, not the token.** Presence-pairing could not catch this class — every file still said `--parallel`, they just said something false about it. `every --parallel surface names the mechanism that is actually implemented` requires passages that discuss interleaving to name the worktree and forbids the deleted read-only/shared-writer vocabulary. It found the `fadeno --help` line that a manual sweep had missed.

### Removed — the write-permission system (0.6.0-rc.50)

**Fadeno no longer models write permissions.** It selects an argv and records what ran; enforcement belongs to the vendor flags you can read in the command (`--sandbox`, `--permission-mode`, `--disable-shell`), and containment belongs to isolated worktrees. Every Fadeno-level "permission" was a claim in YAML that nothing checked — and in one day that layer produced four distinct silent-wrong-answer defects. The design record is `docs/experimental/permissions-and-isolation.md`, written before the change and kept as the anti-drift artifact.

- **Gone:** `requires_write` on archetypes, `write_access` and `write_variant` on routes, `--force`/`force_write_posture` on dials, `applyWritePosture`, `explainWriteConflict`, the `shadow_write_posture` refusal, and the write half of `explainPairRoutability`. Net −2,200 lines.
- **The inversion:** routes are argvs, permissive by default. A restriction is now a *separate route with its own name*, visible by reading its command rather than carried in metadata beside it. 21 write-variants were promoted to be their route's own command.
- **Refused, never ignored.** A catalog still carrying any removed key fails to load with `is no longer supported` and a pointer to the design record. Silently dropping a key someone wrote in order to *restrict* something is the failure mode this whole change exists to end.
- **`write_variant` never meant what it said.** It swapped the entire argv, so in the shipped catalog it silently dropped `--sandbox read-only` (xai), `--agent fadeno-readonly` (openrouter), and both `--disable-write` *and* `--disable-shell` (muse) along with granting writes. The posture layer could not see this, because every variant is correctly write-capable once applied.
- **Claude-as-harness is no longer uniquely restricted.** Under `claude`, `anthropic` is a `host: true` route, and host routes were refused a `write_variant` at parse — so the same driver escalated fine under `codex` and `grok` but never under Claude. Its fallback lane now carries the permissive flags directly.
- **Posture is replaced by measurement.** `fadeno bakeoff` compares the two arms' *recorded argvs* and stamps a `capability_skew` confound when they differ beyond model and effort. Observed rather than declared, catches any capability difference rather than only the write bit, and cannot produce a false refusal.
- **Constraint policies get the argv** in place of the `write_access`/`write_variant`/`write_posture` triple — they can now gate on what will actually run, which makes them the one real gate at the Fadeno layer.
- **`fadeno doctor` lints an `archetypes:` policy nothing dials**, which is how a misspelled key (`wroker:`) used to leave the real archetype silently unguarded.

**Consequence, since resolved in this same release — `--parallel` serialized command members.** The lease bypass keyed on a route declaring `write_access: false`, so what actually parallelized was read-only reviewer/judge fan-out; `worker` always took the lease and always serialized. That speedup was paid for by the read-only base argvs this change removes — the parallelism and the posture were one mechanism. See *Isolation, delivered* below for how it comes back.

### Changed — isolation, delivered (0.6.0-rc.52)

The permissions cut made an isolated worktree the default and then never delivered it: an unpaired dispatch degraded straight back to shared, so the request row said `isolated` and the completion row said `shared`. The blocker was recorded as an ambiguity — "isolated" meant both *hold this out of my tree* and *the kernel isolated you, so merge back* — with default isolation a third case needing paired semantics without a pair.

- **Merge-back keys on who asked, not on whether a pair exists.** `--isolate` is a caller saying *hold this out*, and never merges back. Everything else is kernel-chosen and always does. The old predicate was `pendingShadow != null` — a probabilistic sampling roll, and no basis for deciding what happens to someone's work. Under the new split the unpaired case stops being special.
- **Every isolated worktree replays the caller's uncommitted state.** `git worktree add` cuts a clean checkout of HEAD, so without it the executor solves a different problem and its diff then conflicts on work it never saw. Applied to `--isolate` too: a flag documented as "already the default" must not hand the executor a different tree.
- **`ignored_output: kept` now withholds the worktree as well as the pair.** A merge-back is built by `git add -A`, which respects `.gitignore`.
- **`--isolate` outside a git repository refuses** instead of silently running in your tree. Kernel isolation may still degrade — nobody asked for it — but only when it failed *before* the spawn, and only after acquiring the lease it then needs.
- **`shadow-apply --arm primary` refuses on a `clean` primary_merge.** A primary can now carry both a `diff_snapshot` and an applied merge, which could not previously coexist.

**`fadeno drive --parallel n` overlaps command members again**, by a different mechanism than it originally did. Each member runs in its own worktree and merges back at collection, so the concurrency is a fact rather than a claim — and the containment is real, where `write_access: false` was never enforced at all. Where git cannot cut a worktree, members serialize and the engine says so. An engine merge-back that is not `clean` fails the attempt (`merge_back_failed`) rather than merely stamping it, because the next step of a run reads the workspace; the diff artifact is durable and named on the receipt. An interrupted attempt's worktree is retained, not cleaned up — nothing merged it back, so it holds work that exists nowhere else.

### Fixed — four ways a resolve answered a question it could not answer (0.6.0-rc.49)

All four found by the blinded adversarial judge pass on pairs `49a1f92a` and `89536181`, then verified against `main` by measurement before being touched. They share a shape: a surface answering optimistically where it had no basis to answer at all.

- **`dial resolve` no longer recommends a dispatch the kernel forbids.** An `eligibility: forbidden` pairing returned `dispatchable: true` and the action "Dispatch it" — straight into the kernel's own refusal, which has no force branch. Write posture got this guard when the identical defect was found there; eligibility never did. Two of the kernel's four refusal predicates are knowable at resolve time and both are now folded in; `constraint_command` must execute a policy and `provider_distinctness` needs input provenance a resolver never sees, so no field on the resolve object can promise a dispatch will be accepted — and `lane`'s doc no longer claims otherwise.
- **A write posture nothing could check now says so.** `write_access:` is optional, and an undeclared value is `null`, which satisfies *every* posture — so a `requires_write: required` archetype dialed onto such a route passed in silence. It is reported, not refused: refusing would break every catalog that omits the key, and "we never asked" is not "no meaningful delivery exists". `explainUnverifiedWritePosture` warns at `fadeno dial` and at `fadeno dial shadow` (checking both arms, since the primary is the one usually sitting on an undeclared lane), the kernel stamps `write_posture_unverified: true`, and `fadeno bakeoff` raises it as a confound. The cost of the old silence was specific: an arm that could not write returns an empty diff, and judging reads that as *choosing* to change nothing.
- **The flag is TRUE-only, on purpose.** Its absence never asserts a lane was verified — a row written before the flag existed also lacks it. Inferring the confound from a missing `write_access` key instead would have over-claimed on every historical pair, since absence there means "undeclared" on a new row and "predates the field" on an old one.
- **`fadeno doctor` lints an archetype policy nothing dials.** A misspelled `archetypes:` key (`wroker:`) is invisible everywhere else: the posture attaches to an archetype nothing dispatches, and the real one silently has none, so a write-required task runs on a read-only lane and exits 0. It cannot be refused — an archetype with no declared posture is legal — so it is linted.

### Changed — a refused pair now says why, at every surface (0.6.0-rc.48)

- **Refusing a pair stays narrow, and stops being silent.** `explainPairRoutability` refuses a pair when the primary's command lane cannot satisfy the archetype's declared write posture. That refusal is right and is deliberately the only asymmetry that earns one: only the *primary* is moved onto its command lane, while the challenger resolves its own delivery and carries its own posture guard — so running the pair anyway would compare a crippled arm against an uncrippled one and measure the lanes rather than the models. An empty diff from an arm that could not write is not evidence about the model that produced it. What was wrong is that a step this serious happened in silence: a user attached a shadow, was told nothing, and simply never got pairs.
- **`fadeno dial shadow` warns at attach time.** `unroutablePrimaryNote` asked `commandRoutable` alone — "does a lane exist" — so it fired only for a host executor with no `fallback_command` and stayed mute for every write-posture refusal. It now answers with `explainPairRoutability`, the same predicate the resolve previews and the dispatch kernel use, which was the third copy of the question that helper exists to consolidate.
- **`shadow.routable_reason` travels beside `shadow.routable`** in both `dial resolve` and `steering resolve`. The predicate always computed the explanation; both surfaces spread `...routable` alone and dropped it on the floor. `pairRoutabilityFields` now publishes the pair, so the two cannot drift on whether the reason survives, and it is `null` exactly when `routable` is true.
- **The reason no longer offers `--force`.** `explainWriteConflict` takes `includeOverrideAdvice`, and pair context passes `false`: forcing lets the *primary* proceed and cannot make a pair form, so suggesting it there is advice that does nothing. A direct dial keeps the advice, where it is true — a test pins both halves. Reverting any of these fails `test/shadow-write-posture.test.ts`.
- **Fixed two comments that misdescribed the mechanism**, both pointing at `pairCommandFallback`, a symbol that no longer exists: a pair does not confine *both* arms to the primary's lane, only the primary.

*Found by the blinded adversarial judge pass on pair `49a1f92a`, then verified against `main` by measurement rather than by reading.*

### Added — `fadeno bakeoff --evidence explored` (0.6.0-rc.47)

- **The judge can read the code instead of a diff of it.** `--evidence explored` reconstructs each arm's post-work tree from its `baseline_commit` and `diff_snapshot` into `.fadeno/local/judge/<pair-id-8>/arm_a/` and `arm_b/`, writes each arm's diff beside it, and puts PATHS in the prompt. On this repo's pair `49a1f92a` the comparison prompt goes from 54,912 bytes to 10,823 while the judge gets strictly more to look at: a diff shows changed hunks and hides the file they landed in, so "does this fit the code around it?" — the question a reviewer most wants answered — is the one the old prompt structurally could not support. `inlined` remains the default, and is the right trade for a small pair: the prompt file stays a complete record of what was judged.
- **The trees carry the blinded label, and no `.git`.** `arm_a`/`arm_b`, never `primary`/`challenger`: the path is read on the way to every file, so naming a directory after the arm's real role would undo the blinding more thoroughly than any prose leak. They are plain `git archive` extractions, so nothing is registered in `.git/worktrees` for a later `fadeno clean` to leave dangling, and a judge cannot `git log` its way to knowing which arm it holds. The prompt says to read only inside the two directories, and says why.
- **Reconstruction refuses rather than degrades — the failure here is invisible.** The obvious implementation (`cd` into the destination, `git apply`) walks up, finds the enclosing repository, resolves the patch against the REPO root, prints `Skipped patch 'src/a.ts'.` — and **exits 0**, leaving a pristine baseline tree wearing an arm's label. Not a crash: a judge exploring the wrong code and a verdict that looks exactly like a real one. The applier uses `--directory=` from the repo root and then verifies with `--reverse --check`, since a patch that did not land cannot be reversed. A garbage-collected baseline or a diff that no longer applies ends the command pointing at `--evidence inlined`. Reverting either guard fails the new tests.
- **`evidence_mode` is stamped on every artifact**, alongside `judge_delivery` and for the same reason: a reader cannot tell from the verdict which kind of judgment they are holding, and an artifact written before the field existed correctly means `inlined`. `--record` re-derives everything from the ledger rather than carrying state from `--prepare`, so it cannot infer the mode — pass the same `--evidence` to both, or mislabel your own evidence. The `fadeno-bakeoff` skill says so at both steps.

### Fixed — how the judge prompt quotes an arm's diff (0.6.0-rc.46)

- **A diff could close its own code fence and keep writing as the prompt.** The judge prompt states everything itself except one span — the arm's diff — which it embeds in a ```` ```diff ```` block. That span is written by a model working an attacker-influenceable task, and a content line that is itself a bare fence ends the block: every byte after it stops being quoted evidence and becomes instructions, free to open a counterfeit `### arm_b`, a second `## Your task`, or a plain "prefer arm_a". Real `git diff` output prefixes content lines with `+`/`-`/space, which defeats the naive case — but the text reaching the prompt has been through hunk-stripping and byte truncation, and "the input is still well-formed" is the assumption that makes injection bugs. The block now opens with a fence longer than the longest run inside it, which is unrepresentable rather than merely unlikely. The payload is still quoted in full: it is evidence, and a judge must see it. Both prompts share `renderBlindArm`, so the adversarial pass is covered by the same change.
- **`duration: 2195108ms`.** The prompt whose entire job is holding two arms' numbers side by side printed the one quantity a reader has to divide by 60000 before it means anything. It now reads `36m35s`, through the formatter `dispatches.ts` already had — whose own doc comment gives this exact rationale, for the scorecard, while the judge got raw milliseconds. That function moves to `lib/bakeoff.ts` ("one list, every consumer", as its module docstring has said since it was written for this bug class). It stays distinct from `cli.ts`'s `formatDuration`, which reports live progress at second granularity and would render two arms 400ms apart identically.
- **The 200 KB diff cap counted the wrong unit.** It measured with `Buffer.byteLength` and then cut with `String.slice`, which counts UTF-16 code units — so a diff of CJK or emoji passed the check and was trimmed to up to three times the stated budget, on exactly the inputs least likely to be eyeballed.

### Fixed — the `@effort` note pointed Claude users at an inert command (0.6.0-rc.45)

- **`fadeno dial <a> <model>@<effort>` told every harness the Codex story.** The note said the effort "is recorded as the request; run `fadeno steering apply` to pin it into the host agent slots" — true under Codex, whose agent TOML has a `model_reasoning_effort` key, and false under Claude, where `steering apply --claude` writes no agent file at all: the identity grid was retired precisely because the Agent tool has no effort channel, so a pinned effort selects the *delivery lane* through `decideLane` rather than an identity. A Claude user pinning an effort was sent to a command that does nothing and told nothing about what their pin actually did. The note now branches on `hostEffortIsMaterializable`, which sits beside `RELAY_HARNESSES` in `executors.ts` and is pinned to observed behaviour by a test that runs both applies and reads the filesystem — a test that merely restated the predicate would have passed the whole time. `fadeno steering --help` carried the same stale claim and is corrected with it.
- **A pin that strands a write-required archetype now says so at set time.** Pinning a cheaper effort on a host dial moves the archetype onto its route's `fallback_command`, and on the shipped `claude→anthropic` route that lane is `write_access: false` and cannot be given a `write_variant`. `fadeno dial worker sonnet@medium` therefore leaves `worker` with no deliverable lane — previously discovered only when a dispatch was refused, several steps later. The dial that created the dead end is where it is reported.
- **The third case is named too.** A host route with no command lane at all (`current-host`, the base dial) has nowhere to divert to, so the pin is simply inert and the archetype runs in-session at the session's own effort. Silence there read as "recorded", which is what the old note claimed.

### Fixed — dispatch advice that the dispatch itself refuses (0.6.0-rc.44)

- **`dial resolve` told callers to run a command this same binary rejects.** Relaxing the delivery gate in rc.42 left `deliveryGuidance` asking only `commandRoutable(spec)` — does a lane *exist* — while the kernel additionally asks whether that lane can satisfy the archetype's write posture. The two answers part on a shape a user reaches by accident: pinning an effort the session cannot give (`fadeno dial worker sonnet@medium`) ejects a host dial onto its route's `fallback_command`, and that lane is `write_access: false` with no `write_variant` available, because a host route may not declare one. The resolution advertised `dispatchable: true` with `"Dispatch it: fadeno dispatch --archetype worker"`; running exactly that returned the `requires_write: required` refusal. Guidance now takes the kernel's own `explainWriteConflict` verdict — computed at the call site under the same `--force` guard `steering resolve` uses — and reports `dispatchable: false` with the refusal verbatim rather than a reworded near-copy that would drift again. A new end-to-end test asserts the advice and the kernel agree on both answers, by running both CLIs rather than the shared helper, since a unit test would pass even if the resolve path stopped calling it.

### Fixed — host-lane dispatch guidance, and `--via` on `dispatch` (0.6.0-rc.43)

- **A refusal that argued for the wrong remedy.** When `decideLane` has already chosen the host lane for an archetype — which it does for every unpinned dial in a Claude session — `fadeno dispatch` refusing on write posture told the caller the in-session agent was "NOT an equivalent substitute" and led with `fadeno dial <archetype> <model> --via <driver>`. That ordering is right for a genuinely command-lane archetype and backwards here: in-session is not a downgrade, it is the delivery the resolver chose and the one every spawn through the hook already gets. An agent following the advice re-dials a host-lane archetype onto an exec route and moves it out of the session permanently. Every refusal and the delivering path's echo now lead with the lane the resolver picked, name the in-session agent as that choice, and demote the escalation. The kernel still does not *route* on the lane, deliberately: `fadeno bakeoff` dispatches two judges, and a judge is host-lane under Claude with the default dial, so refusing host-lane archetypes outright would break a first-class caller.
- **`--via` on `fadeno dispatch` was parsed and dropped.** It was read only inside the `--model` branch, so `fadeno dispatch --archetype worker --via claude-exec` accepted the flag, ignored it, and delivered on the dial's own route — while `--help` advertised it as `(dial/dispatch)`. It now applies to the resolved dial, escalating a single call onto another driver without moving the dial. This is also the lever the new guidance points at, so a no-op would have made that advice unfollowable.


### Changed — the dial lane: `--via claude`, a `via` column, and one delivery gate (0.6.0-rc.42)

- **`fadeno dispatch` no longer refuses a host dial that has a command lane.** A host route with a `fallback_command` is dispatched down it under every harness. Until now a second predicate, `dispatchability(spec, harness)`, refused exactly that shape with `host_in_session` whenever the caller sat inside `claude`, on the theory that shelling out to `claude -p …` re-enters the dispatch one level down — while permitting the identically-shaped `codex exec …` fallback under `codex`, and while the catalog's own `anthropic-exec` route spawns that same subprocess on purpose. It was a coin-flip on which agent you happened to be running in, not a safety property, and `docs/extending.md` and `loadouts-and-dispatch.md` had documented the relaxed behaviour all along. On 2026-08-21 a coordinator hit the refusal, spawned an in-session subagent instead, and reported it as "equivalent role, no recursion" — under instructions to read the result back by dispatch id, which by then could not exist. `dispatchability` and `IN_SESSION_ONLY_HOST_HARNESSES` are gone; the relaxed predicate is literally `commandRoutable(spec)`, which already existed for the shadow-pair path, so the kernel, both resolve previews, and `explainPairRoutability` now share one function with no harness argument to branch on. The pair path's `pairCommandFallback` carve-out is gone with it — a pair no longer needs an exception to a rule that no longer exists.
- **What refuses instead is the honest refusal.** A host spec with no `fallback_command` (the `current-host` base dial) still has nothing to invoke. A lane that cannot satisfy the archetype's declared write posture is refused by `explainWriteConflict` — the guard the delivery gate was standing in front of and getting credit for — and that message now branches on the adapter: it no longer tells a host route to "declare a `write_variant`", a key host routes reject at parse, and instead names `fadeno dial <archetype> <model> --via <driver>` with the `*-exec` hint. A read-only `reviewer` or `judge` on a host route is not refused at all, which is the case the gate was costing.
- **Driver `claude-cli` is now `claude`.** Nobody dials a "cli", and the suffix made `--via claude-cli` look like a different tool from the `claude` on their PATH. Driver names and harness names share spellings on purpose and are not the same namespace — under `routes.codex.anthropic` the driver is `claude` and the harness is `codex` — which the catalog now says where the routes are declared. A stale `via: claude-cli` pin degrades to a stale-dial warning in `fadeno dial` and an `unknown driver` error that lists the declared aliases; re-dial with `--via claude`.
- **The dial and models tables head that column `via`, not `harness`.** It never held a harness: it holds the driver, the value `--via` sets, while `harness` in the same command's `--json` means the agent you are sitting inside — two meanings, one word, printed a column apart. `fadeno dial` now reads back the flag that set it (`--via claude-exec` → `via  claude-exec`), and the inherited-dial marker that printed `(via worker)` — an *archetype*, not a driver — prints `(inherits worker)`. In JSON the three synonyms for one value collapse to one: `EffectiveRow`/`DialSetResult` keep `driver` and drop `harness` and `delivery`; `ModelRow` keeps `driver` and renames `harness` → `home_via`, dropping `delivery`. **Breaking for `--json` consumers of `fadeno dial` and `fadeno models`.**
- **Two rename leftovers swept.** `fadeno --help` labelled six bakeoff flags `(compare)`, a command that no longer exists, and `loadouts-and-dispatch.md` still pointed `fadeno dispatches --bakeoffs` at `.fadeno/comparisons/*.md` (`kind: ModelComparison`). The roadmap still listed the deleted `model-tryout` starter as shipping.


### Fixed — locked host dispatches for `reviewer` and `judge` (0.6.0-rc.41)

- **`steering resolve` refused every locked host dispatch whose archetype has default posture.** `archetypes:` in a catalog is a *policy overlay* — an archetype earns an entry only by having something non-default to say — so the builtin declares `worker`, `director` and `generator` and stays silent about `reviewer` and `judge`. The locked resolver read that map as the set of archetypes that exist and rejected them as "undeclared archetype", pushing a managed Codex reviewer or judge agent that correctly consulted steering onto the command lane with `host_attested: false` and `identity_evidence: command_receipt`. The check is now wildcard-only (a concrete `agent_type` is already settled by the equality check preceding it) and asks `knownArchetypes()` — the role triad plus every declared or dialed name — which `dial.ts` had open-coded twice with the triad hardcoded. The refusal message now says "unknown archetype", since an undeclared one is legitimate and `fallback:` to one has always been allowed.


### Added — symmetric shadow pairs, trustworthy isolation, and measured host identity (0.6.0-rc.34)

- **A pair's arms are now actually comparable.** `commandRoutable()` is one predicate shared by `dial resolve`, `steering resolve`, and the kernel's `pairCommandFallback`, so a selected pair whose primary has no command lane degrades to no pair instead of routing a spawn the kernel then refuses (which failed the task outright). Each challenger worktree receives the primary's pre-spawn state as a committed `baseline_commit` shared by both arms, captured without touching the primary's index. `worktree_carry:` (project-scope, parse-validated) carries declared gitignored build state by reflink → hardlink → full copy — never a directory symlink, which shares the namespace and lets even a rename-based write land in the primary's real files — recording the mechanism per path, and applies to `--isolate` as well as shadows. A prompt naming absolute repo paths refuses the pair (`shadow_containment`), because byte-identical prompts plus differing cwd would otherwise send the challenger into the primary's workspace. `shadow_baseline`, `shadow_carry`, and `shadow_containment` all write refusal rows and leave the primary untouched.
- **Pair-aware steering on every harness.** `fadeno steering resolve` gains `--prompt-file`/`--prompt-sha256` and answers `shadow.selected`/`shadow.routable`, routing a selected routable pair to the command lane exactly as the Claude hook does; host-spawn shadowing is no longer Claude-only. All three Codex agent surfaces write the prompt file before resolving, since the resolver must see the bytes to answer at all. Fixes Codex bootstrap agents that instructed `--host-executor native-worker`, a name that has not existed since dials replaced named executors, and that therefore dead-stopped on every ordinary task.
- **`fadeno shadow-apply <pair-id|dispatch-id> [--arm challenger|primary] [--check]`.** Conflict-aware port-back via `git apply --3way`; stops and keeps the diff artifact rather than auto-resolving. `--check` parses git's message text because `git apply --check --3way` exits 0 on a patch that would conflict.
- **`fadeno attest --archetype <a>`.** Run from inside a subagent, it measures the one identity component that is observable — `CLAUDE_EFFORT`, already resolved past any silent downgrade — and records `identity_evidence: requested_only` for the model rather than asking a model to name itself. `fadeno dispatches` renders both an unattested host delivery and an effort that disagrees with its dial.
- **The reader now reads what the ledger writes.** `pair_id`, `workspace`, and `baseline_commit` parse into `DispatchEntry`; the comparison view reports the primary's own diff, pairs on `pair_id`, and renders a refused challenger as refused rather than as a row of `?`. `fadeno clean` deregisters retained shadow worktrees before deleting them instead of orphaning their git registrations. `fadeno doctor` reports legacy per-dial managed agents that silently override their dial.

### Added — repo-wide writer leasing, harness heartbeat, isolated delivery, and reference-frame-neutral current-host (0.6.0-rc.33)

- **Repo-wide writer lease (`.fadeno/local/workspace-lease.json`).** Machine-local, never ledger evidence, `workspace_mode` is `shared` or `isolated`. A live `shared` writer blocks every other shared write-capable `fadeno dispatch`, `fadeno drive`, and host dispatch, including peers in the same run (read-only and `isolated` deliveries bypass). Logical host fan-out is serialized until each writer records its terminal receipt; legacy multi-holder records remain readable and require exact-member release. The record carries `supervisor_pid`, `executor_pid`, `process_group_id`, `started_at`, `heartbeat_at`, `last_output_at`, `stdout_bytes`, `stderr_bytes`, and `workspace_mode`. Stale leases with a dead supervisor pid are reclaimable; PID-less host reservations remain conservatively live until `dispatch-complete` or `dispatch-fail`, so optional progress observations never weaken exclusivity. If the run ledger itself cannot record a terminal recovery, the documented last-resort escape hatch is `rm .fadeno/local/workspace-lease.json` after verifying no writer remains.

- **`fadeno dispatch --isolate` (opt-in detached worktree delivery).** Executes in a worktree cut from `HEAD` before the primary runs (`git worktree add --detach .fadeno/local/isolated/<id>`), preserves a binary-safe diff artifact at `.fadeno/local/outputs/isolated-<id>.diff` (`diff_snapshot`/`diff_bytes` in evidence, does not merge automatically, `workspace_changed` omitted), and bypasses the shared-writer lease because it cannot mutate the shared worktree. Conflicts with `--shadow` (refused).

- **`fadeno dispatch-prompt <run> <dispatch-id>` (canonical envelope).** Emits the exact `# Fadeno engine step assignment` envelope with immutable `run`/`dispatch_id` and the recorded prompt bytes, sha256-authenticated with traversal/symlink guards. Replaces manual envelope reconstruction in the driver skill; `README.md` now sells it as the canonical path.

- **Engine-first `fadeno new-run` guidance.** Output now recommends `fadeno drive <run>` first (`Advance it with fadeno drive first (engine):`) with the literal `first`, then the manual `fadeno next`/`fadeno run` fallback. Same ordering is documented in `src/cli.ts` help.

- **`fadeno dispatch-complete --output -` (stdin host completion).** Reads artifact bytes from stdin (`readFileSync(0)`, binary-safe, test seam `stdinBytes`) and uses the same validation, atomic `artifacts/attempts` vs `outputPath` placement, manifest, and receipt path as a temporary file.

- **Structured wildcard specialization (`requested_agent_type` / `delivered_archetype`).** Locked steering (`--run --dispatch-id`) for `agent_type: "*"` now reports `requested_agent_type: "*"` and `delivered_archetype: <concrete>` (the concrete archetype being delivered) without upgrading `identity_evidence` beyond `requested_only`. Because the host agent is already assigned, that wildcard claim may specialize to a declared compatible archetype such as `director` without requiring a second materialized host-agent surface; concrete requests retain the ordinary surface check. `fadeno steering resolve --json`, the committed plugin bundle, and `src/commands/steering.ts` carry the behavior; host start receipts remain `requested_only`.

- **`fadeno show` harness-observed process facts.** `fadeno show` now labels machine-local process facts as `harness-observed` and semantic progress as `agent|harness|director-attested`, both `gating: non-gating` (never controls gates). `src/lib/supervisor.ts` is the sole atomic claim writer after startup: it heartbeats `heartbeat_at`, forwards exact output buffers, and updates byte/activity counters. `src/commands/show.ts` projects the repo-wide lease (including every member of a legacy record), per-dispatch inflight claims, and terminal supervisor status.

- **`fadeno cancel <run>` — safe engine-attempt cancellation.** Targets the single correlated live engine command claim for the resolved run (`engine-<runId>-<actorCallId>-a<attempt>.json`), sends `SIGTERM` to the supervisor PID, or the negative executor process-group ID when the supervisor is proven dead (`ESRCH`), or the executor PID as final fallback. Never writes the run ledger — the active engine remains the sole ledger writer and records the terminal `actor_failed` receipt. Refuses with a clear `CancelError` when there are zero or multiple live correlated claims rather than guessing. Preserves the workspace lease and inflight claim until child-group termination is proven (`close`), never at signal-send time. Returns `{run, actorCallId, attempt, supervisorPid, processGroupId, signalledPid, resolvedBy: "supervisor" | "process_group" | "executor"}`. CLI rendering reports `resolved_by` and the reaped group. See `src/commands/cancel.ts`, `src/cli.ts` `COMMAND_HELP['cancel']`.

- **Supervisor-owned executor hard deadlines with TERM→KILL escalation.** Route YAML key `timeout_ms` (positive integer milliseconds, absent by default) is parsed at both catalog and snapshot trust boundaries and rejected on `host: true` routes. The committed built-in command routes set `timeout_ms: 1200000` (20 minutes). The supervisor owns the deadline: at `deadline_at = started_at + timeout_ms` it sends `SIGTERM` to the executor process group and escalates to `SIGKILL` after the existing 5-second grace (`KILL_GRACE_MS`). Lease and claim release still waits for `close`, so cancellation and timeout are similarly proven only after the group is gone. CLI override `--timeout <seconds>` on `fadeno drive` and `fadeno dispatch` (internal `timeoutMs`) overrides the snapshotted route value; `0` disables the route deadline; empty or non-integer values are rejected. New status fields `timed_out: boolean`, `timeout_ms: number | null`, `deadline_at: string | null` are always reported; `readSupervisorStatus` coerces missing/invalid to `false`/`null`.

- **Distinct timeout receipts.** `actor_failed.reason = "executor_timeout"` with `timeout_ms` and `deadline_at` (plus preserved `signal`/`exit_code` facts) is distinct from `engine_interrupted`, `exit_nonzero`, and ordinary signals. Ad-hoc evidence `dispatch_completed.outcome = "timeout"` carries the same `timeout_ms`/`deadline_at`. Status-file timeout facts (`timed_out`) outrank the supervisor process exit signal when classifying a receipt; wall-time is never inferred. Re-running drive may retry with `user_retry`.

- **Non-gating idle-output warnings in `fadeno show`.** `OUTPUT_IDLE_WARNING_MS = 300000` (five minutes). `HarnessObservedProcessView.outputIdleWarning` becomes true when a process is `alive` and has emitted no output for five minutes (since start when `last_output_at` is null, else since `last_output_at`). `src/cli.ts` renders `WARNING: no output observed for <duration> (non-gating)` per harness-observed fact (`outputAgeMs ?? runtimeMs`). Idle warnings never signal, gate, or alter deadlines — output silence alone never terminates work.

- **Adversarial process-group and ledger-verification coverage.** New and extended tests verify supervisor `SIGTERM`→`SIGKILL` escalation, lease/claim preserved until `close`, process-group `kill(-pgid)` determinism, wall-time not inferred for timeout, and output-silence-never-kills. See `test/supervisor-timeout.test.ts`, `test/cancel.test.ts`, `test/show-timeout-observability.test.ts`, and the new `test/cancel-timeout-integration.test.ts`.

- **Reference-frame-neutral `current-host` locked steering.** An immutable host request with `executor: current-host` and `agent_type: "*"` is already assigned to a concrete host agent; `fadeno steering resolve --archetype <concrete> --run <run> --dispatch-id <id>` now resolves `mode: host` even when the caller has no `--host-executor` marker. Reports `requested_agent_type: "*"`, `delivered_archetype`, and `identity_evidence: requested_only` (never upgraded), retains declared-archetype/`eligibilityFor === 'forbidden'`/`explainWriteConflict`/`requested_identity`/terminal-receipt checks via `decorateSteering(..., requestedAgentType === '*')`. Exports `NEUTRAL_HOST_EXECUTOR = 'current-host'` and `isReferenceFrameNeutralHostRequest(request, spec)` (true iff `request.executor === 'current-host' && request.agentType === '*' && spec.adapter === 'host' && spec.agentType === '*' && spec.model === 'current-host'`), mode line `matchesHost || neutral ? 'host' : hasFallback ? 'command' : 'restart_required'`, new detail string `host request <id> is locked to the reference-frame-neutral executor current-host; execute in-host` only on `!matchesHost && neutral`. Concrete host executors (`luna`/`opus`…) and concrete `agent_type` values remain strict.

- **Opt-in isolated host workspace (`fadeno dispatch-prepare --isolate`).** Pre-spawn for a pending nonterminal host request that has not started: creates an idempotent detached worktree from `HEAD` at `.fadeno/local/host-worktrees/<run>/<dispatch-id>` (guarded against traversal/symlink escape), atomically records `workspace_mode: isolated` state at `.fadeno/local/host-workspaces/<run>/<dispatch-id>.json` (`schema_version: 1.0`, `run`, `dispatch_id`, `workspace` repo-relative, `base_commit` 40-hex, `prepared_at` ISO, plus `diff_snapshot`/`diff_bytes`/`finalized_at` after collection), serialized by `.fadeno/local/.host-workspace.lock` (`WORKSPACE_LEASE_LOCK_STALE_MS`). `dispatch-prompt` then includes `workspace_mode: isolated` plus absolute workspace path and instruction `All repository reads and writes for this assignment must occur in the workspace above; do not read or modify the shared checkout.` (prompt bytes and `prompt_sha256` unchanged, header not hashed, not ledger-written). `dispatch-start` discovers prepared state, stamps `workspace_mode: isolated`/`workspace`/`base_commit` on `actor_dispatched`, enforces `--workspace` match and rejects `command-fallback` with prepared isolated workspace, bypasses shared writer lease (read-only `writeAccess === false` also bypasses), and checks idempotent re-start `workspace_mode` equality; `dispatch-complete`/`dispatch-fail` collect a binary staged diff (`git add -A` → `git diff --binary --cached`) atomically at `.fadeno/local/outputs/host-isolated-<run>-<dispatch-id>.diff` before the terminal receipt, stamp `workspace_mode`/`workspace`/`base_commit` plus `diff_snapshot`/`diff_bytes` only when a diff was actually collected from the proven registered worktree, proving the worktree is the registered linked worktree before any `git add`/`diff` or removal. The worktree is removed only after durable append and only when proven registered (idempotent terminals reuse receipt and retry cleanup only when verified). `dispatch-fail` degrades to a terminal receipt without diff keys whenever the isolated evidence is absent, unverifiable, or unrecoverable — including a missing or malformed machine-local state file — and records `diff_snapshot`/`diff_bytes` only when a diff was actually collected from the proven registered worktree; a collection failure while the machine-local state is present still refuses, preserving the worktree for retry; `dispatch-complete` may recover and collect from a verified ledger-named worktree when the state file vanished, but still refuses success when evidence cannot be collected. Neither command stages or removes a directory it has not proven to be this dispatch's registered worktree, and nothing is ever auto-merged. `HostRequestView` on `fadeno show` projects ledger-first `workspaceMode`/`workspace`/`baseCommit`/`diffSnapshot`/`diffBytes` (prepared-but-not-started degrades to isolated via machine-local read, missing state → `shared`/null, never throws, non-gating); `verify` never requires machine-local state.

### Changed — dials replace named loadout presets (0.6.0, `docs/experimental/dials-and-registry.md`)

- **Named loadouts retired; per-archetype dials via a layered cascade.** `loadouts:`,
  `default_loadout:`, `targets:`, `--loadout` / `FADENO_LOADOUT`, `fadeno use`,
  `fadeno targets`, and the `targets` concept are removed. Catalogs now carry
  `schema_version: 3` with a uniform `models:` registry (`provider` + `id` +
  standard `effort`, `spellings:` per driver) and `routes:` rows gain `driver:`,
  `models_command:`, and `effort_encoding:`. The selection surface is
  `fadeno dial <archetype> <model>[@effort] [--via <driver>] [--user|--repo]`
  / `clear` / `shadow` / `clear-shadow` / `resolve` (verb-first; `fadeno loadout` removed) and the effective table `fadeno dial` (no args) with
  `dial_source` / `resolved_via` per row. The cascade is
  `binding → session dial → repo pin → user dial → base` (`base` = `current-host`,
  now a built-in dialable model). Unregistered model ids route via
  `unregistered_model_driver` (default `opencode`) with dial-time backend
  verification (`models_command` probe, positives cached in
  `$FADENO_STATE_HOME/model-verifications.json`, fail-open). Dispatch rows are
  format `1.0` with re-spelled identity fields
  (`model`/`model_id`/`effort`/`driver`/`dial`/`dial_source`); `0.2` rows
  remain readable as `[legacy]`. Old pins (`.fadeno/local/loadout` with
  `{loadout,…}`) are ignored with a one-line note ("pre-0.6 loadout pin
  ignored — re-dial with `fadeno dial worker <model>`"); v2 catalogs error with a
  migration note. **Breaking (post-0.6 hardening, no compat):** v3-only catalogs (`schema_version 3` required) and `snapshot_version: 3` snapshots — `fadeno verify` refuses pre-dials ledgers with `pre-dials run snapshot — this fadeno verifies snapshot_version 3 ledgers only; verify with fadeno <= 0.6.0-rc.27`; `fadeno dial` is verb-first and `--executor` is removed; pin is `.fadeno/local/dials`; driver aliases are `openai→codex`, `anthropic→claude`, `xai→grok` (plus `google→agy`, `openrouter→opencode`); `ConstraintContext.transport` is now `host`. The dispatches reader still renders legacy rows as history.

- **Deterministic `tool_call` execution (`fadeno tool-run` + shared core).** Strict `tools:` registry in `.fadeno/executors.yaml` (static argv, `timeout`/`timeout_ms`, layered and snapshotted), `fadeno tool-run <run> [--tool <name>] [--timeout <seconds>]` as a thin `tool-exec` adapter (registered `test-result` only; `Diff`/`PostResult` remain manual via `tool-complete`), `fadeno drive` auto-executes registered tools inline. Core in `src/lib/tool-exec.ts`: `readdirSync` live-claim scan (ESM `require` fixed, narrow `ENOENT` vs hard error), post-claim ledger re-read to close stale-attempt sequential double-execution, **exclusive attempt ownership from pre-spawn admission to terminal receipt** — a pid-less pre-spawn lease reservation (like the engine and host paths, so a kernel that dies before the supervisor publishes executor/group identity cannot fail the record open), an `owner_pid` on the in-flight claim, and a supervisor that hands claim *and* lease back to a live polling owner at child close instead of dropping them before synthesis, placement and attribution (it still releases both itself the moment that owner is gone); recovery leaves any live attempt entirely alone, so locked admission is the single authority that refuses one; placement + validation + `artifact_created` + `tool_completed` run in one re-entrant run-lock critical section, and a terminal receipt that already exists parks its attempt's evidence instead of writing a second one; generation-scoped `step_started` after the claim and lease refusals and before `tool_dispatched` (corrupt ledger aborts, never defaults `attempt 1`), `tool_dispatched` appended by the canonical `LedgerWriter` (legacy-ledger gate kept, admission still one atomic check-then-append), exclusive `linkSync` placement (never clobbering `rename`) preserving winner bytes when a manual attribution races the helper, `toolGenerationFromStep` and deliberation comments removed, final-object validation (validated bytes == placed bytes, `details_path` either attested via `artifact_created` or not exposed), and crash-safe attribution preserving an already-`artifact_created` file when `tool_completed` fails. Shared audited recovery `recoverInterruptedToolDispatchesShared` for both `drive` and helper (engine + tool holders, `workspace_lease_recovered`/`reclaim_denied` auditing). `fadeno show` and `fadeno cancel` now include `tool-*` claims with run-scoped visibility and `ESRCH` process-group cancellation. CLI `--timeout` overrides registry, `--timeout 0` disables, bounded `summary` (4000 B) / `details` (32 KiB) / `SPAWN_MAX_BUFFER` (32 MiB) / `stderr` tail (400 B) truncation preserving observed `exit 0`/`failed`/`error` semantics. New `tool-result-coherence`, `tool-command-digest`, and `tool-lifecycle` verify checks; binding-mismatch test reaches binding comparison (not just snapshot-digest). Docs: `roadmap` shipped CLI/executable primitives, `architecture` command/library table, `extending` tool-binding recipe, `CHANGELOG`, and `docs-claims` tripwires for `tool-run`, `tools:`, tool lifecycle events, and verify check names. Tests are hermetic with real `TestContext` cleanup.

- **`run.yaml` is published atomically, and opening a generation is a locked decision.** Every writer reads `run.yaml` to gate on `schema_version`, so rewriting it in place was observable mid-truncation: a concurrent helper could read the empty prefix and refuse a current ledger as `is a legacy ledger (run.yaml has no schema_version)`, or parse it as null and die setting `current_step`. `writeRunDocument` (`src/lib/run-ledger-write.ts`) now serializes to a sibling temp file and places it by `rename`, so every reader sees the whole previous document or the whole next one; `fadeno new-run` and `fadeno run` share it, and the modeline lives in one place. `withRunLock` is re-entrant within a process (everything under it is synchronous, so a nested acquisition is the same call stack), which lets `ensureStepStarted` make the scope decision *and* append inside the same critical section admission uses — two helpers racing one generation now produce exactly one `step_started`, not two shifted invocation numbers.

- **Route write variants: capability picked by archetype policy, not model
  spelling.** A route declared `write_access: false` may declare
  `write_variant: { command: [...], resume?: [...] }` — an alternative argv
  that can write (e.g. headless claude with `--permission-mode acceptEdits`).
  A `requires_write: required` archetype resolving onto the route gets the
  variant automatically at every delivery boundary (dispatch, drive,
  steering, dial show/resolve); every other posture gets the read-only base.
  `fadeno dial worker opus` now works against a read-only anthropic route
  with a declared variant, while reviewer/judge dials of the same model stay
  physically read-only. The compiled variant travels in the run snapshot
  (replays posture identically), evidence rows gain `write_variant: true`,
  and the reader marks `[write variant]`. Command-delivery only: `host: true`
  routes refuse the key at parse (in-session permissions are the host's; the
  locked fallback lane replays the snapshotted base argv). Also parse errors:
  `write_variant` on a route that is not `write_access: false`, a variant argv
  identical to the base, and variant session fields that would violate the
  `resume ⟺ id source` invariant after posturing. New `director` archetype
  (canon starter catalog, `requires_write: required`): high-level
  planning/orchestration handed to a usually-cheaper model that coordinates
  workers/reviewers itself via the fadeno CLI. Its claude lane is the new
  `anthropic-exec` route (`--via claude-exec`, declared in every harness
  family): a command delivery for claude models whose write variant grants
  `--permission-mode acceptEdits` plus a scoped `--allowedTools
  "Bash(fadeno:*)"` — can edit and run fadeno, nothing wider. Under the
  claude harness this is also the first command lane for claude models at
  all (the plain route is in-session), so an expensive host session can
  dispatch a whole side task to a cheaper headless claude:
  `fadeno dial director opus --via claude-exec`. New `fadeno models`
  inspection surface (closes design open question 3): the registry table
  under the active harness with per-row delivery, `+write`/`+fadeno` lane
  marks, and the dial-time probe cache as a `verified` column;
  `fadeno models <name>` adds `--via` lanes, spellings, and eligibility;
  `fadeno models --driver <alias>` runs the route's `models_command` for a
  live backend listing with registered spellings marked. Director packaging:
  archetypes may declare `brief: <name>` — a template
  (`.fadeno/briefs/<name>.md`, falling back to the builtin) composed ahead of
  every ad-hoc dispatch of that archetype, recorded as `brief` in evidence
  with the digest attesting the composed bytes (`--no-brief` opts out); the
  starter director declares `brief: director`, whose builtin template
  teaches the spawned model to coordinate through fadeno instead of doing
  the work itself. Routes gained per-archetype `eligibility:` (merged with
  model eligibility, strictest wins) — the structural spelling of "this lane
  cannot host a director": grok/agy/opencode routes, plan routes, and the
  non-fadeno-granted claude lanes declare `eligibility: { director:
  forbidden }`, which also binds unregistered models falling through them. A
  new `fadeno:dispatch-director` proxy agent hands a whole side task to the
  dialed director, and the Claude steering hook routes `director`-named
  spawns like the triad. Effort is the model's property everywhere ("host
  delivery inherits effort" retired): `@effort` dials on host deliveries are
  no longer refused (the pin travels on the request, with a note), the dial
  table and steering resolve show the real effort instead of
  `inherit`/`inherited`, and `fadeno steering apply --claude` materializes
  host-dialed slots as local Claude subagents
  (`.claude/agents/<archetype>.md` with `model:` + `effort:` frontmatter) so
  an in-session model runs at its own effort rather than the session's —
  the symmetric of the codex TOML materialization, with managed-file
  markers, stale-slot removal, and unmanaged files preserved. Starter
  registry retuned: luna/terra/opus/sonnet/grok to xhigh standard, gemini →
  `gemini-3.7-flash` @ xhigh, and `muse` registered (routeless builtin — the
  name resolves everywhere, delivers only where a catalog declares its
  route). Muse Code is now a first-class driver (`muse-code`, all harness
  families, verified live): Muse reads prompts only from a regular file
  (/dev/stdin, bare stdin, and `-` all refused), so routes gained a
  `{prompt_file}` argv placeholder — substituted at spawn with the kernel's
  attested prompt-snapshot path (dispatch primary + shadow, drive actors,
  and the locked host fallback), so the digest attests exactly the bytes the
  executor reads; evidence records the substituted argv. Also fixed: a
  briefed `--prompt-file` dispatch now snapshots the composed bytes it
  actually sends, not the caller's original file. Archetype listings
  (`fadeno dial` table, status roles) follow the canon power order —
  director, judge, reviewer, generator, worker — with non-canon archetypes
  alphabetical after. Generator is a standalone archetype: its `fallback:
  worker` is gone, so undialed it resolves to the host-native base like any
  other (the fallback mechanism itself remains for custom archetypes). Plain
  `fadeno dial clear` (no archetype) now wipes ALL session and user dials —
  narrated per layer — leaving committed repo pins standing with a pointer
  to `clear <archetype> --repo`. Multi-archetype set: `fadeno dial` accepts
  several archetypes for one model — space, `+`, or `,` separated
  (`dial judge reviewer sol`, `dial worker+generator muse`,
  `dial worker,reviewer grok`) — validated atomically: one refused archetype
  refuses the whole command and nothing is written. Per-subcommand
  help: `fadeno <command> --help` now prints focused usage for the major
  commands. `fadeno dial clear <archetype>` now follows the dial when the
  layer is unambiguous: with no session dial and no repo pin it clears the
  user default (narrated `[user default — the only layer holding a dial]`)
  instead of demanding a retype with `--user`; a repo pin still blocks the
  inference (committed config, explicit `--repo` only).

- **Shadows run concurrently with their primary.** The challenger is now
  resolved, rate-rolled, worktree-cut, and spawned *before* the primary runs,
  and collected after the primary's completion row is written — previously the
  entire shadow flow ran only after the primary finished, purely as an
  artifact of the kernel's synchronous spawn chain. Three consequences, all
  deliberate: dispatch latency with a live shadow is max(primary, shadow)
  instead of their sum; the worktree is cut from HEAD before the primary can
  move it, so both sides start from identical committed state (a primary that
  commits can no longer contaminate the comparison); and each side's
  `duration_ms` is its own runtime — measured by its supervisor at exit, never
  by when the blocked kernel got around to collecting — so time-to-complete is
  itself comparison evidence, and `fadeno dispatches --comparisons` now prints
  it per side (`exit 0 in 183ms … vs … exit 0 in 1.3s`). Mechanically, the
  shadow runs under its own supervisor (same reaping guarantees as the
  primary; a killed kernel orphans neither side) with a new third supervisor
  argv slot naming a status file the supervisor writes atomically at exit
  (`exit_code`/`signal`/`spawn_failed`/`duration_ms`) — the kernel's event
  loop never turns while either side runs, so the exit report must be a file
  it can poll for, with a zombie-aware liveness probe so a reportless
  supervisor death cannot hang the kernel. The prompt reaches the shadow as an
  fd on the attested snapshot (the kernel can pump no stdin while blocked in
  the primary's spawn), and the shadow now publishes an in-flight claim, so a
  long-running challenger is cancellable by its own id. Ledger order becomes
  request-before-spawn on both sides — `pReq, sReq, pComp, sComp` — and
  `completed − requested == duration_ms` still holds per side. Unchanged: a
  refused primary fires no shadow, a shadow failure can never affect the
  primary's result, and shadow refusal rows keep their predicates.

The engine slices of the next protocol (capabilities 1, 2, 4 + 5 of
`docs/experimental/next-protocol.md`, plus the explicit supersede event and
native host dispatch): Fadeno gains a small deterministic, repo-local engine.
Native dispatch advances the run ledger to format 0.3; format 0.2 and
unversioned traces remain explicitly readable through `--legacy`, while
writers accept only 0.3.

### Added — bounded command-member waves (`fadeno drive --parallel`)

- **`fadeno drive --parallel <n>` (1–16, default 1).** Classic `map` steps with
  command-delivered actor calls now run eligible members concurrently within one
  ready wave: read-only deliveries (`writeAccess === false`) may run up to the
  cap, shared write-capable deliveries are serialized at most one live member
  via the existing repo-wide workspace lease (a foreign live lease still hard-
  refuses). Admission, dispatch, and receipt are deterministic: dispatch rows in
  canonical member order, per-member artifact/completion or failure receipts in
  canonical member order independent of wall-clock, with actual supervisor
  `duration_ms`/`ended_at` preserved as evidence and `actor_failed` reason
  `supervisor_lost` when a supervisor dies without a status report. The drive
  process remains the sole lifecycle-row author (`LedgerWriter` per-run mkdir
  lock) and `begin`/`collect` are split across `src/lib/supervisor.ts`
  (`superviseArgv`, `sleepSync`, `supervisorCanStillReport` hoisted and reused).
  `dispatchOnce` stays as the serial `begin+collect` wrapper so `--parallel 1`
  is bit-identical except for output arriving via snapshot file. The output-size
  boundary is enforced at collection by `statSync(...).size > 32 MiB` before any
  whole-file read; a runaway executor is recorded as `output_too_large` rather
  than an empty-output repair, a snapshot that cannot be stat'ed or read is
  recorded as `output_unreadable`, and an over-cap stderr snapshot is read only
  as its trailing `stderr_tail` bytes so runaway stderr cannot exhaust the
  drive process. Mixed host/command maps interleave durable host
  requests and command receipts in canonical order; unresolved host requests
  still block terminal state. Compositional command leaves remain an explicit
  documented deferral (shared-role `latestSessionForRole` leakage and frontier
  ambiguity, see `docs/experimental/compositional-runtime.md`). `fadeno cancel
  --actor-call <id>` disambiguates when multiple command claims are live.

### Fixed

- **Exceptional primary failures no longer leak shadow worktrees.** Concurrent
  shadow collection is attempted exactly once from the primary lifecycle's
  `finally`, and detached-worktree removal is itself guaranteed by the shadow
  collector's `finally`. A failure while persisting the primary or shadow
  completion receipt can no longer leave `.fadeno/local/shadow/<id>` on disk
  or registered with Git.

- **Lease-lock staleness is consistent across process boundaries.** The
  embedded executor supervisor and the in-process workspace-lease helper now
  share the same 120-second stale-lock threshold instead of pruning at 30 and
  120 seconds respectively.

- **Host handoff completion is ledger-aware.** Bash completion now suggests
  only nonterminal host dispatch IDs from the preceding run for
  `dispatch-prompt`, `dispatch-start`, `dispatch-progress`,
  `dispatch-complete`, `dispatch-fail`, and `dispatch-fallback`; completion
  for `dispatch-complete --output` also offers `-` for stdin.

- **`dispatches --output last` could hand a caller the challenger's report.**
  Shadow request rows carry `output_snapshot` like any other, so after a
  shadowed dispatch the newest snapshot-bearing request row *was* the shadow —
  `last` resolved to it and returned the challenger's output as if it were the
  caller's own. Latent under the sequential design (nothing exercised it);
  under concurrent shadows it would have flipped to the opposite failure,
  refusing every shadowed dispatch as "ran concurrently". Shadow records are
  now excluded from `last` candidacy, the open-dispatch set, and the
  concurrency refusal — the caller launched the primary, the kernel launched
  the shadow, and a shadow overlaps its own primary by design. Explicit
  recovery and cancel by shadow id still work.

- **A shadow could edit the workspace it exists to protect, and the ledger said
  it hadn't.** `spawnSync({ cwd })` chdirs the child but leaves the inherited
  `PWD` pointing at the parent's directory, and a shell always rewrites `PWD`
  when it cds. A tool that resolves its project root from `$PWD` rather than
  `getcwd()` therefore operated on the *main workspace* instead of the isolated
  worktree it was launched in. OpenCode does exactly this: a shadow told to
  append a line appended it to the real `README.md`, while the untouched
  worktree yielded `diff_bytes: 0`. Both halves are bad — the write landed on
  the tree shadow promises never to touch, and the evidence recorded a clean
  run, so nothing surfaced it.

  Fadeno's isolation was otherwise correct (`git worktree add --detach`,
  `cwd` set, diff taken from the worktree), which is why this survived: an
  instrumented probe spawned the same way reported the right `cwd` and wrote to
  the right tree. Only executors that trust `PWD` escaped, and whether a given
  driver does is not something Fadeno can know per driver — so `atCwd` now sets
  `PWD` alongside `cwd` at every spawn site that sets one: the primary
  executor, the shadow, the host fallback command, the drive engine's executor,
  and user constraint commands.

- **The dispatch proxy no longer relies on instinct for two behaviours it was
  already getting right.** A 2026-08-14 dogfood watched a proxy refuse to fold
  a mid-flight amendment into a live dispatch, and separately watched it relay
  an executor's claims while stating plainly that it had not verified them.
  Both were the correct call. Neither was specified.

  *Amendments.* The contract said nothing about the task changing after the
  dispatch launched; the nearest rule warned against re-dispatching, and only
  on the timeout path. The proxy generalised it correctly on its own, which is
  exactly the kind of behaviour that regresses silently on a model swap or a
  body regeneration — and whose failure mode is the expensive one, two
  executors racing on the same files. Now a step of its own: report the
  discrepancy, name what was dispatched against what the amendment asks, and
  leave the decision to the caller.

  *Non-verification.* A proxy holds one permitted command and never sees the
  repo, so it structurally cannot confirm that a change an executor describes
  actually landed — and relaying the claim bare reads as the proxy vouching
  for it. Saying so was previously forbidden by the same step that requires
  verbatim relay ("do not summarize, trim, reformat, or annotate it"), so the
  proxy was doing the right thing *against* its own contract. A single framing
  line is now carved out explicitly, and may never sit inside the report or
  replace any part of it.

  Both rules are pinned by tests and applied identically to the worker,
  reviewer, and judge proxies.

### Added

- **`fadeno dispatches --cancel <id|tag:handle>`** — stop a running dispatch.

  A 2026-08-14 dogfood named the gap: a proxy correctly declines to fold a
  mid-flight amendment into a live dispatch, because a second executor would
  race the first on the same files — but nothing could *stop* the first either.
  A corrected instruction was therefore not applicable, not safely
  re-dispatchable, and not abortable. With roughly half of dispatches
  outliving the caller's 600s window, that is the ordinary case rather than the
  corner.

  Delivering the amendment to a running executor is impossible and is not
  attempted: every driver is a one-shot CLI whose stdin closed when the prompt
  was written. Cancel makes the honest path — abort, then re-dispatch with the
  corrected prompt — deterministic instead of a race.

  The supervisor publishes `{pid, started_at}` to
  `.fadeno/local/inflight/<dispatchId>.json` and unlinks it on exit. It has to
  be the supervisor: `spawnSync` hands the kernel a pid only once the spawn has
  finished, so while an executor runs the supervisor is the only process that
  knows its own pid. Cancel sends SIGTERM — never SIGKILL, which would leave
  exactly the orphan the supervisor exists to prevent — and the existing reap
  path takes the executor's whole process group.

  It records a `dispatch_cancelled` row and stops there. The kernel still owns
  the completion row, written when its spawn unblocks, normally with
  `signal: "SIGTERM"`. Cancel refuses and writes nothing when the dispatch has
  already completed, or when there is no claim on this machine — both would be
  claims about work this call never touched.

- **`fadeno targets [--json]`** — one row per declared target, dialed or not.
  `loadout list` answers "what runs for this archetype", so a target no loadout
  references appeared nowhere: the only ways to discover one were reading
  `executors.yaml` or misspelling a name and reading the candidate list off the
  error. Both drivers added below ship with no loadout, which was about to make
  that the normal case rather than the corner.

  Each row names the **driver binary** it would spawn, and delivery is compiled
  against the active host — so the same target reads `host` on its own harness
  and `command (claude)` elsewhere, which is the host/driver distinction made
  visible per row. `DIALED BY —` means reachable but bound to nothing.
  `[fallback read-only]` on a host row is deliberately qualified: `write_access`
  only ever describes a route's command delivery, so an unqualified "read-only"
  there would claim something about the in-session agent that the field cannot
  know.

- **Two new driver harnesses: Antigravity and OpenCode.** The starter catalog
  gains a `google` target/route (Antigravity's `agy`) and an `openrouter` one
  (OpenCode), reachable from all four host route tables. Both are *drivers* —
  harnesses Fadeno spawns as subprocesses — so neither adds a `HarnessId`, a
  `templates/` tree, an `init` flag, or a plugin: the whole change is catalog
  plus docs. `fadeno loadout set worker gemini-default` (or
  `opencode-default`) is enough to route worker-shaped work to either.

  Both are verified live end to end through the kernel: prompt on stdin,
  `outcome: ok`, report on stdout, correlated evidence pair — and for
  Antigravity, a file actually written into the repo, which is the part that
  matters below.

  Antigravity is used instead of gemini-cli because that client is retired for
  individuals and dies at auth with `IneligibleTierError`. Its route encodes
  three findings, and **two of the three rejected spellings fail by exiting 0
  having done nothing** — the silent-success shape this project keeps hunting:

  - `agy -p` requires a value, and `agy -p -` does not read stdin. It takes the
    literal `-` as the prompt and answers "How can I help you today?" with exit
    0. Piping with no `-p` is the spelling that delivers the prompt.
  - Without `--new-project`, agy has no active workspace and writes to
    `~/.gemini/antigravity-cli/scratch/` while reporting "I have created the
    file" and exiting 0 — the repo gets nothing. `--add-dir .` does not fix it;
    only an absolute path does, which a static route cannot express.
  - `--effort` accepts only `low|medium|high`, so passing `{reasoning_effort}`
    would hard-fail every target left at the `default` effort. Antigravity
    encodes effort in the model id (`gemini-3.1-pro-high`) instead.

  OpenCode is multi-provider (`-m provider/model`), so its provider key is the
  credential holder and the route prefixes it (`-m openrouter/{model}`) rather
  than pushing an OpenCode-shaped id into the harness-neutral target.

  All three Antigravity flags are pinned by tests, because each one is exactly
  the kind of flag a later reader would delete as redundant.

- **A glossary for hosts versus drivers** (`docs/architecture.md`). Fadeno
  relates to a harness in exactly two ways and had a good word for only one of
  them. A **host** is the harness Fadeno runs inside: typed as `HarnessId`,
  needs a `templates/<host>/` adapter, selects which `routes:` sub-table
  compiles. A **driver** is a harness Fadeno invokes as a subprocess: needs
  nothing but argv, and appears only as a route's `command:`. The reliable test
  is whether it needs a `templates/<x>/` tree. Also records three standing name
  collisions — `grok` as both a `HarnessId` and a route binary, `adapter` as
  both a host surface and a delivery mechanism, and `Target` (a host in
  `init.ts`) versus `targets:` (a provider/model profile) — documented rather
  than renamed because all three are load-bearing.

- **Both harnesses work at once; the host in evidence decides the routes.**
  Almost everything about a harness was already per-harness and additive —
  `installations.json` records Claude and Codex independently, Codex role
  agents live in `~/.codex/agents/`, the Claude plugin in its own cache. One
  thing was global and single-valued: the `harness` memo, overwritten by every
  targeted setup. Resolution read that memo, so on a machine set up for both,
  a bare `fadeno` compiled whichever harness `setup` had touched last — and
  under the wrong block an Anthropic host slot is not merely unpreferred, it
  has no host route at all, so an in-session subagent silently became a
  `claude -p` subprocess. `activeHarness` now consults the host actually
  exporting its markers into this process before falling back to the memo:
  explicit argument → `FADENO_HARNESS` → detected host → memo → `standalone`.
  Switching hosts is now just switching; no `setup` toggle in between. The
  memo keeps answering the one question it can — which harness to assume when
  no host claims the session at all (a plain terminal, CI, cron).

  Nesting is handled at the spawn point rather than by guessing. A host
  exports its markers into everything it launches and children inherit them,
  so a `codex exec` worker started from Claude Code carries `CLAUDECODE` *and*
  `CODEX_THREAD_ID`; ordering cannot break that tie because the reverse
  nesting is symmetric. Two claimants therefore resolves to *no* detection and
  falls through to the memo, exactly as before detection existed, with
  `doctor` reporting the nesting. The kernel's executor spawn — which passed
  no `env` at all and so leaked its own identity into every child — now clears
  `FADENO_HARNESS` and the marker set, letting whatever the child launches
  assert what it actually is. Config locations like `CODEX_HOME` are left
  alone: they say where a host keeps settings, not that you are inside one.

  Harness *state* follows the same rule. Codex binds role agents to files at
  session start, so a loadout switch has to rewrite them — and `fadeno use`
  decided whether to by asking the same single-valued memo, which meant
  switching a loadout from a Claude session left the Codex agents naming the
  executor you had just switched away from, silently and with nothing else to
  correct it. `doctor` could not report it either: its `codex-agents` check
  and the freshness data behind it were both gated on Codex being the *active*
  harness, so they stopped looking in exactly the case that breaks them.
  Materialization and that check now key on the harnesses this machine
  maintains — `installations.json` already recorded each independently, unioned
  with the memo so no machine set up before the manifest loses behavior. An
  explicit `fadeno use --codex` still forces the write; there is deliberately
  no flag that suppresses it, since skipping maintenance is the bug. Freshness is
  judged against the catalog compiled *for codex* rather than the active
  harness, because which archetypes need an agent is itself harness-dependent:
  an anthropic target is a host slot under Claude and a command under Codex.

- **`doctor` notices a harness nobody recorded.** Routes are compiled per
  harness, and `activeHarness` answers `standalone` whenever no memo exists —
  a defensible answer to "which host am I in" that nothing ever revisited. Under
  `standalone` the native route does not merely lose preference, it does not
  exist, so a host-native slot compiles to `adapter: command` and a subprocess
  runs where an in-session agent was meant to. The gap is easy to reach: only a
  *targeted* `fadeno setup --claude|--codex` writes the memo, while the loadout
  pin beside it is written unconditionally and `fadeno use` never writes a
  harness at all, so the two states that look like a pair arrive separately.
  `doctor` now compares the resolved harness against session-scoped markers the
  hosts themselves export (`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`,
  `CODEX_THREAD_ID`/`CODEX_SANDBOX`/`CODEX_PERMISSION_PROFILE`) and warns in
  both directions — nothing recorded, or a memo that contradicts the host —
  citing the variable that carried the evidence and the one command that
  records it. Detection is diagnostic only: routing never consults it, because
  silently promoting a guess into compiled adapters is how one loadout starts
  delivering a slot differently depending on which process asked. This also
  restores `codex-agents`, which keys on `status.harness === 'codex'` and so
  went quiet in exactly the case it was written for.

- **Shadow dispatches: model tryouts at zero risk.** A slot can carry a
  shadow challenger (`fadeno loadout shadow worker grok-worker`, sampled
  with `--rate 0.2`, one-shot with `fadeno dispatch --shadow <executor>`):
  the kernel duplicates each matching dispatch to the challenger with the
  byte-identical prompt snapshot, delivered into a detached-HEAD git
  worktree so a write-shaped shadow yields a diff artifact
  (`diff_snapshot`/`diff_bytes`) and never touches the workspace. Shadow
  rows stamp `shadow: true`, `primary_dispatch_id`, `shadow_source`, and
  `gate_eligible: false` — they pair, they never gate, and no shadow-side
  failure can affect the primary's result. `fadeno dispatches
  --comparisons` renders the paired scorecard per challenger together with
  `ModelComparison` artifacts (committable files under
  `.fadeno/comparisons/` whose contract mandates a confounds section), and
  the `model-tryout` starter playbook runs the deliberate head-to-head.
  The adoption ladder is one command per rung: shadow → override → preset.
  Ledger format stays 0.2; every new field is additive.
- **Dispatch output survives the kill.** The kernel now streams executor
  stdout to a snapshot at `.fadeno/local/outputs/` as it arrives (the same
  single-writer idiom as prompt snapshots), so a relay killed by a harness
  timeout no longer destroys the report: the request row names
  `output_snapshot` before the spawn, the completion row adds
  `output_bytes`, and `fadeno dispatches --output <id|last>` prints the
  snapshot verbatim with an attestation verdict (`match` / `mismatch` /
  `incomplete`). The dispatch proxy contract gains the matching recovery
  step, allowlisted in the proxy guard. Completion rows also attest
  `workspace_changed` (a git fingerprint before/after the spawn — evidence,
  not judgment), and `fadeno dispatches` marks the exit-0 no-op signature
  with `[no workspace change]`.
- **Resolution is strict where it decides and graceful where it looks.**
  `fadeno loadout resolve` now refuses a stale pin with the same error
  `fadeno dispatch` raises instead of silently falling back to the default
  loadout, and the steering hook denies a proxy-bound spawn on a resolver
  error rather than quietly going native; inspection commands keep
  surfacing `stalePin` without bricking. A user-scope dial now applies only
  where the user layer was actually composed — a self-contained project
  profile is authoritative, so someone's global pin no longer reaches into
  unrelated repos. Self-contained catalogs that predate canon archetypes
  get a note in the loadout views naming what they never declared
  (`suppressedCanonArchetypes` in the JSON), leaving adoption an explicit
  choice.
- **Constraint tiers at the dispatch boundary** (phase 3 of
  `docs/experimental/slots-and-archetypes.md`) — policy the kernel can
  enforce, in two tiers. Tier 1 is declarative vocabulary:
  `distinct_provider_from_inputs: advisory | required` on archetypes,
  enforced against input provenance (`fadeno dispatch --produced-by
  <dispatch-id>` on the ad-hoc path; the run's own events on the engine
  path) — `required` refuses provider clashes and unresolvable provenance,
  `advisory` warns and records `provider_distinctness: "warned"`; and
  per-target `eligibility: { <archetype>: eligible | shadow_only |
  forbidden }` — `forbidden` refuses at dial time and dispatch time,
  `shadow_only` dispatches but stamps rows `gate_eligible: false` (phase 4's
  shadow flag; gate semantics unchanged in this phase), with both states
  marked in the `fadeno loadout` tables. Tier 2 is the escape hatch:
  top-level `constraints: { command: [...] }` invoked at the dispatch
  boundary with the full resolution context on stdin — exit 0 allows, exit
  2 refuses with stderr as the reason, anything else is a loud
  constraint-system error, never an allow. Every boundary refusal
  (write posture retrofitted too) now appends a `dispatch_refused` evidence
  row naming predicate and message; `fadeno dispatches` renders refusals
  and shadow rows distinctly; `fadeno verify` recomputes `gate_eligible`
  stamps from the run snapshot. Profile layering now carries `constraints:`
  across layers.

- **Archetype schema pass** (phase 2 of
  `docs/experimental/slots-and-archetypes.md`) — the archetype vocabulary
  opens up while staying kernel-enforced. `requires_write` becomes
  three-valued (`required` / `forbidden` / `none`; booleans alias for
  compatibility), and `forbidden` refuses dispatch onto a command route
  declared `write_access: true` the same way `required` refuses
  `write_access: false` — at the dispatch boundary and at dial time. The
  starter catalog gains the fourth canonical archetype, `generator`
  (divergent artifact-producing work: `requires_write: forbidden`,
  `fallback: worker`, no dedicated surfaces — every existing loadout serves
  it with zero edits). Archetypes may declare `fallback` chains: bindings
  only (a chain never imports another archetype's policy), acyclic at
  parse, and overrides beat fallbacks because resolution re-enters the
  override→slot cascade at each chain step. Rows bound through a chain
  record `resolved_via`; steering walks the chain to the first native
  surface (worker / reviewer / judge) and carries a write-forbidden
  advisory on native delivery, where posture is advisory by construction.
  Dispatch evidence format bumps to 0.2 (additive fields, same major — 0.1
  rows still read). Archetype keys and fallback references are
  identifier-validated.

- **Session slot overrides** (phase 1 of
  `docs/experimental/slots-and-archetypes.md`) — switch one archetype at a
  time instead of authoring a loadout per combination:
  `fadeno loadout set worker grok-default` dials a single slot over the
  active loadout, `fadeno loadout clear worker` reverts it, and switching
  the base loadout drops all overrides with a reported count. The pin file
  stays a bare name until the first override, then becomes single-line JSON
  (`{"loadout": …, "overrides": {…}}`); overrides apply by name match with
  the pin's base, from any selection source. `fadeno loadout` — and the
  active entry of `fadeno loadout list` — now print the
  *effective* table with `OVERRIDE (base: …)` marks; `loadout set` runs the
  archetype write-access check at dial time, refusing before any dispatch
  burns tokens; `--json` was added across the loadout subcommands. The
  resolution cascade gains the layer everywhere at once (binding → session
  override → loadout slot → `"*"`), including `loadout resolve` — so the
  Claude steering hook honors overrides with zero hook changes. Evidence is
  additive on ledger format 0.1: dispatch rows record
  `resolution: "override"` plus an `override` field, run
  `resolution_snapshot` events record the applicable `overrides`, and
  verification replays from the snapshot — never the live pin — so clearing
  an override cannot fail a completed run's verify.

- **`current-host` filler idiom in the starter catalog** — the `grok-worker`
  starter loadout now binds only its point (`worker: grok-default`) and
  fills reviewer/judge with the harness-relative `current-host`, so one
  loadout is correct on every host instead of pinning another provider's
  models into slots the loadout never cared about.

- **Write-access enforcement at every command delivery** — the
  `write_access` / `requires_write` conflict is now refused wherever a command
  delivery can be chosen, through one shared helper (`explainWriteConflict`
  in `src/lib/executors.ts`), so the refusal text is identical everywhere:
  `fadeno dispatch` (as before); `drive`, where the actor now fails pre-spawn
  with `reason: "write_access_denied"` and the run pauses in
  `executor_failed` — no prompt assembled, no run burnt; and
  `steering resolve`/`apply`, which return `mode: write_conflict` and decline
  to materialize a command broker for the conflicted slot while other slots
  proceed. Native in-session deliveries and locked engine host requests stay
  exempt by design.

- **Dispatch-ledger format versioning** — every row `fadeno dispatch` and the
  steering hook write now carries `format: "0.1"`, and `fadeno dispatches`
  reads in tiers: unversioned rows with a recognized `event` are current,
  pre-two-row completion-only rows render as `[legacy]` entries instead of
  counting as unreadable, and rows from a newer format major get their own
  skip count. Old evidence ages into legacy instead of degrading into noise —
  on the dogfood repo this turned "6 unreadable rows skipped" into six
  readable `[legacy]` dispatches.

- **`fadeno dispatches`** — the read side of `.fadeno/dispatches.jsonl`, which
  until now was a file you reached for `jq` to answer questions about. It
  correlates each `dispatch_requested`/`dispatch_completed` pair by
  `dispatch_id` into one row per dispatch, renders hook-written
  `native_delivery` rows inline so both delivery routes read as one history,
  and keeps a request whose completion never arrived — marked "no completion
  recorded (killed or in flight)" — because a dispatch that died mid-flight is
  the one most worth seeing. Rows surface the markers that change their
  meaning: `relay_attested`, `[write_access: none]`, and `model_override`.
  `--tail <N>` defaults to 10; `--json` emits the correlated rows for scripts.

- **`hook_version` on hook-written evidence** — `native_delivery` rows (and any
  other row a hook writes) now record which generation of the hook wrote them:
  `dev` in the committed template, the package version in every emitted copy.
  Hook registrations bind at session start but script bodies have been
  observed refreshing mid-session after a plugin update, so which generation
  of a hook is running is never safe to assume — a just-fixed rung and a
  genuinely broken rung are indistinguishable from the inside. The stamp makes
  the writing generation forensically identifiable, so "the fix doesn't work"
  separates from "the fix isn't loaded yet" from the evidence rather than by
  argument.

- **`parallel-workstreams` starter playbook** — the runnable encoding of the
  parallel dispatch fan-out pattern: freeze the shared contract (names,
  schemas, refusal texts) before any worker starts, fan out under per-worker
  ownership manifests carrying the mandatory-exception rule (an edit outside
  your manifest that is required for correctness is made *and* flagged, never
  silently skipped), keep every worker finish-order independent, then run a
  dedicated integration phase that owns cross-cutting files, the plugin
  rebuild, the changelog, and the first full-suite run. Drawn from two live
  fan-outs on 2026-08-12; rationale in
  `docs/experimental/loadouts-and-dispatch.md` → *Parallel dispatch fan-out*.

- **Route write-access policy** — a schema v2 route entry may declare
  `write_access: <bool>` (whether that route's *command* delivery can mutate
  the workspace), and `executors.yaml` may declare a top-level `archetypes:`
  mapping whose values accept only `requires_write: <bool>`. `fadeno dispatch`
  refuses **before spawning** when the resolved command route says
  `write_access: false` and the archetype says `requires_write: true` — the
  2026-08-12 dogfood case was a commit task delivered through a headless
  `claude -p` fallback that has no approver for a write, dispatched only
  because the kernel read "has a command" as "is dispatchable". Either side
  undeclared imposes no constraint, so existing profiles are unaffected. When
  declared, `write_access` joins the evidence-row identity and a proceeding
  read-only dispatch echoes `[write_access: none]`. The starter catalog ships
  the policy live: `archetypes: { worker: { requires_write: true } }`,
  `write_access: true` on the sandboxed `codex exec` routes, `write_access:
  false` on the headless `claude -p` routes (xai stays undeclared until
  `grok build`'s headless permission posture is confirmed).

- **Native-delivery evidence** — the Claude steering hook now appends a
  `native_delivery` row to `.fadeno/dispatches.jsonl` (timestamp, archetype,
  agent_type, loadout, executor, model, model_override, `reasoning_effort:
  "inherited"`, `transport: "host-native"`, prompt_sha256, prompt_snapshot)
  plus a verbatim prompt snapshot at
  `.fadeno/local/prompts/native-<sha8>.md` whenever it steers a spawn to a
  native role agent. Command dispatches get two-row kernel evidence,
  snapshots, and relay attestation; the kernel is not in the native path, so
  the hook is the only possible writer there. One file now audits both
  delivery routes. Best-effort: it never changes a steering decision.

- **Two-row ad-hoc dispatch evidence** — `fadeno dispatch` now appends a
  `dispatch_requested` row *before* invoking the executor and a correlated
  `dispatch_completed` row (shared `dispatch_id`) after, so a dispatch killed
  mid-flight (harness timeout, SIGTERM) still leaves a trace in
  `.fadeno/dispatches.jsonl`. Completion rows record the terminating `signal`
  when there is one, plus `prompt_source` and `prompt_snapshot`.

- **Kernel-owned prompt snapshots** — a dispatch prompt arriving on stdin is
  written by the kernel itself to `.fadeno/local/prompts/` and referenced
  from the evidence rows; a single writer means the recorded `prompt_sha256`
  attests exactly the bytes received. Callers no longer pre-write prompt
  files.

- **Dispatch proxy relay guard** — a `PreToolUse` Bash hook
  (`dispatch-proxy-guard.mjs`, shipped in the plugin's hook manifest and
  installed by `init --claude` steering) that fires only inside the
  `dispatch-*` proxy agents. It allowlists exactly the relay contract — the
  single stdin-heredoc `fadeno dispatch` statement (heredoc body deliberately
  uninspected), the prompt-file retry, and the legacy prompt-file-write
  shapes older init-emitted agents still use — denies everything else with
  an actionable reason, and raises the dispatch call's Bash `timeout` to
  600000 ms. Instruction-only proxies were observed defecting on the relay
  contract in a 2026-08-12 dogfood A/B; this makes the contract tier-2. On
  harness versions that omit `agent_type` from hook input the guard no-ops
  (advisory-only).

- **Relay attestation** — the Claude steering hook stashes the spawn-side
  prompt digest whenever a subtask heads to a dispatch proxy; the kernel
  consumes a matching stash at dispatch time and marks the evidence row
  `relay_attested` (true / false / absent), turning the proxy's "verbatim
  relay" from an instruction into a checked claim. Content-keyed and
  age-limited; never blocks a dispatch.

- **Version-stamped plugin surface** — plugin generation appends
  `[fadeno <version>]` to every agent and skill description, so a live
  session's loaded surface can be checked for staleness against
  `claude plugin list` (loaded surfaces only refresh at reload/restart).

- **Compositional map/loop runtime** — literal-member maps may own linear child
  graphs, including independently advancing bounded loops; loops may contain
  maps. The engine computes a runnable frontier, batches native host leaves,
  scopes prompts/artifacts/progress with canonical `node_instance_id`, and
  supplies scoped collections to downstream reducers. `show` expands member
  state and `verify` checks containment plus dispatch identity.

- **Native host dispatch** — executor profiles now discriminate `command` and
  `host` adapters. `fadeno drive` batches durable native-agent requests and
  pauses at `awaiting_host_dispatch`; the host records idempotent lifecycle
  receipts with `dispatch-start`, `dispatch-complete`, and `dispatch-fail`.
  Requests and receipts attest the requested model, reasoning effort, agent
  type, native agent id, workspace, branch, output digest, and optional commit.
- **Declared run inputs** — repeated `fadeno new-run --input Name=path` copies
  exact input bytes into the run, records digest/provenance manifests, rejects
  unsafe paths, and supports per-actor filtering for literal role maps.
- **Native-dispatch verification** — `fadeno verify` checks strict request →
  start → terminal ordering, profile/request/receipt attestation consistency,
  immutable schema-repair feedback, and symlink-safe output placement.
- **Cross-harness progress projection** — `dispatch-progress` records bounded
  JSON observations labelled as agent-, harness-, or director-reported.
  Immutable prompts name an ephemeral sidecar, verification enforces lifecycle
  placement and identity agreement, and `show` projects every graph step and
  literal map actor as pending/running/waiting/blocked/completed/failed with
  per-actor, per-step, and total runtime. Progress is never a gate input.

- **`fadeno drive <run>`** — the engine. Owns the run transition loop over the
  same pure cursor as `fadeno next`: assembles/reuses prompt snapshots,
  dispatches each actor step through its bound executor, validates typed
  outputs (one bounded schema repair per actor call — rejected bytes are
  parked under `artifacts/attempts/` as evidence, never at the planned path),
  assembles map collectives, evaluates deterministic gates, records loop
  iterations, pauses durably at human gates, and exits whenever it pauses
  (`--max-transitions` caps a single invocation; resume is just re-running
  drive). Steps it cannot execute (tool_call, undemonstrated primitives,
  agent-interpreted gate conditions) are handed back honestly.
- **Executor profiles** — `.fadeno/executors.yaml` (seeded by `init`): named
  `command`-adapter executors plus direct role→executor bindings with a `"*"`
  default. No routing, ranking, or automatic fallback. The profile is
  snapshotted into the run dir (`profile.yaml` + `profile_snapshotted` event
  with digest) on first engine contact; explicit substitution is
  `fadeno drive --bind role=executor`, recorded as `executor_override`.
- **Runtime identity** — engine dispatch/output events carry
  `step_execution_id`, `actor_call_id`, and `attempt` + `attempt_reason`
  (`initial` | `schema_repair` | `executor_override` | `user_retry`); new
  canonical events `actor_dispatched`, `actor_completed`, `actor_failed`.
  Identities are minted only by the engine — hand-driven ledgers omit them.
- **Named human decisions** — human gates pause with a durable
  `decision_requested` (id, prompt, declared options); **`fadeno decide
  <run> <option>`** records `decision_resolved` (idempotent duplicates,
  conflicting resolutions refused). The cursor accepts `decision_resolved`
  alongside the hand-driven `human_decision`.
- **`artifact_superseded`** — explicit supersession, validated at record time
  (both sides must be recorded artifacts); a superseded path is excluded from
  active-artifact resolution without a new generation.
- **Session-capable executors (opt-in; memoryless remains the default)** — an
  executor that declares `resume` (argv with a `{session_id}` placeholder)
  keeps one harness session per role per run, e.g. `claude -p
  --session-id/--resume` or `codex exec resume`. Ids are engine-minted
  (`{session_id}` in `command`) or harness-assigned (`session_id_pattern`
  regex over stderr/stdout). Every dispatch and every artifact born from
  resumed context is marked `session: fresh|resumed` + `session_id`; a schema
  repair against a live session sends only the repair message (recorded as
  `repair_appendix`). Honesty boundary: resumed prior context is attested by
  session id, never recomputable — prefer memoryless executors when memory
  isn't needed.
- **`fadeno verify` → 21 checks** — new: `actor-attempts` (ordinal contiguity,
  allowed retry reasons, rejected-output digests), `executor-bindings`
  (snapshot digest + every dispatch matches the binding in force),
  `named-decisions` (declared options, at-most-once), `artifact-supersede`
  (reference integrity), `session-continuity` (a resumed session id must
  exist earlier in the run for the same role under the same executor).
- **`fadeno show`** — projection surfaces actor calls, attempt counts, schema
  repairs, executor failures, and `! waiting for human decision`.
- **Driver skill** — engine-first: `fadeno drive` → `fadeno decide` → re-drive,
  with the manual `fadeno next` loop as the fallback for handed-back steps.

### Fixed

- **A completion row was stamped with the dispatch's start time.** Both rows of
  a pair were written from the same clock reading, so `dispatch_completed`
  carried `timestamp` = when the dispatch *began*. The one field a reader
  reaches for to ask "when did this finish?" quietly answered a different
  question, and a ten-minute dispatch looked instantaneous. Found while
  computing dispatch overlap for the `last` refusal below, where reading the
  stamp would have detected no concurrency at all.

  The completion row now records the real end, derived as `now + duration_ms`
  rather than read fresh off the wall clock, so `completed - requested ==
  duration_ms` holds exactly and an injected clock still yields a deterministic
  log. Shadow completions follow the same rule. A 2s dispatch that recorded
  `0.000s` between its rows now records `2.349s`.

  Readers keep deriving the end from `requested_at + duration_ms` instead of
  trusting the stamp. The log is append-only: every row written before this
  carries the start in both places, and trusting the stamp would collapse those
  dispatches to zero length and stop detecting their overlaps. The two agree on
  new rows by construction; on old ones only the derivation is right.

- **Timeout recovery returned another agent's report.** The first real exercise
  of the rc.22 recovery path, on 2026-08-14: a proxy timed out, ran
  `dispatches --output last`, and got a concurrent dispatch's output. Its own
  work had completed fine — the failure was purely in retrieval. `last` prefers
  an *open* dispatch, but both had finished by the time either looked, so it
  fell through to bare recency and returned the newest row in the log. It did
  flag the guess in-band, which is much better than silent, but an agent
  consumed the note and relayed anyway: a wrong answer with a caveat is still a
  wrong answer.

  The obvious fix — echo the dispatch id at launch — was already shipped in
  rc.22 and is what failed. The echo goes to stderr, and the caller who needs
  it is by definition the one whose Bash call was killed, taking the stream
  with it. So the handle has to be one the caller *chose*:
  `fadeno dispatch --tag <handle>` records it on the dispatch's rows, and
  `fadeno dispatches --output tag:<handle> --wait 120` recovers by it. A tag is
  known before the spawn and survives losing every byte the dispatch printed.
  The proxy agents now launch with a task-derived tag and recover with it, and
  the guard permits both spellings. (`tag:<handle>` rather than
  `--output --tag <handle>` because `--output` takes a value and would swallow
  the flag — a caller recovering from a timeout should not also have to get
  flag ordering right.)

  `last` no longer guesses when it cannot know. It refuses whenever the newest
  dispatch overlapped another in time — naming every candidate and its tag —
  and resolves by recency only when the dispatch demonstrably ran alone. The
  overlap is computed from `requested_at + duration_ms`, not from the
  completion row's timestamp, because the kernel stamps both rows of a pair
  from the same clock reading: a completion row's `timestamp` is when the
  dispatch *started*.

- **The evidence log could not say which Fadeno wrote it.** A 2026-08-13
  dogfood read twelve rows spanning a version bump and found exactly one
  version-shaped key across all of them — `hook_version`, which only the Claude
  steering hook writes, and which is therefore absent on every row the kernel
  writes. So the log's own provenance read as *mostly missing*, and the one
  question worth asking of old evidence — "which build produced this?" — had no
  answer. `fadeno_version` had existed in the binary the whole time; `evidence`
  and `vendor` rows carried it and no dispatch row ever did.

  Every dispatch row is now stamped, and stamped centrally in
  `appendEvidenceRow` rather than at the six call sites, because a per-site
  field is precisely how it came to be missing — a new row type cannot forget.
  The value is the version of the binary that *ran*, so a proxy invoking
  `$CLAUDE_PLUGIN_ROOT/bin/fadeno` records the plugin's build and a director
  invoking a bare `fadeno` records the CLI's, making a mixed-build session
  legible after the fact without a second field. The steering hook writes the
  same key on its `host_delivery` rows, so one field spans the whole log.

- **A session could not tell which Fadeno its subagents were.** The same
  dogfood ran a registry announcing `[fadeno 0.6.0-rc.20]` against a CLI at
  rc.22, with no rc.20 directory anywhere in the plugin cache, and reasoned
  about behaviour from the stamp. Nothing was corrupt: the plugin surface ages
  in two halves. Hooks and the bundled binary are re-read from disk on every
  call, while subagent definitions are snapshotted into the harness at session
  start and stay frozen for the session's life — and with a `directory:`
  marketplace source the live surface is the working tree, so cache
  directories exist only for versions someone explicitly installed. A stamp
  naming a version with no directory is expected.

  `fadeno doctor` reports this as `plugin-surface`: it names the plugin build
  on disk and the running CLI, and warns when they differ. When they agree it
  still says so and points at the half it cannot read — the registry is held
  inside the harness — telling the caller to compare the `[fadeno …]` stamp in
  their own agent list and restart if it differs. Behaviour questions are
  settled from `fadeno_version` in the ledger, which records what actually ran.

- **A timed-out proxy read the ledger once, too early, and called it failure.**
  The sharpest of the batch, because Fadeno's own data was correct throughout.
  A 2026-08-13 dogfood had two worker dispatches recorded as `exit_code: 0`
  with 5833 and 3743 bytes — genuine, complete reports. The proxies had read
  `dispatches --output` at the moment their Bash call timed out, which is the
  one moment the completion row is least likely to exist yet: the kernel
  writes it when the executor exits, and the executor was still running. They
  saw no completion row, declared failure, and never looked again. The finding
  is not "reports failure wrongly" but "has the right answer available and
  does not look again."

  `fadeno dispatches --output <id> --wait [seconds]` re-reads until the
  completion row lands (default 120s), then answers with the real, attested
  output. The wait re-resolves by the id it first settled on, so a dispatch
  starting mid-wait cannot steal the answer from a `last` query. The
  no-completion note stops reading like a verdict — "no completion row
  recorded YET: the executor may still be running … not a failure" — and the
  proxy guard permits the `--wait` spelling, since a contract that forbids the
  correct call is not a contract worth keeping.

- **A killed dispatch left its executor running.** The most serious of the
  batch, and confirmed end to end before it was fixed: `fadeno dispatch` runs
  its executor through `spawnSync`, which blocks Node's event loop for the
  whole spawn, so a killed kernel runs no cleanup — and the harness that kills
  it kills the kernel's pid, not its process group. Killing the kernel two
  seconds into a dispatch left the executor delivering all twenty of its
  files, still writing the inherited output snapshot, still consuming the
  host. A 2026-08-13 dogfood hit exactly this at the 600s Bash timeout: the
  orphan saturated the machine badly enough to invalidate an unrelated timing
  gate, while the proxy reported the dispatch as failed — so trusting the
  report would have re-dispatched the task and put two workers on the same
  files.

  The kernel now spawns a supervisor between itself and the executor. The
  supervisor runs the executor in its own process group and watches for
  re-parenting — when the kernel dies, the supervisor's `ppid` changes to the
  local reaper, which is exact and immune to the pid reuse a liveness probe
  would face across a ten-minute dispatch — then SIGTERMs the executor's whole
  group, SIGKILLing after a grace period. The executor's own subprocesses go
  with it, which is how a runaway saturates a host in the first place.

  Supervision is invisible when nothing goes wrong: stdin, stdout, exit codes
  and signals pass through unchanged, and a signal is re-raised rather than
  translated so `killed by SIGTERM` and `exited 143` stay different facts. The
  one thing it had to restore explicitly is the missing-executor case — the
  supervisor always starts, so `spawnSync().error` no longer reports a bad
  binary, and the supervisor marks that on stderr for the kernel to read back.
  The supervisor ships as source to `node -e` rather than as a sibling file:
  Fadeno runs from three artifacts (type-stripped source, built `dist/`, and a
  single-file esbuild bundle) and a file that had to be located from all three
  could go missing and break dispatch outright.

- **`killed` was reported as `failed`.** The dispatch proxies were instructed
  to "state plainly that the dispatch failed" when the call "exits non-zero or
  is killed" — one clause covering two facts that are not the same. A kill
  says nothing about the executor, which the fix above now stops but which had
  already delivered its work in the dogfooded case. The proxies now treat a
  kill as an UNKNOWN result, never a failure: report that the dispatch was
  killed at the harness timeout, that this is the output recovered so far, and
  that the work must be checked on disk before anyone re-dispatches — the last
  part explicitly, because re-dispatching is what puts two workers on one
  file.

- **The resolver stated the slot but not the call.** `fadeno loadout resolve`
  reported `adapter: "host"` and stopped there. The dogfood watched a director
  read that, narrate it correctly, write a 26-line prompt, dispatch anyway,
  and only then learn the call was impossible — four tool calls to discover
  something the resolver already knew. The result now carries `delivery`:
  whether the slot is dispatchable from this harness, the exact command when
  it is, and an `action` sentence that always ends in a verb (`Do NOT
  dispatch … spawn the in-session reviewer agent instead`). It shares the
  kernel's own dispatchability predicate rather than restating it, so a hint
  saying "dispatchable" can never precede a refusal.

- **Three paths reported success while producing nothing.** A 2026-08-13
  dogfood in an unrelated repo found the same shape three times: a terminal
  state that reads as success next to artifacts that show nothing happened.
  Two worker dispatches logged `dispatch_completed` with `exit_code: 1` and
  `output_bytes: 0` — the sha256 of the empty string — and the event name was
  the only thing most readers looked at. `dispatch_completed` has always meant
  "the spawn reached a terminal state", never "the work happened", and nothing
  in the row said which.

  Completion rows now carry an explicit `outcome`: `failed` for any spawn
  error, signal, or nonzero exit; `empty` for the quieter case where the
  executor exits 0 and writes nothing; `ok` otherwise. `fadeno dispatches`
  leads the outcome — `FAILED` / `NO OUTPUT` before the exit code, not after a
  line of identity — and `fadeno dispatch` now exits 1 on an empty report
  rather than handing a proxy a blank to relay. Rows written before the field
  derive the same verdict from the `exit_code` and `output_bytes` they already
  carry, so the old evidence reclassifies itself; a row carrying too little to
  say either way stays null, because absent is not a claim. No format bump —
  the field is additive.

  This also covers the silent model-id failure the same dogfood hit, where
  `--model grok` against a catalog that now resolves `grok-4.6` produced a
  zero-byte success twice before anyone noticed. Fadeno cannot pre-validate an
  arbitrary executor's model ids, but it can refuse to call an empty result a
  result.

- **`--output last` crossed wires between concurrent dispatches.** `last`
  resolved to the newest `dispatch_requested` row carrying a snapshot, across
  the whole repo's evidence log — so with two dispatches in flight, a proxy
  recovering after a kill could read back the *other* dispatch's report. The
  same dogfood hit exactly that; the proxy flagged the mismatch rather than
  passing the work off as its own, which is the behavior the relay contract is
  for, but the retrieval channel had no notion of caller identity at all.

  The kernel now echoes `dispatch id: <id>` on stderr before the spawn, so a
  caller can always name its own dispatch, and the proxy agents are instructed
  to prefer that id. `last` itself is now recovery-shaped rather than
  recency-shaped: it resolves to the dispatch with no completion row — the
  killed or in-flight one it exists for — and *refuses*, naming the
  candidates, when more than one is open. Falling back to recency is still
  allowed when nothing is open, and says so.

- **The `general-purpose` catch-all was captured as a worker.** The Claude
  steering hook mapped `general-purpose` onto the worker archetype, which
  meant every generic subagent spawn in a Fadeno repo became an external
  dispatch. The dogfood launched one for a direct analysis task and watched it
  become a `dispatch-worker`, then watched the proxy guard correctly enforce
  the relay contract on an agent that was never meant to be a proxy — "as a
  dispatch proxy I'm not permitted to run the analysis myself" — held against
  the very instructions it had been given. The analysis never happened.

  Only agents that *name* an archetype are steered now: `worker`, `reviewer`,
  `judge`, and the explicit `dispatch-*` proxies. `general-purpose` is the
  harness's default subagent — what a director reaches for to run an analysis
  or a search — and joins Explore, Plan, and unrelated specialists as
  unsteered. Directors that want archetype routing already have two explicit
  spellings; the catch-all is not a third.

- **`status` claimed project playbooks that did not exist.** The definitions
  line read `N effective playbooks (project shadows bundled)` — a statement of
  the shadowing rule that reads as a claim shadowing occurred, printed
  verbatim on repos with no `.fadeno/playbooks/` at all. It now counts the
  split: `all bundled`, or `N from .fadeno/playbooks, M bundled`. The Codex
  managed-agents line names its remedy (`fadeno use <loadout>`) instead of
  reporting `missing/stale (restart required)` and leaving the reader to find
  the command.

- **A native slot stays native instead of nesting a subprocess.** The dispatch
  proxy agents advertise themselves as MUST-BE-USED, so a director names
  `fadeno:dispatch-judge` directly — and the Claude steering hook used to
  short-circuit on that name, never asking which transport the loadout wanted.
  Command delivery was locked in by the caller. On Claude that meant `claude
  -p`: a subprocess of the harness already running, which loaded the same
  plugin, re-read the prompt as director work, and re-dispatched one level
  down until a headless permission denial ended it — exit 0, 97 seconds, a
  failure report in place of a judgment. The hook now resolves a named proxy
  like any other archetype spawn and pulls a host slot back to the native
  agent (`current-host` still inherits the caller's model, pinning none on the
  way out). The kernel carries the same rule as a backstop: on a harness that
  materializes native slots in-session on demand, a host executor's
  `fallback_command` is refused rather than spawned. That fallback keeps doing
  exactly what it was written for — Codex materializes role agents once per
  session, so a slot differing from that session's baseline still needs a
  command.

- **The starter xai worker has a real model id.** `grok-default` was bound to
  `model: grok`, which the CLI rejects outright ("unknown model id"; `grok
  models` lists grok-4.6 and grok-4.5), so every worker dispatch under it
  exited 1 in about five seconds having done nothing. Now `grok-4.6`,
  verified live against the CLI.

- **`status` reports the harness that actually compiled the routes.** It
  spelled harness resolution separately from `activeHarness`, reading
  `process.env.FADENO_HARNESS` past an injected env and ignoring an explicit
  `FADENO_HARNESS=standalone` — so the command whose whole job is reporting
  the effective configuration could name a different harness than the one
  whose routes it was reporting.

- **The starter xai routes actually run.** `[grok, build, "-"]` targeted a
  subcommand that does not exist — "Grok Build" is product branding; bare
  `grok` is the interactive TUI, which would have parsed `build` as a
  prompt. The routes now use grok's real one-shot mode
  (`--prompt-file /dev/stdin`) with `--always-approve` and declare
  `write_access: true`, resolving the long-open "xai headless write posture
  unknown" item: verified live, grok's one-shot mode runs a full agentic
  tool loop under `--always-approve`, and stalls silently — exit 0, one or
  zero messages, no tools — under any narrower permission mode, because a
  headless run cannot answer approval prompts.

- **Prototype-name roles and archetypes resolve cleanly.** A role, archetype,
  or binding named `constructor` or `toString` passes the bare-identifier
  rule, but plain property lookups in `resolveRole` found the inherited
  `Function` and crashed with a `TypeError` deep in `executorForArchetype`
  instead of the actionable `ExecutorProfileError`. Lookups now test for own
  string values (`typeof`/`Object.hasOwn`).

### Changed

- **The rename reaches the trace vocabulary too.** The first pass stopped at
  everything live and left the persisted names alone, on the belief that moving
  them meant a ledger format bump and re-pinned digests. That was wrong:
  digests cover artifact bytes and prompt bytes, never event field values, so
  nothing recorded becomes invalid. Writers now emit `delivery_transport:
  "host"`, the Claude hook writes a `host_delivery` row with `transport:
  "host"`, `fadeno dispatches` renders `[host]`, `verify` reports a
  `host-attestation` check, and hook prompt snapshots land at
  `.fadeno/local/prompts/host-<sha8>.md`. Every reader accepts the pre-0.6
  spelling — a `native_delivery` row still renders, and a ledger written with
  `delivery_transport: "native"` still verifies clean, including the
  start-vs-terminal receipt comparison, which normalizes both sides so a legacy
  pair is not read as a mismatch. The ledger format stays 0.3: no field moved,
  no digest changed, and an unrecognized transport is still reported rather
  than coerced. `ConstraintContext.transport` deliberately keeps reporting
  `native` — it is handed outward to user-authored constraint commands, the one
  contract where a rename cannot be aliased, only silently broken.

- **The delivery axis is spelled `host`, not `native`.** "Native" was doing two
  unrelated jobs: naming a *loadout* (which model target fills each slot) and
  naming a *route's transport* (whether the active harness delivers in-session
  or spawns a command). Worse, the transport already answered to a second word
  — `native: true` compiled to `adapter: 'host'`, and the executor filling the
  native loadout is `current-host`. The two senses coincide under the bundled
  catalog, where the `native` loadout binds `current-host` in every slot, so
  loadout-native and host-delivered always agreed; they come apart exactly when
  a slot is overridden with a provider target, which is the one configuration
  where the harness axis decides transport — under a loadout name implying it
  cannot. Routes now take **`host: true`**; `SteeringMode` returns `host`;
  `steering resolve` takes `--host-executor` and reports `host_executor`; and
  the internal `native*` identifiers follow. `native: true` remains accepted as
  a silent alias, so an existing catalog keeps loading (a route setting `host`
  and `native` to *different* values is refused rather than resolved by
  precedence — picking a winner would deliver a transport the author never
  wrote). `--native-executor` still parses, so a Codex role agent materialized
  by an older setup keeps resolving; it now reports stale so the next
  `fadeno setup --codex` rewrites it. `native` is retained deliberately in four
  frozen places, none ambiguous in context: the loadout name, the trace
  vocabulary (`delivery_transport: "native"`, the `native_delivery` event, the
  `[native]` row rendering), the `ConstraintContext.transport` JSON handed to
  user-authored constraint commands, and the route alias above. No ledger
  format change, so existing traces and their pinned digests still verify.

- **Starter-playbook registries derive from the filesystem.** The completion,
  diagram, init, and validate coverage all consume a single
  `starterPlaybooks()` helper that reads `templates/common/fadeno/playbooks/`,
  and a new guard asserts every starter is listed in the builder skill's
  catalog — shipping a starter is one file plus its catalog line, and a stray
  file in the starters directory fails loudly instead of shipping silently.

- **The suite gained a docs-claims tripwire and a drift escape hatch.** A test
  now asserts that the identifiers the docs promise — `dispatch_requested`,
  `dispatch_completed`, `native_delivery`, `write_access`, `requires_write`,
  `relay_attested`, `FADENO_PROMPT`, `schema_version: 2` — still appear where
  they are documented, so a rename that silently invalidates the prose fails
  the build instead of being caught by a reader months later. Separately,
  `FADENO_SKIP_DRIFT=1` skips the plugin no-drift check: parallel workstreams
  run against a tree their siblings are still mutating, where that check fails
  for reasons no one caused. It is an escape hatch for that window only —
  integration runs the suite without it.

- **Dispatch proxies run on `model: sonnet`** (was `haiku`) and their bodies
  are hardened: the whole relay is ONE Bash call — the task prompt piped to
  `fadeno dispatch` as a quoted heredoc on stdin — run with the tool
  `timeout` raised to 600000 ms; the verbatim rule spells out "starting at
  the very first line", and the proxy may never assert kernel-side effects it
  didn't observe. The bare `fadeno` spelling keeps the call inside the
  `Bash(fadeno:*)` permission rule init pre-approves, so default-permission
  users stop getting a prompt wall per dispatch. A 2026-08-12 dogfood A/B
  caught the haiku proxy performing a task itself with no dispatch and, on a
  compliant retry, dropping the prompt's first line and claiming an evidence
  row that was never written; sonnet relayed flawlessly. The spawn-rewrite
  steering hook routes command-delivered archetypes to sonnet proxies
  accordingly.

- **Host-executor refusal points home** — `fadeno dispatch` resolving to a
  host executor without a fallback now names the native in-session agent to
  use instead.

### Documentation

- **Schema v2 is now the primary form in the design spec.**
  `docs/experimental/loadouts-and-dispatch.md` → *Schema* presented v1
  `executors:` entries as the shape to write while the shipped catalog had been
  v2 for two releases. It now specifies v2 fully — `targets:`, per-harness
  `routes:` (`native` / `command` / `resume` / `session_id_pattern` /
  `write_access`), `archetypes:`, `loadouts:`, `bindings:`, and the layering —
  against `templates/common/fadeno/executors.yaml` as the reference example,
  with v1 demoted to a compact "Legacy schema (v1)" note (still parsed, still
  accepts `write_access`, and still the shape `serializeProfile` emits for the
  run-dir snapshot under either schema). *Vocabulary* gains **target** and
  **route**; sentences elsewhere that still spoke of `adapter:` fields as
  user-facing syntax now speak in route-table terms.

- **Native delivery honors half an executor's identity** — in-session delivery
  can pin the requested **model** (the harness Agent tool's `model` parameter)
  but not its reasoning effort: the Agent tool schema has no effort parameter,
  so a target like `opus-xhigh` lands as opus at the session's inherited
  effort. `native_delivery` rows record `reasoning_effort: "inherited"` rather
  than the declared effort, so the evidence never claims an effort the
  delivery could not set. Command delivery has no such gap — the route's argv
  carries the effort flag.

## [0.5.0] — 2026-08-02

The provenance slice of the next protocol (capabilities 3 + 6 of
`docs/experimental/next-protocol.md`): artifact manifests with sha256 digests,
a much stricter `fadeno verify`, and a legible step projection as the default
`fadeno show`. **Breaking: run-ledger format 0.2** — new ledgers carry
`schema_version: "0.2"` and per-event `seq`; readers refuse unversioned
(pre-0.2) ledgers unless `--legacy` is passed, and writers refuse them
outright. Old traces stay auditable via `fadeno show|verify|next --legacy`, or
with the fadeno version that produced them.

### Added

- **Artifact manifests** — `fadeno run --artifact <path>` (and `--event
  artifact_created`) now requires the file to exist, hashes it, and records
  `artifact_id`, run-dir-relative `artifact` path, `logical_name`
  (generation-stripped), `generation` (from the `.v<G>` marker), `bytes`,
  `sha256`, `media_type`, and a record-time `validation` verdict (typed
  artifacts are shape-detected and schema-checked; failures recorded honestly
  as `ok: false`). Artifacts are immutable: re-recording a path with different
  bytes is refused — write a new generation instead. Measured manifest fields
  always win over colliding `--field` values.
- **Sequence numbers** — every appended event carries a contiguous 1-based
  `seq` (stamped by a shared ledger writer used by `new-run`, `run`, `gate`,
  and `prompt`).
- **`fadeno verify` expansion** — 16 canonical checks: ledger version, run
  schema, event parseability, seq contiguity, terminal status, terminal-event
  agreement with run.yaml, manifest completeness, artifact existence, digest
  recomputation, typed-artifact revalidation, immutability, active-artifact
  resolution, prompt-snapshot integrity (snapshot + every recorded input digest),
  per-gate recomputation, completed-run gate coherence, and conflicting
  human decisions. Anything unrecomputable is reported as skipped, never
  silently valid.
- **`fadeno show` projection** — the default view is now logical steps with
  state glyphs and collapsed counts (artifacts, gates, loop iterations,
  decisions), active artifacts (highest valid generation per logical name),
  decisions, and failures. `--events` prints the raw timeline; `fadeno runs`
  tags pre-0.2 ledgers `[legacy]`.
- **`--legacy` compatibility mode** on `show`, `verify`, and `next` — the
  explicit legacy reader for pre-0.2 ledgers (normalizes the retired
  `artifact_written` event name; digest-family checks report as skipped).
  `fadeno prompt` has no legacy mode by design: it refuses pre-0.2 ledgers
  even for previews rather than silently resolving inputs differently.

### Changed

- **Run-ledger format 0.2** (breaking, see above). `run.schema.json` now
  requires `schema_version`.
- The legacy `artifact_written` event name is retired from all current-format
  readers (`prompt`, `next`, the flow cursor); it is honored only under
  `--legacy`.
- Deliberately deferred to the engine slices: the engine loop (capability 1),
  attempt ordinals / execution identities (2), executor profiles (4), the
  named human-decision structure (5), and an explicit supersede event —
  manifests carry no fabricated `step_execution_id`/`actor_call_id`.

### Added (earlier, unreleased)

- **`fadeno plugin --codex`** — generate a **Codex CLI plugin** (`plugin-codex/`
  + a `.agents/plugins/marketplace.json` pointer) from the same shared skill
  templates as the Claude plugin, so Codex users can install Fadeno the same way:
  `codex plugin marketplace add CrocSwap/fadeno` → `codex plugin add
  fadeno@fadeno`. Skills carry their per-skill `agents/openai.yaml` invocation
  policy (runner implicit; builder/driver explicit-only). Role subagents and the
  CLI binary aren't Codex-plugin components, so they stay with `fadeno init
  --codex` and npm. `npm run build:plugin:codex` regenerates the committed bundle.

## [0.4.0] — 2026-07-13

The coordinator layer — deterministic prompt assembly and a cross-harness
driver. A run can now be assembled and advanced from its ledger alone: one
command renders the exact prompt a step's actor receives, another computes the
next actionable step, and a driver skill walks the two to run a playbook
end-to-end across harnesses. `fadeno` still never invokes a model — it renders
and computes; the harness does the dispatch.

### Added

- **`fadeno prompt <run> <step>`** — deterministic step-prompt assembly (the twin
  of `fadeno diagram`). A pure function of the validated playbook, the run
  ledger (events through the invocation's `step_started` cutoff), the referenced
  artifact bytes, and the selection. Records an immutable snapshot under
  `artifacts/prompts/**` plus a `prompt_assembled` manifest event (per-input
  path/bytes/sha256, playbook + prompt sha256) by default; `--no-record` is a
  read-only preview. Pipe it into a sub-harness: `fadeno prompt <run> <step>
  --actor <role> | { claude -p; codex exec - }`.
- **`fadeno next <run>`** — a pure, read-only flow cursor (the third render twin
  of `diagram` and `prompt`). Emits the single next actionable step as JSON —
  `status` one of `ready` / `blocked_human_gate` / `needs_decision` / `terminal`,
  with the step's kind, actors, resolved output paths, gate/human-gate blocks,
  and loop state — so a driver can advance a run mechanically. Shares one
  output-path planner with `fadeno prompt`, so the cursor can never advertise a
  path the prompter would refuse.
- **`driver` skill** (Claude Code + Codex) — the cross-harness runner. The host
  stays pure (pick a playbook, gather inputs, `fadeno new-run`, dispatch); a
  driver subagent owns the ledger and runs each role as a uniform sub-harness CLI
  call, pausing and returning to the host at a `human_gate` so state-on-disk
  makes resume free.
- **`fadeno run --member <m>` / `--field k=v`** — attach a map-member attribution
  (`member`) or arbitrary fields to an appended event (e.g. `human_decision`
  with `branch=approve`); values that parse as JSON are stored decoded.
- **Playbook schema:** optional `output_path` (step template or member→template
  map; tokens `{actor}` / `{iteration}`), `input_bindings`, and top-level
  `artifact_contracts`, with matching validator checks.

## [0.3.0] — 2026-07-11

Trace verification — the provenance layer. A run ledger's claims can now be
re-audited deterministically: in CI, a git hook, or a Claude Code Stop hook.

### Added

- **`fadeno verify <run-id-or-prefix>`** (or `--latest`) — a strictly read-only
  re-audit of a run ledger: schema-valid `run.yaml`, fully parseable
  `events.jsonl`, a finalized terminal status, artifacts present, and **every
  recorded gate result recomputed from its artifact** — a trace can't claim a
  gate its artifact doesn't support. Unknown gate conditions are skipped as
  agent-interpreted rather than failed; `--allow-failed` accepts an honest
  `failed`/`aborted` terminal for audit use.
- **`init --with-hooks` emits `.github/workflows/fadeno-verify.yml`** — a CI
  workflow that verifies every run ledger a PR adds or modifies ("no valid
  trace with passing gates, no merge"). Deletion-only PRs pass; strict mode
  (require a trace on every PR) is one uncomment away.

### Changed

- The Claude Code Stop-hook example upgrades from a single `fadeno gate` check
  to `fadeno verify --latest`: when the agent stops, the latest run must be
  finalized and its gate claims must recompute from their artifacts.

## [0.2.0] — 2026-07-11

Formalize code-change workflow semantics: explicit loop exits, artifact-bound
gates, structured test results, path-aware validation, and honest failed-run
terminals. Also adds a trace-reading CLI (`fadeno runs` / `fadeno show`) and a
falsifiable evaluation harness for the runner skill.

### Added

- `tests_pass` and the `test-result.schema.json` artifact contract.
- Definite-artifact and normalized control-flow validation, including reachability,
  loop ownership, terminal statuses, and deterministic condition bindings.
- Gate and loop lifecycle event conventions in the runner ledger.
- `fadeno runs` lists run ledgers newest-first; `fadeno show <run-id-or-prefix>`
  renders one run as a summary, event timeline, and artifact listing. Malformed
  `run.yaml` files or `events.jsonl` lines are reported, never fatal.
- A falsifiable evaluation suite under `evals/` — five fixtures, three treatments,
  deterministic oracles, isolated workspaces — with a pilot report
  (`evals/pilot-report.md`). Repo-only; not part of the npm package.

### Changed

- `code-change-review` now distinguishes resolved review, exhausted review, passing
  tests, and failing tests.
- `fadeno gate` validates named artifacts and accepts `--artifact`; `--report` is
  retained as a deprecated alias.
- Claude's example Stop hook preserves non-zero gate failures and handles a missing
  run explicitly.

## [0.1.5] — 2026-05-31

Runner-guidance clarifications and a stronger plugin drift guard. No CLI behavior
changes — but the runner instructions are bundled templates, so plugin users
receive these via the version bump.

### Changed

- **Gate report-file convention is pinned.** The runner runtime reference now
  states that a reviewer `map` feeding a gate writes its reports as a single
  `review-report.json` array (which `fadeno gate` already reads), resolving the
  ambiguity with the per-item artifacts a `map` otherwise produces.
- **The plugin no-drift test is hardened.** It now diffs the entire generated
  plugin tree (file set + contents, both directions) and asserts the bundled
  `plugin/bin/fadeno` reports the current version, instead of checking a single
  `SKILL.md` — so a stale `plugin/` after any template edit or a missed rebuild
  on a version bump is caught.

### Documentation

- **Conventional `events.jsonl` event types** are listed in the runtime
  reference (`run_started`, `step_started`, `artifact_created`, `gate_evaluated`,
  `roles_degraded`, and a terminal `run_completed`/`run_failed`/`run_aborted`);
  the log stays open via `fadeno run --event <type>`.
- **Contributor docs** added: a root `AGENTS.md` orientation hub plus
  `docs/architecture.md` (codebase map) and `docs/extending.md` (file-by-file
  recipes for common changes).

## [0.1.4] — 2026-05-31

Fewer permission prompts.

### Added

- **`fadeno init --claude` pre-approves the CLI.** A full builder→runner flow
  makes ~a dozen `fadeno` calls, each of which otherwise triggers a Bash
  permission prompt. `init` now merges a `Bash(fadeno:*)` allow rule into
  `.claude/settings.local.json` (local, git-ignored) and ensures that file is
  git-ignored, so the CLI stops prompting on every call. Non-destructive
  (preserves existing rules, idempotent), announced on stdout, and easy to undo
  (delete the rule). Applies to the `--data-only` plugin-seed path too, where the
  prompts bite most. Plugins can't grant themselves Bash permissions, so `init`
  is the seam for this rather than the plugin.

## [0.1.3] — 2026-05-31

Prettier deterministic diagrams.

### Changed

- **`fadeno diagram` ASCII output is now a column of boxed cards** — one per
  step, with `▼` for sequential fall-through and `⋮` for a step reached only via
  a labelled `▶` arrow (a gate branch, loop exit, or jump). Loop bodies are
  inlined into the loop card. No 2-D edge routing, so it stays correct for any
  playbook.
- **Verbose primitive kinds are abbreviated in diagrams** (display only — the
  schema/vocabulary keep the full names): `actor_call` → `actor`,
  `tool_call` → `tool`, `evaluator` → `eval`, `human_gate` → `ask`,
  `artifact_op` → `artifact`, `subworkflow` → `subflow`. Applied to both the
  ASCII and Mermaid renderers.

## [0.1.2] — 2026-05-31

Live-session feedback fixes — ledger fidelity and runner robustness. The full
plugin surface (bundled CLI on PATH, `Skill(fadeno:*)` model-invocation,
`/fadeno:*` slash commands, and `fadeno:*` subagent dispatch) was confirmed
working end-to-end in live Claude Code sessions on this release.

### Fixed

- **Ledger fidelity.** `fadeno run` now stamps each event with the run's
  `current_step` instead of `null` (an explicit `--step` still wins; run-level
  events like `run_started`/`run_completed` stay `null`). `fadeno new-run`
  builds run ids from **local** date/time (`started_at` stays UTC ISO) and slugs
  the task on **word boundaries** rather than cutting mid-word.
- **CLI discoverability.** Skills call the bundled binary via
  `"${CLAUDE_PLUGIN_ROOT}/bin/fadeno"` when bare `fadeno` isn't yet on PATH (the
  plugin's PATH entry can lag a `/reload-plugins` within a session).

### Changed

- **Role degradation is now loud.** When role subagents aren't available, the
  runner says so, runs each role as a separate pass, and records a
  `roles_degraded` event — so a degraded run never reads as if it had used
  dedicated subagents.

### Documentation

- A terminal `evaluator` (no following `gate`) is documented as legitimate: when
  the structured judgment *is* the deliverable, it validates clean.
- README documents the post-install `/reload-plugins` step that registers the
  role subagents.

## [0.1.1] — 2026-05-30

Claude plugin invocation fixes.

### Fixed

- **Builder is invocable again.** `disable-model-invocation: true` had made the
  builder skill unreachable by both the model and slash invocation. The gate is
  removed; the builder is model-invocable, and its scoped description keeps it
  from auto-firing on ordinary coding tasks.

### Added

- **Plugin slash commands** `/fadeno:runner` and `/fadeno:builder` (new
  `templates/common/commands/`) — the discoverable `/`-menu front door that
  drives the matching skills.

### Changed

- Role subagents renamed `fadeno-worker`/`fadeno-reviewer`/`fadeno-judge` →
  **`worker`/`reviewer`/`judge`** on both hosts, so they address as
  `fadeno:worker` (not the double-prefixed `fadeno:fadeno-worker`). Runner
  references now cover reload/restart registration and namespacing.

## [0.1.0] — 2026-05-30

Initial v0 — the portable, repo-native playbook layer.

### Added

- **CLI:** `init` (`--codex`/`--claude`, `--with-hooks`, `--data-only`,
  `--force`), `validate`, `diagram` (`--format ascii|mermaid`), `new-run`,
  `run`, `gate`, `plugin`. Built on Node's `parseArgs` + `node --test`; runtime
  dependencies are only `ajv` + `yaml`.
- **Dual-target scaffolding** from one template core (Codex + Claude Code),
  non-destructive (append-or-create, skip-unless-`--force`, idempotent).
- **Schemas** (`playbook`, `run`, `review-report`) and **starter playbooks**
  (`code-change-review`, `research-synthesis`, `pr-review`), plus runner and
  builder skills with bundled references.
- **Validation:** schema + reference-integrity + semantics (actor-must-be-a-
  declared-role errors; unproduced-input and unused-role warnings); also
  validates run ledgers and review reports.
- **Run ledger** (`run.yaml` / `events.jsonl` / `artifacts/`) with CLI helpers
  and a deterministic `gate no_blocking_issues` evaluator — the
  advisory→enforced bridge.
- **Builder arc + diagrams:** seed → starter-or-NL → write → validate → diagram
  → human-gate approval → hand off to the runner.
- **Tier-2 enforcement scaffold** via `--with-hooks` (executable pre-commit
  guard, CI workflow, Claude hook example).
- **Claude plugin packaging:** `fadeno plugin` generates `plugin/` from the same
  templates; the CLI is bundled self-contained into `plugin/bin/`; a repo-root
  `.claude-plugin/marketplace.json` makes the repo directly installable
  (`/plugin install fadeno@fadeno`).
