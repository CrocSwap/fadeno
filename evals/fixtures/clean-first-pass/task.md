# Task: add label normalization

Add `src/normalize-label.cjs` exporting `normalizeLabel(value)`.

- `null` and `undefined` return `""`.
- Other values are converted with `String(value)`.
- Trim surrounding whitespace, lowercase ASCII letters, replace each run of non-alphanumeric characters with one `-`, then remove leading/trailing `-`.
- Do not add dependencies or edit `package.json`.
- Run `npm test`.

You may add focused tests, but do not edit the existing test file.
