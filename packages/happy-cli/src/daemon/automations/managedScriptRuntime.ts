import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runManagedScript } from './managedScriptRunner';
const exec = promisify(execFile);
const docker = (args: string[]) => exec('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024 });
type Owner = { ownerId: string; directory: string };

export async function recoverManagedScriptContainers(input: Owner) {
  if (!/^[a-f0-9]{64}$/.test(input.ownerId)) throw new Error('SCRIPT_OWNER_INVALID');
  const filter = `label=happy.script.owner=${input.ownerId}`;
  const containers = (await docker(['ps', '-aq', '--filter', filter])).stdout.trim().split(/\s+/).filter(Boolean);
  if (containers.length) await docker(['rm', '--force', ...containers]);
  const networks = (await docker(['network', 'ls', '-q', '--filter', filter])).stdout.trim().split(/\s+/).filter(Boolean);
  for (const network of networks) await docker(['network', 'rm', network]);
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  // This root is dedicated to the owner. Source/secret remnants are removed only
  // after every labelled container and network has been successfully removed.
  for (const name of await readdir(input.directory)) {
    if (name.startsWith('happy-script-')) await rm(join(input.directory, name), { recursive: true, force: true });
  }
}

export async function prepareManagedScriptRuntime(input: Owner & { image: string }) {
  if (!/^(?:sha256:|[\w./:-]+@sha256:)[a-f0-9]{64}$/.test(input.image)) throw new Error('IMMUTABLE_IMAGE_REQUIRED');
  if ((await docker(['info', '--format', '{{.OSType}}'])).stdout.trim() !== 'linux') throw new Error('SCRIPT_LINUX_RUNTIME_REQUIRED');
  await recoverManagedScriptContainers(input);
  const source = `import fs from 'node:fs';
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<24||(major===24&&minor<5)||process.getuid()!==65534)throw Error('unsupported runtime');
if(fs.existsSync('/var/run/docker.sock')||fs.existsSync('/root/.happy'))throw Error('host mounted');
let readonly=false;try{fs.writeFileSync('/script-isolation-probe','x')}catch(e){readonly=e.code==='EROFS'||e.code==='EACCES'}
if(!readonly)throw Error('writable root');
console.log('SCRIPT_RUNTIME_READY');`;
  const result = await runManagedScript({ runId: 'runtime-preflight', source, ownerId: input.ownerId, temporaryRoot: input.directory,
    image: input.image, input: {}, secrets: {}, action: { kind: 'script', runtime: 'node', artifactId: 'runtime-preflight',
      digest: createHash('sha256').update(source).digest('hex'), entrypoint: 'probe.mjs', args: [], timeoutSeconds: 10,
      secretRefs: {}, allowedOrigins: ['https://example.invalid'] } });
  if (result.exitCode !== 0 || result.failureCode || result.log.trim() !== 'SCRIPT_RUNTIME_READY') throw new Error('SCRIPT_RUNTIME_PREFLIGHT_FAILED');
}
