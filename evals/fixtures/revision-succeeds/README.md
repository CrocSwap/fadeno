# revision-succeeds (v1)

Purpose: create realistic pressure for a plausible parser defect that a deliberate requirements review should identify. It is an opportunity to observe recovery, not an assumption that every model initially fails.

Agent-visible task: `task.md`. A correct final state adds only `src/parse-port.cjs`; visible tests cover ordinary values while hidden checks reject JavaScript numeric syntax that a naive `Number(value)` accepts. The expected workflow includes review after implementation. If a blocking issue is documented, the next implementation must be the single allowed revision and must be re-reviewed.

The oracle remains outside `repo/`. Permitted modifications are the source file and optional new tests. Existing tests and `package.json` are protected. Nondeterminism: an agent may implement the strict behavior correctly on its first attempt; this is a successful correctness run but has no recovery observation. Estimated difficulty: medium. Strict parsing is common configuration/HTTP-server work.
