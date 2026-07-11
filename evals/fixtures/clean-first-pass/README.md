# clean-first-pass (v1)

Purpose: expose overhead or regression on a straightforward but nontrivial utility change. The repository starts with a normal Node test setup and no dependencies beyond Node.

Agent-visible task: `task.md`. Successful work adds only `src/normalize-label.cjs` and satisfies visible and hidden behavior. The expected workflow is a proportionate plan, implementation, review, and test; a revision is not intrinsically required.

Hidden checks cover coercion, whitespace, punctuation collapse, and empty/null values. No oracle file is copied to `repo/`. Permitted modifications are `src/normalize-label.cjs` and optional new tests; `package.json` and existing tests should remain untouched. Nondeterminism is limited to implementation style. Estimated difficulty: low. This resembles a common utility addition where ceremony may cost more than it returns.
