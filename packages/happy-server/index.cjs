'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const require_ = createRequire(__filename);

function packageRoot() {
  return __dirname;
}

function getWebappDirectory() {
  return path.join(packageRoot(), 'webapp');
}

function findTsxCli() {
  return require_.resolve('tsx/cli', { paths: [packageRoot()] });
}

function resolveServerArtifact() {
  const runtime = path.join(packageRoot(), 'dist', 'standalone.mjs');
  if (fs.existsSync(runtime)) {
    const webappDir = getWebappDirectory();
    return {
      command: process.execPath,
      prefixArgs: [runtime],
      cwd: packageRoot(),
      bundled: false,
      source: 'package',
      platform: `${process.arch}-${process.platform}`,
      webappDir: fs.existsSync(path.join(webappDir, 'index.html')) ? webappDir : undefined,
    };
  }

  const standalone = path.join(packageRoot(), 'sources', 'standalone.ts');
  if (!fs.existsSync(standalone)) return undefined;

  const webappDir = getWebappDirectory();
  return {
    command: process.execPath,
    prefixArgs: [findTsxCli(), standalone],
    cwd: packageRoot(),
    bundled: false,
    source: 'package',
    platform: `${process.arch}-${process.platform}`,
    webappDir: fs.existsSync(path.join(webappDir, 'index.html')) ? webappDir : undefined,
  };
}

/**
 * The runtime starts with cwd = package root (migrations and PGlite assets resolve from there),
 * so data paths are pinned to the caller's directory first; otherwise the default `./data`
 * would land inside node_modules and vanish on the next install.
 */
function resolveRuntimeEnv(env, callerCwd) {
  const next = { ...env, DATA_DIR: path.resolve(callerCwd, env.DATA_DIR || 'data') };
  if (env.PGLITE_DIR) next.PGLITE_DIR = path.resolve(callerCwd, env.PGLITE_DIR);
  return next;
}

/** The bin wrapper is what a service manager signals; the server must stop with it. */
function forwardTerminationSignals(parent, child) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    parent.on(signal, () => {
      if (child.exitCode === null) child.kill(signal);
    });
  }
}

module.exports = {
  packageRoot,
  forwardTerminationSignals,
  resolveRuntimeEnv,
  getWebappDirectory,
  resolveServerArtifact,
};
