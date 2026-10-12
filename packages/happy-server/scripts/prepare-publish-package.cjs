#!/usr/bin/env node
'use strict';

// Builds the directory that becomes the @buzzni/happy-server npm artifact
// (aplus-dev-studio-desktop specs/headless-standalone-server T8). GitHub Actions is the only
// publisher; run locally only to inspect or smoke-test the artifact.
//
//   node scripts/prepare-publish-package.cjs --out <dir> [--version <semver>]
//
// @buzzni/happy-server has its own version line (first release 0.1.0): package.json keeps
// the upstream happy version so upstream merges stay clean. The release tag supplies
// --version; without it the artifact carries package.json's version, for local inspection.

const fs = require('node:fs');
const path = require('node:path');

const PUBLISHED_NAME = '@buzzni/happy-server';
// npm provenance rejects a package whose repository.url differs from the repository that
// built it; package.json keeps upstream's slopus/happy so upstream merges stay clean.
const PUBLISHED_REPOSITORY = {
  repository: { type: 'git', url: 'git+https://github.com/buzzni/happy.git', directory: 'packages/happy-server' },
  homepage: 'https://github.com/buzzni/happy',
  bugs: 'https://github.com/buzzni/happy/issues',
};
// Workspace packages the runtime bundle inlines (scripts/build-runtime.cjs) and the marker
// esbuild/bun leaves in dist/standalone.mjs proving it did.
const BUNDLED_WORKSPACE_DEPENDENCIES = { '@slopus/happy-wire': '../happy-wire/dist/' };
const UNPUBLISHABLE_SPEC = /^(workspace:|file:|link:|portal:)/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function publishManifest(source, distContents, version = source.version) {
  if (!SEMVER.test(String(version))) throw new Error(`publish version must be semver like 0.1.0, got ${version}`);
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
  const manifest = { ...source, ...PUBLISHED_REPOSITORY, name: PUBLISHED_NAME, version, dependencies, publishConfig: { access: 'public' } };
  delete manifest.devDependencies;
  delete manifest.scripts;
  if (scripts) manifest.scripts = scripts;
  return manifest;
}

function main() {
  const outIndex = process.argv.indexOf('--out');
  const out = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1] ?? '') : '';
  if (!out) throw new Error('usage: prepare-publish-package.cjs --out <dir> [--version <semver>]');
  const versionIndex = process.argv.indexOf('--version');
  const version = versionIndex >= 0 ? process.argv[versionIndex + 1] ?? '' : undefined;
  const root = path.resolve(__dirname, '..');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dist = path.join(root, 'dist', 'standalone.mjs');
  if (!fs.existsSync(dist)) throw new Error('dist/standalone.mjs is missing; run scripts/build-runtime.cjs first');
  const manifest = publishManifest(source, fs.readFileSync(dist, 'utf8'), version);

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const entry of source.files ?? []) {
    if (entry === 'package.json') continue;
    const from = path.join(root, entry);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(out, entry), { recursive: true });
  }
  for (const required of ['bin/happy-server.cjs', 'index.cjs', 'dist/standalone.mjs', 'prisma/schema.prisma', 'prisma/migrations', 'webapp/index.html']) {
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
