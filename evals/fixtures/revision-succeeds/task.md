# Task: add strict port parsing

Add `src/parse-port.cjs` exporting `parsePort(value)`.

- Accept a finite integer number, or a string of decimal digits with surrounding whitespace.
- Return an integer from 1 through 65535 inclusive.
- Reject all other values by throwing `TypeError`, including `"080"` only if it is not interpreted as decimal (it **is** valid decimal), signs, decimal points, exponent notation, hexadecimal notation, booleans, empty strings, and out-of-range values.
- Do not add dependencies or edit `package.json`.
- Run `npm test`.

You may add focused tests, but do not edit the existing test file.
