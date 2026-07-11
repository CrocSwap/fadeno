# Task: add retry-delay calculation

Add `src/retry-delay.cjs` exporting `getRetryDelay(attempt, baseMs)`.

- Both inputs must be finite integers; `attempt` is at least 0 and `baseMs` is greater than 0. Invalid inputs throw `TypeError`.
- Return exponential backoff `baseMs * 2 ** attempt`, capped at 30000 milliseconds.
- Do not add dependencies or edit `package.json`.
- Run `npm test`.

You may add focused tests, but do not edit the existing test file.
