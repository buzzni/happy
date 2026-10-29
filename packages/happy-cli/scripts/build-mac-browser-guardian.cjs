const { spawnSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const { join, dirname } = require('node:path');
if (process.platform !== 'darwin') throw new Error('macOS toolchain required');
const root = join(__dirname, '..');
const target = join(root, 'native', `darwin-${process.arch}`, 'browser-guardian');
mkdirSync(dirname(target), { recursive: true });
const built = spawnSync('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  join(root, 'native/macBrowserGuardian.c'), '-o', target], { stdio: 'inherit' });
process.exitCode = built.status ?? 1;
