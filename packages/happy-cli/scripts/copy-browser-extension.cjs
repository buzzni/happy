#!/usr/bin/env node

/**
 * Copies the Chrome extension's shippable files into packages/happy-cli/
 * browser-extension/ so they travel inside the published happy-cli npm
 * package (via package.json "files").
 *
 * Without this, `happy browser`'s install instructions point at
 * ../happy-browser-extension, which only exists in the monorepo — an
 * installed happy-cli has no sibling packages, so that folder is missing
 * and the printed path is a dead end. See browser.ts's resolveExtensionDir.
 *
 * The file list is read from happy-browser-extension/shipped-files.json —
 * the same list scripts/package.mjs there zips up — so there is one place
 * that says what a packed extension contains, not two that can drift apart.
 */

const fs = require('fs');
const path = require('path');

const cliDir = path.resolve(__dirname, '..');
const extensionSourceDir = path.resolve(cliDir, '..', 'happy-browser-extension');
const destinationDir = path.join(cliDir, 'browser-extension');

const shippedFiles = JSON.parse(
    fs.readFileSync(path.join(extensionSourceDir, 'shipped-files.json'), 'utf8')
);

const missing = shippedFiles.filter(
    (file) => !fs.existsSync(path.join(extensionSourceDir, file))
);
if (missing.length > 0) {
    console.error(`Refusing to bundle the browser extension — missing files:\n  ${missing.join('\n  ')}`);
    process.exit(1);
}

fs.rmSync(destinationDir, { force: true, recursive: true });
fs.mkdirSync(destinationDir, { recursive: true });

for (const file of shippedFiles) {
    const destination = path.join(destinationDir, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(extensionSourceDir, file), destination);
}

console.log(`Bundled ${shippedFiles.length} browser extension files into ${path.relative(cliDir, destinationDir)}`);
