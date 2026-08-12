#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { join, resolve } = require('node:path');

const pluginRoot = resolve(__dirname, '../../..');
const binDir = join(pluginRoot, 'bin');
const result = spawnSync(process.execPath, [join(binDir, 'fadeno'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    FADENO_BUNDLED_RUNTIME: binDir,
    FADENO_INVOCATION_SOURCE: 'plugin',
    FADENO_HARNESS: '__FADENO_HARNESS__',
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
