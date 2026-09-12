import { describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { prepareManagedScriptRuntime, recoverManagedScriptContainers } from './managedScriptRuntime';
const docker = promisify(execFile);
describe.runIf(process.env.HAPPY_SCRIPT_DOCKER_TESTS === '1')('managed script runtime recovery', () => {
  it('enforces the script deadline even if the daemon process is killed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'script-watchdog-test-'));
    const ownerId = randomBytes(32).toString('hex');
    const image = (await docker('docker', ['image', 'inspect', 'node:24-alpine', '--format', '{{.Id}}'])).stdout.trim();
    const source = 'setInterval(()=>{},1000)';
    const program = `import {createHash} from 'node:crypto';import {runManagedScript} from ${JSON.stringify(resolve('src/daemon/automations/managedScriptRunner.ts'))};
const source=${JSON.stringify(source)};runManagedScript({runId:'watchdog',source,ownerId:${JSON.stringify(ownerId)},temporaryRoot:${JSON.stringify(directory)},image:${JSON.stringify(image)},input:{},secrets:{},
action:{kind:'script',runtime:'node',artifactId:'test',digest:createHash('sha256').update(source).digest('hex'),entrypoint:'run.mjs',args:[],timeoutSeconds:2,secretRefs:{},allowedOrigins:[]}}).catch(()=>process.exit(1));`;
    const programPath = join(directory, 'daemon.ts');
    await writeFile(programPath, program);
    const require = createRequire(resolve('package.json'));
    const child = spawn(process.execPath, ['--import', require.resolve('tsx'), programPath], { stdio: 'ignore' });
    try {
      let container = '';
      for (let attempt = 0; attempt < 80 && !container; attempt++) {
        container = (await docker('docker', ['ps', '-q', '--filter', `label=happy.script.owner=${ownerId}`])).stdout.trim();
        if (!container) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(container).not.toBe('');
      child.kill('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect((await docker('docker', ['inspect', container, '--format', '{{.State.Running}}'])).stdout.trim()).toBe('false');
    } finally {
      child.kill('SIGKILL');
      await recoverManagedScriptContainers({ ownerId, directory });
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
  it('proves isolation before advertising support and recovers only resources owned by this runner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'script-runtime-test-'));
    const ownerId = randomBytes(32).toString('hex');
    const other = randomBytes(32).toString('hex');
    const image = (await docker('docker', ['image', 'inspect', 'node:24-alpine', '--format', '{{.Id}}'])).stdout.trim();
    const created: string[] = [];
    try {
      await expect(prepareManagedScriptRuntime({ ownerId, directory, image: 'node:latest' })).rejects.toThrow('IMMUTABLE_IMAGE_REQUIRED');
      await prepareManagedScriptRuntime({ ownerId, directory, image });
      for (const owner of [ownerId, other]) {
        const id = (await docker('docker', ['run', '-d', '--label', `happy.script.owner=${owner}`, image, 'node', '-e', 'setInterval(()=>{},1000)'])).stdout.trim();
        created.push(id);
      }
      await docker('docker', ['network', 'create', '--label', `happy.script.owner=${ownerId}`, `script-test-${ownerId}`]);
      await mkdir(join(directory, 'happy-script-leftover'));
      await writeFile(join(directory, 'happy-script-leftover', 'env.json'), 'sensitive');
      await recoverManagedScriptContainers({ ownerId, directory });
      expect((await docker('docker', ['ps', '-aq', '--filter', `label=happy.script.owner=${ownerId}`])).stdout.trim()).toBe('');
      expect((await docker('docker', ['ps', '-q', '--filter', `label=happy.script.owner=${other}`])).stdout.trim()).not.toBe('');
      expect((await docker('docker', ['network', 'ls', '-q', '--filter', `label=happy.script.owner=${ownerId}`])).stdout.trim()).toBe('');
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await Promise.allSettled(created.map((id) => docker('docker', ['rm', '-f', id])));
      await docker('docker', ['network', 'rm', `script-test-${ownerId}`]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
