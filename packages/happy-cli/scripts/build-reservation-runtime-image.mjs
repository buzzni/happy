#!/usr/bin/env node
// Build a local immutable native runtime from pinned, integrity-checked archives. Never pushes an image.
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyArchive(bytes, integrity) {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error('RUNTIME_INTEGRITY_INVALID');
  const expected = Buffer.from(integrity.slice(7), 'base64'), actual = createHash('sha512').update(bytes).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('RUNTIME_INTEGRITY_MISMATCH');
}
export function validateProfile(profile, arch) {
  const artifacts = profile.artifacts?.[arch];
  if (profile.version !== 1 || !/^node:[\w.-]+@sha256:[a-f0-9]{64}$/.test(profile.baseImage)
    || !['arm64', 'amd64'].includes(arch) || !artifacts || ['nodeVersion', 'claudeVersion', 'codexVersion'].some(key => !/^\d+\.\d+\.\d+$/.test(profile[key]))) throw new Error('RUNTIME_PROFILE_INVALID');
  for (const artifact of [artifacts.claude, artifacts.codex]) {
    if (!artifact || !/^@(anthropic-ai|openai)\/[\w-]+$/.test(artifact.package) || !/^[\d.]+(?:-linux-(?:x64|arm64))?$/.test(artifact.version)
      || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(artifact.integrity)) throw new Error('RUNTIME_PROFILE_INVALID');
  }
  return artifacts;
}
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 300_000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr ?? '').slice(-2000)}`);
  return result.stdout?.trim() ?? '';
};
async function archive(artifact, directory, name) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(artifact.package)}/${encodeURIComponent(artifact.version)}`;
  const metadata = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!metadata.ok) throw new Error('RUNTIME_REGISTRY_UNAVAILABLE');
  const value = await metadata.json();
  const tarball = new URL(value.dist?.tarball);
  if (value.name !== artifact.package || value.version !== artifact.version || value.dist?.integrity !== artifact.integrity
    || tarball.origin !== 'https://registry.npmjs.org') throw new Error('RUNTIME_REGISTRY_IDENTITY_MISMATCH');
  const response = await fetch(tarball, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 512 * 1024 * 1024) throw new Error('RUNTIME_ARCHIVE_UNAVAILABLE');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 512 * 1024 * 1024) throw new Error('RUNTIME_ARCHIVE_TOO_LARGE');
  verifyArchive(bytes, artifact.integrity);
  const file = join(directory, name + '.tgz'); await writeFile(file, bytes);
  const entries = run('tar', ['-tzf', file]).split('\n');
  if (entries.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..'))) throw new Error('RUNTIME_ARCHIVE_PATH_INVALID');
  const destination = join(directory, name); await mkdir(destination);
  run('tar', ['-xzf', file, '--strip-components=1', '-C', destination]);
  return { package: artifact.package, version: artifact.version, integrity: artifact.integrity, sha256: sha(bytes) };
}
export async function build(args) {
  const arch = args.arch ?? (process.arch === 'arm64' ? 'arm64' : 'amd64');
  if (!args.output || !resolve(args.output).startsWith('/') || existsSync(resolve(args.output))) throw new Error('RUNTIME_OUTPUT_MUST_BE_NEW');
  const profileBytes = await readFile(join(packageRoot, 'reservation-runtime', 'profile.json'));
  const profile = JSON.parse(profileBytes), artifacts = validateProfile(profile, arch), output = resolve(args.output);
  // An explicitly cached base is required. Do not hide a pull in a build.
  run('docker', ['image', 'inspect', profile.baseImage]);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const context = join(output, 'context'); await mkdir(context);
  const archives = {};
  for (const name of ['claude', 'codex']) archives[name] = await archive(artifacts[name], context, name);
  await copyFile(join(packageRoot, 'reservation-runtime', 'Dockerfile'), join(context, 'Dockerfile'));
  const imageFile = join(output, 'image-id');
  run('docker', ['build', '--pull=false', '--network=none', '--platform', `linux/${arch}`, '--build-arg', `BASE_IMAGE=${profile.baseImage}`,
    '--label', `happy.reservation.profile=${sha(profileBytes)}`, '--iidfile', imageFile, context]);
  const image = (await readFile(imageFile, 'utf8')).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('RUNTIME_IMAGE_ID_INVALID');
  const versions = run('docker', ['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--tmpfs', '/tmp:rw,nosuid,size=16m', '--entrypoint', 'sh', image, '-c', 'node --version\nclaude --version\ncodex --version']);
  if (!versions.includes(`v${profile.nodeVersion}`) || !versions.includes(profile.claudeVersion) || !versions.includes(`codex-cli ${profile.codexVersion}`)) throw new Error('RUNTIME_IMAGE_VERSION_MISMATCH');
  const receipt = { version: 1, kind: 'reservation-native-image', localOnly: true, platform: 'linux', arch, image, baseImage: profile.baseImage,
    profileSha256: sha(profileBytes), dockerfileSha256: sha(await readFile(join(context, 'Dockerfile'))), archives, versions };
  await writeFile(join(output, 'runtime-image.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]; if (!['--output', '--arch'].includes(key) || !process.argv[index + 1]) throw new Error('Use --output <new directory> [--arch arm64|amd64]');
    args[key.slice(2)] = process.argv[index + 1];
  }
  console.log(JSON.stringify(await build(args), null, 2));
}
