#!/usr/bin/env node

// Fail a registry install immediately when the tarball is missing its bundled
// dependencies, instead of letting the CLI crash later at import time with an
// opaque ERR_MODULE_NOT_FOUND. package.json declares bundledDependencies, so
// npm never installs these from the registry — if they are not inside the
// tarball, the install is unrecoverable and must be reported loudly.

const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');

// Development checkouts (pnpm workspace) carry src/ and resolve
// @slopus/happy-wire through workspace links; the published artifact ships
// only dist/bin/scripts/tools. Only enforce on the published layout.
if (fs.existsSync(path.join(packageRoot, 'src'))) {
    process.exit(0);
}

const REQUIRED_BUNDLED_FILES = [
    'node_modules/@slopus/happy-wire/package.json',
    'node_modules/@slopus/happy-wire/dist/index.mjs',
    'node_modules/@paralleldrive/cuid2/package.json',
    'node_modules/@noble/hashes/package.json',
    'node_modules/zod/package.json'
];

const missing = REQUIRED_BUNDLED_FILES.filter(
    (file) => !fs.existsSync(path.join(packageRoot, file))
);

if (missing.length > 0) {
    console.error(
        [
            '@namsangboy/happy-cli: this npm artifact is broken — it declares',
            'bundledDependencies but the tarball does not contain them:',
            '',
            ...missing.map((file) => `  missing ${file}`),
            '',
            'npm will not install these from the registry, so the CLI cannot run.',
            'Install a known-good version (e.g. the previous release) and report',
            'the broken version so it can be deprecated and republished through',
            'the happy-cli-v* tag workflow.'
        ].join('\n')
    );
    process.exit(1);
}
