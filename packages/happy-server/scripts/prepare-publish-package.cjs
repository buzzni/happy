#!/usr/bin/env node
'use strict';

// Builds the directory that becomes the @buzzni/happy-server npm artifact
// (aplus-dev-studio-desktop specs/headless-standalone-server T8). GitHub Actions is the only
// publisher; run locally only to inspect or smoke-test the artifact.
//
//   node scripts/prepare-publish-package.cjs --out <dir>

const fs = require('node:fs');
const path = require('node:path');

const PUBLISHED_NAME = '@buzzni/happy-server';
// Workspace packages the runtime bundle inlines (scripts/build-runtime.cjs) and the marker
// esbuild/bun leaves in dist/standalone.mjs proving it did.
const BUNDLED_WORKSPACE_DEPENDENCIES = { '@slopus/happy-wire': '../happy-wire/dist/' };
const UNPUBLISHABLE_SPEC = /^(workspace:|file:|link:|portal:)/;

function publishManifest(source, distContents) {
  const dependencies = {};
  for (const [name, spec] of Object.entries(source.dependencies ?? {})) {
    if (name in BUNDLED_WORKSPACE_DEPENDENCIES) {
      if (!distContents.includes(BUNDLED_WORKSPACE_DEPENDENCIES[name])) {
        throw new Error(`${name} is not bundled into dist/standalone.mjs; run scripts/build-runtime.cjs first`);
      }
      continue;
    }
    if (UNPUBLISHABLE_SPEC.test(String(spec))) throw new Error(`dependency ${name}@${spec} cannot be installed from the registry`);
    dependencies[name] = spec;
  }
  const scripts = source.scripts?.postinstall ? { postinstall: source.scripts.postinstall } : undefined;
  const manifest = { ...source, name: PUBLISHED_NAME, dependencies, publishConfig: { access: 'public' } };
  delete manifest.devDependencies;
  delete manifest.scripts;
  if (scripts) manifest.scripts = scripts;
  return manifest;
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1] ?? '') : '';
  if (!out) throw new Error('usage: prepare-publish-package.cjs --out <dir>');
  const root = path.resolve(__dirname, '..');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dist = path.join(root, 'dist', 'standalone.mjs');
  if (!fs.existsSync(dist)) throw new Error('dist/standalone.mjs is missing; run scripts/build-runtime.cjs first');
  const manifest = publishManifest(source, fs.readFileSync(dist, 'utf8'));

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const entry of source.files ?? []) {
    if (entry === 'package.json') continue;
    const from = path.join(root, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(out, entry), { recursive: true });
  }
  for (const required of ['bin/happy-server.cjs', 'index.cjs', 'dist/standalone.mjs', 'prisma/schema.prisma', 'prisma/migrations']) {
    if (!fs.existsSync(path.join(out, required))) throw new Error(`publish artifact is missing ${required}`);
  }
  fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`prepared ${manifest.name}@${manifest.version} in ${out}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

module.exports = { publishManifest };
