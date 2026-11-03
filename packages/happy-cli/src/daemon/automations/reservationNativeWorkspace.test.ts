import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProjectPath } from '@/claude/utils/path';
import { createServer } from 'node:http';
import { ReservationNativeContainers } from './reservationNativeContainer';
import { reservationMonotonicNow } from './reservationMonotonicClock';
import { prepareReservationNativeNetwork, prepareReservationNativeWorkspace } from './reservationNativeWorkspace';
import type { ReservationTurnDescriptor } from './reservationConversationTurn';
const roots: string[] = [], exec = promisify(execFile), nativeId = '12345678-1234-4234-8234-123456789abc';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reservation-state-'))); roots.push(root);
  const repo = join(root, 'repo'); await mkdir(repo);
  const git = (args: string[]) => exec('git', ['-C', repo, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  await git(['init']); await writeFile(join(repo, 'file'), 'original'); await git(['add', 'file']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'fixture']);
  await git(['config', 'credential.helper', '!echo raw-github-secret']);
  const sourceTranscript = join(root, `${nativeId}.jsonl`); await writeFile(sourceTranscript, JSON.stringify({ sessionId: nativeId }) + '\n');
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const descriptor: ReservationTurnDescriptor = { version: 1, automationId: 'a', generation: 1, runId: 'r', sessionId: 'same-chat', machineId: 'm', accountId: 'owner', agent: 'claude', baseDirectory: repo, executionDirectory: repo, writeMode: 'worktree', baseSha: head, headSha: head, connectorPolicy: 'none', requiredConnectors: [], credentialHandles: [] };
  return { root, repo, sourceTranscript, descriptor, nativeId, broker: { url: 'http://host.docker.internal:1234', token: 'opaque-run-only' }, model: 'model' };
}
it('copies only the selected transcript and shadows repository credential configuration with private metadata', async () => {
  const f = await fixture(), workspace = await prepareReservationNativeWorkspace({ ...f, root: join(f.root, 'private'), projectEnvironment: { APP_VALUE: 'kept', GH_TOKEN: 'raw-github-secret', ANTHROPIC_API_KEY: 'raw-ai-secret', APLUS_AGENT_TASK_TOKEN: 'raw-task-secret' } });
  const gitMount = workspace.mounts.find(mount => mount.target === join(f.repo, '.git'))!;
  expect(await readFile(join(gitMount.source, 'config'), 'utf8')).not.toContain('credential');
  expect(await readFile(workspace.envFile, 'utf8')).not.toContain('raw-');
  expect(await readFile(workspace.toolEnvFile, 'utf8')).toContain('APP_VALUE=kept');
  expect(await readFile(workspace.toolEnvFile, 'utf8')).not.toContain('raw-');
  const native = join(getProjectPath(f.repo, join(workspace.directory, 'home', '.claude')), `${nativeId}.jsonl`);
  await writeFile(native, await readFile(native, 'utf8') + JSON.stringify({ sessionId: nativeId, message: 'continued' }) + '\n');
  await workspace.commit(); expect(await readFile(f.sourceTranscript, 'utf8')).toContain('continued');
  expect(await readFile(join(f.repo, '.git', 'config'), 'utf8')).toContain('raw-github-secret');
  await workspace.close();
});
it('does not overwrite a native transcript changed by another writer', async () => {
  const f = await fixture(), workspace = await prepareReservationNativeWorkspace({ ...f, root: join(f.root, 'private') });
  await writeFile(f.sourceTranscript, 'new local conversation data');
  await expect(workspace.commit()).rejects.toThrow('RESERVATION_NATIVE_STATE_CHANGED');
  expect(await readFile(f.sourceTranscript, 'utf8')).toBe('new local conversation data'); await workspace.close();
});
it('rejects a moved worktree head or another native lineage before native execution', async () => {
  const f = await fixture();
  await expect(prepareReservationNativeWorkspace({ ...f, root: join(f.root, 'private'), descriptor: { ...f.descriptor, headSha: 'b'.repeat(40) } })).rejects.toThrow('RESERVATION_HEAD_CHANGED');
  await writeFile(f.sourceTranscript, JSON.stringify({ sessionId: 'foreign' }) + '\n');
  await expect(prepareReservationNativeWorkspace({ ...f, root: join(f.root, 'private') })).rejects.toThrow('RESERVATION_NATIVE_LINEAGE_MISMATCH');
});

it.skipIf(!process.env.RESERVATION_NATIVE_TEST_IMAGE)('keeps linked-worktree Git writes private and removes native and egress execution boundaries', async () => {
  const f = await fixture(), checkout = join(f.root, 'checkout');
  await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', f.repo, 'worktree', 'add', '--detach', checkout, 'HEAD']);
  const server = createServer((_request, response) => response.end('scoped-broker-fixture'));
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const port = (server.address() as { port: number }).port;
  const workspace = await prepareReservationNativeWorkspace({ ...f, root: join(f.root, 'private'), descriptor: { ...f.descriptor, executionDirectory: checkout } });
  const scope = { owner: 'a'.repeat(64), runId: 'real-git-' + Date.now(), sessionId: 'same-chat', epoch: 'epoch', descriptorHash: 'b'.repeat(64) };
  const containers = new ReservationNativeContainers(); let handle: Awaited<ReturnType<typeof containers.prepare>> | undefined;
  let network: Awaited<ReturnType<typeof prepareReservationNativeNetwork>> | undefined;
  try {
    network = await prepareReservationNativeNetwork({ scope, image: process.env.RESERVATION_NATIVE_TEST_IMAGE!, directory: workspace.directory, brokerUrl: `http://host.docker.internal:${port}` });
    handle = await containers.prepare({ scope, image: process.env.RESERVATION_NATIVE_TEST_IMAGE!, mounts: workspace.mounts, network: network.name, uid: process.getuid!(), gid: process.getgid!(), deadlineMonotonicMs: reservationMonotonicNow() + 85000 });
    const run = async (command: string, args: string[]) => {
      const child = await containers.execute(handle!, { command, args, cwd: checkout, uid: process.getuid!(), gid: process.getgid!(), environmentFile: workspace.toolEnvFile });
      return new Promise<string>((resolve, reject) => { let stdout = '', stderr = ''; child.stdout!.on('data', data => { stdout += data }); child.stderr!.on('data', data => { stderr += data }); child.once('error', reject); child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error('fixture failed: ' + stderr))); });
    };
    expect(await run('git', ['rev-parse', 'HEAD'])).toContain(f.descriptor.headSha);
    expect(await run('sh', ['-c', "! git config --get credential.helper && printf changed >file && git add file && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m scoped && git rev-parse HEAD"])).not.toContain('raw-github-secret');
    const scopedHead = (await run('git', ['rev-parse', 'HEAD'])).trim(); expect(scopedHead).not.toBe(f.descriptor.headSha);
    expect((await exec('git', ['-C', checkout, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(f.descriptor.headSha);
    const probe = `const http=require('http');http.get({host:'egress',port:8080,path:process.argv[1]},r=>{let s='';r.on('data',b=>s+=b);r.on('end',()=>console.log(r.statusCode+':'+s))}).on('error',()=>process.exit(2))`;
    expect(await run('env', ['NODE_USE_ENV_PROXY=0', 'node', '-e', probe, `http://host.docker.internal:${port}/fixture`])).toContain('200:scoped-broker-fixture');
    expect(await run('env', ['NODE_USE_ENV_PROXY=0', 'node', '-e', probe, 'http://example.invalid/denied'])).toContain('403:');
    expect((await containers.stop(scope, handle)).exited).toBe(true); handle = undefined;
    await network.close(); await network.close();
  } finally {
    if (handle) await containers.stop(scope, handle);
    await network?.close(); await workspace.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 90000);

it('stages monitor commands without native history, AI capabilities or MCP configuration', async () => {
  const f = await fixture();
  const workspace = await prepareReservationNativeWorkspace({ ...f, root: join(f.root, 'private'), commandsOnly: true });
  const { readdir } = await import('node:fs/promises');
  expect(await readdir(join(workspace.directory, 'home'))).toEqual([]);
  expect(await readFile(workspace.envFile, 'utf8')).not.toMatch(/opaque-run-only|ANTHROPIC|OPENAI|CAPABILITY|BROKER/);
  await expect(workspace.commit()).rejects.toThrow('RESERVATION_COMMAND_STATE_UNAVAILABLE');
  await workspace.close();
});

it('supports a plain project monitor without inventing Git metadata', async () => {
  const f = await fixture(), plain = join(f.root, 'plain'); await mkdir(plain);
  const workspace = await prepareReservationNativeWorkspace({ ...f, root: join(f.root, 'private'), commandsOnly: true,
    descriptor: { ...f.descriptor, baseDirectory: plain, executionDirectory: plain, headSha: null, baseSha: null } });
  expect(workspace.mounts.map(mount => mount.target)).toEqual([plain, '/home/reservation']);
  await workspace.close();
});
