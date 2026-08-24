#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { join, dirname, resolve } from 'path';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliArgs = process.argv.slice(2);

if (cliArgs[0] === 'agent') {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@buzzni/saycode-cli/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const saycodeBin = manifest.bin?.saycode;

  if (typeof saycodeBin !== 'string') {
    console.error('Bundled @buzzni/saycode-cli does not declare the saycode binary.');
    process.exit(1);
  }

  const entrypoint = resolve(dirname(manifestPath), saycodeBin);
  try {
    execFileSync(process.execPath, [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      'agent',
      ...cliArgs.slice(1)
    ], {
      stdio: 'inherit',
      env: process.env
    });
  } catch (error) {
    process.exit(error.status || 1);
  }
  process.exit(0);
}

if (cliArgs.length === 1 && (cliArgs[0] === '--version' || cliArgs[0] === '-v')) {
  const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  console.log(`happy version: ${packageJson.version}`);
  process.exit(0);
}

// Check if we're already running with the flags
const hasNoWarnings = process.execArgv.includes('--no-warnings');
const hasNoDeprecation = process.execArgv.includes('--no-deprecation');

if (!hasNoWarnings || !hasNoDeprecation) {
  // Get path to the actual CLI entrypoint
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');
  
  // Execute the actual CLI directly with the correct flags
  try {
    execFileSync(process.execPath, [
      '--no-warnings',
      '--no-deprecation',
      entrypoint,
      ...cliArgs
    ], {
      stdio: 'inherit',
      env: process.env
    });
  } catch (error) {
    // execFileSync throws if the process exits with non-zero
    process.exit(error.status || 1);
  }
} else {
  // We're running Node with the flags we wanted, import the CLI entrypoint
  // module to avoid creating a new process.
  import("../dist/index.mjs");
}
