#!/usr/bin/env node

// Fail an install immediately when this package declares bundledDependencies
// that are not actually present, instead of letting the CLI crash later at
// import time with an opaque ERR_MODULE_NOT_FOUND. npm never installs
// declared bundled dependencies from the registry — if they are missing from
// the artifact, the install is unrecoverable and must be reported loudly.
//
// The required set is derived from this package's own manifest so it cannot
// drift from what prepare-publish-package.cjs actually bundles. In a
// development checkout the only declared bundled dependency
// (@slopus/happy-wire) is a pnpm workspace link, so the same check passes
// there without a dev-mode special case.

const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const declared = manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
const bundled = Array.isArray(declared) ? declared : [];

const missing = bundled.filter(
    (name) => !fs.existsSync(path.join(packageRoot, 'node_modules', ...name.split('/'), 'package.json'))
);

if (missing.length > 0) {
    console.error(
        [
            '@namsangboy/happy-cli: this npm artifact is broken — package.json',
            'declares bundledDependencies that the artifact does not contain:',
            '',
            ...missing.map((name) => `  missing node_modules/${name}`),
            '',
            'npm will not install these from the registry, so the CLI cannot run.',
            'Install a known-good version (e.g. the previous release) and report',
            'the broken version so it can be deprecated and republished through',
            'the happy-cli-v* tag workflow.'
        ].join('\n')
    );
    process.exit(1);
}
