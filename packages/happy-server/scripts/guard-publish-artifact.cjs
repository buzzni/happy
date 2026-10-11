#!/usr/bin/env node
'use strict';

// Checks the exact tarball that will be published (specs/headless-standalone-server T8).
//
//   node scripts/guard-publish-artifact.cjs <tarball> [--install-smoke]
//
// --install-smoke installs it into an empty directory with npm, then from an unrelated cwd
// runs migrate, serve on loopback, waits for /health and signs in once — the path a
// headless `saycode server` takes. On Linux it needs openssl for Prisma's engine choice.

const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REQUIRED_ENTRIES = ['package/package.json', 'package/bin/happy-server.cjs', 'package/index.cjs', 'package/dist/standalone.mjs', 'package/prisma/schema.prisma'];

function fail(message) {
  throw new Error(`guard: ${message}`);
}

function checkTarball(tarball) {
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n');
  for (const required of REQUIRED_ENTRIES) if (!entries.includes(required)) fail(`missing ${required}`);
  if (!entries.some((entry) => entry.startsWith('package/prisma/migrations/'))) fail('missing prisma migrations');
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  if (manifest.name !== '@buzzni/happy-server') fail(`unexpected package name ${manifest.name}`);
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (/^(workspace:|file:|link:|portal:)/.test(String(spec))) fail(`unpublishable dependency ${name}@${spec}`);
  }
  return manifest;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`serve exited early with code ${child.exitCode}`);
    try {
      if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`no healthy response within ${timeoutMs}ms`);
}

async function signIn(url) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const challenge = crypto.randomBytes(32);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const body = {
    publicKey: raw.toString('base64'),
    challenge: challenge.toString('base64'),
    signature: crypto.sign(null, challenge, privateKey).toString('base64'),
  };
  const response = await fetch(`${url}/v1/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const json = await response.json().catch(() => ({}));
  if (response.status !== 200 || typeof json.token !== 'string') fail(`sign-in failed with ${response.status}`);
}

async function installSmoke(tarball) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'happy-server-guard-'));
  const installDir = path.join(work, 'install');
  const callerDir = path.join(work, 'elsewhere');
  fs.mkdirSync(installDir);
  fs.mkdirSync(callerDir);
  let serve;
  try {
    fs.writeFileSync(path.join(installDir, 'package.json'), '{"name":"guard","private":true}\n');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', path.resolve(tarball)], { cwd: installDir, stdio: 'inherit' });
    const bin = path.join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? 'happy-server.cmd' : 'happy-server');
    const port = await freePort();
    const env = { ...process.env, HANDY_MASTER_SECRET: crypto.randomBytes(32).toString('hex'), DATA_DIR: 'data', HOST: '127.0.0.1', PORT: String(port) };
    execFileSync(bin, ['migrate'], { cwd: callerDir, env, stdio: 'inherit' });
    if (!fs.existsSync(path.join(callerDir, 'data'))) fail('relative DATA_DIR did not resolve against the caller directory');
    serve = spawn(bin, ['serve'], { cwd: callerDir, env, stdio: 'inherit' });
    const url = `http://127.0.0.1:${port}`;
    await waitForHealth(url, serve, 90_000);
    await signIn(url);
    console.log(`guard: install smoke passed on node ${process.version} ${process.platform}-${process.arch}`);
  } finally {
    if (serve && serve.exitCode === null) {
      // Through the bin wrapper on purpose: this also proves the stop signal reaches the server.
      const exited = new Promise((resolve) => serve.once('exit', resolve));
      serve.kill('SIGTERM');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      if (serve.exitCode === null && serve.signalCode === null) fail('serve did not stop after SIGTERM');
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const tarball = process.argv[2];
  if (!tarball || !fs.existsSync(tarball)) fail('usage: guard-publish-artifact.cjs <tarball> [--install-smoke]');
  const manifest = checkTarball(tarball);
  console.log(`guard: ${manifest.name}@${manifest.version} tarball ok`);
  if (process.argv.includes('--install-smoke')) await installSmoke(tarball);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
