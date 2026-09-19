# Basanos feedback triage — 2026-09-19

Reviewed 179 current feedback sections (September 8–19), 31 archived sections,
and 41 PASS scorecard rows. PASS rows are validation evidence, not defects.
The source feedback is in `~/sith/toys/crypto/basanos/.fadeno/feedback.md`.

| Priority | Finding | Disposition |
|---|---|---|
| P1 | Forced cleanup removed live command transcripts and cancellation state | Fixed: individual eligible-file retirement, live-process checks, concurrent-start protection, fresh handoff retention, actionable I/O failures. No live repository cleanup was run. |
| P1 | Generic contracts required report-only roles to modify, commit, and merge | Fixed: task-conditional duties, report-only `reviewed`, authorized external read-only inspection, assigned-tree writes, director integration ownership. |
| P1 | Lifecycle handoff and report races | Integrated accumulated lifecycle corrections; added transactional command relay recovery and closed the log progress-to-watcher gap. |
| P1 follow-up | User dial unexpectedly reverted | Confirmed whole-map stale-writer hazard in temporary fixtures. Exact historical cause unproven. Proposed migration rejected for release; see below. |
| P2 | Partial command reports obscured nonzero exits; full reports were hard to find | Fixed: preserve stdout and failure status/cause; explicit full-report retrieval and bounded-preview warning. |
| P2 | Hosts tried to send messages to command executors | Guidance now states there is no live inbox and explains a new dispatch using a retained isolated branch. No daemon or inbox was added. |
| P2 | Shared-tree ignored-file warning falsely implied checkout deletion | Fixed: distinguish retained shared checkout from eligible Fadeno scratch. |
| Release | Codex metadata schema and npm plugin runtime omissions | Fixed source metadata, included all three plugin runtime bundles in npm files, and used the existing runtime-copy helper in the Claude generator. |

## Dial investigation and rejected proposal

An unrelated archetype update can overwrite a newer worker dial when it writes
an older whole-map snapshot. A fixture reproduced `worker: opus -> union-alpha`.
This is a plausible explanation for September 17, but neither feedback nor the
available command evidence establishes the historical writer or interleaving.
Cleanup and host-mode hooks do not write/remove user dials.

Worker proposal `77aa5e0` on `fadeno/dial_persistence_audit` switches to keyed
files. It is retained as research and **not integrated**. Independent review
reproduced migration restoring a cleared stale worker value, old/new clients
ignoring each other's writes, a read transition returning no dials, and deletion
of a corrupt legacy source. The added sequential test does not establish
concurrency safety. A replacement needs deterministic multiprocess migration,
reader/writer, clear, corruption, and mixed-version tests before acceptance.

Full reports remain available through:

- `fadeno dispatches --output dial_persistence_audit`
- `fadeno dispatches --output dial_storage_review`

## Basanos-owned work

Evidence-ID allocation, shared build environments and artifacts, disk usage,
verification commands incompatible with live/offline prerequisites, and a live
application in a retained closed worktree are project/process issues. They need
Basanos-specific ownership, rather than broad
provider disabling or new Fadeno orchestration machinery.

## Validation and release scope

The integrated suite passed 430/430 tests with zero skips. After the final
packaging correction, all 16 plugin tests (including drift and generated launcher
execution), typecheck, and unpacked-package generation/runtime checks for Claude,
Codex, and omp passed. Codex schema validation passed. Interrupted exploratory
runs and failed intermediate packaging attempts are not counted as passes.

All three plugins were rebuilt at 0.7.0. Codex was locally reinstalled with cache
version `0.7.0+codex.20260919192307`; a fresh thread is required to load the new
skills and hooks. The CLI and installed private launcher report 0.7.0. Public
release is prepared as `.fadeno/releases/0.7.0/fadeno-0.7.0.tgz`; nothing was
published and no tag was pushed. All dispatches opened for this work are closed.
