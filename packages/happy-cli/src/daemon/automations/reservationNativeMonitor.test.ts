import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ReservationNativeMonitor } from './reservationNativeMonitor';
import { ReservationNativeContainers } from './reservationNativeContainer';
import { reservationMonotonicNow } from './reservationMonotonicClock';
import type { ReservationTurnDescriptor } from './reservationConversationTurn';
const exec = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(origins: string[] = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'reservation-monitor-'))); roots.push(root);
  const repo = join(root, 'repo'); await mkdir(repo); await exec('git', ['-C', repo, 'init']);
  await writeFile(join(repo, 'status.json'), 'first'); await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  await exec('git', ['-C', repo, 'config', 'credential.helper', '!echo host-secret']);
  const headSha = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const nativeId = '12345678-1234-4234-8234-123456789abc', sourceTranscript = join(root, 'native.jsonl');
  await writeFile(sourceTranscript, JSON.stringify({ sessionId: nativeId, message: 'private chat history' }) + '\n');
  const runId = randomUUID(), scope = { owner: 'a'.repeat(64), descriptorHash: 'b'.repeat(64), runId, sessionId: 'same-chat', epoch: 'epoch', role: 'preparation' as const };
  const descriptor: ReservationTurnDescriptor = { version: 1, automationId: 'automation', generation: 1, runId, sessionId: 'same-chat', machineId: 'machine', accountId: 'owner', agent: 'claude', baseDirectory: repo, executionDirectory: repo, writeMode: 'worktree', baseSha: headSha, headSha, connectorPolicy: 'none', requiredConnectors: [], credentialHandles: [] };
  const containers = new ReservationNativeContainers(); let engine = '';
  const monitor = new ReservationNativeMonitor(containers, { scope, image: process.env.RESERVATION_NATIVE_TEST_IMAGE!, userSignal: new AbortController().signal,
    workspace: { root: join(root, 'private'), descriptor, nativeId, sourceTranscript, broker: { url: '', token: '' }, model: 'unused', projectEnvironment: { GH_TOKEN: 'host-secret', OPENAI_API_KEY: 'host-ai-secret', APP_VALUE: 'kept' } }, allowedOrigins: origins, privateOrigins: origins });
  return { root, repo, sourceTranscript, monitor, containers, scope, descriptorHash: scope.descriptorHash, recordIntent: (value: string) => { engine = value; }, engine: () => engine };
}
it.skipIf(!process.env.RESERVATION_NATIVE_TEST_IMAGE)('runs monitor and gate without credentials/history and removes detached descendants before returning authority', async () => {
  const f = await fixture();
  try {
    await f.monitor.prepare({ epoch: 'epoch', descriptorHash: f.descriptorHash, expiresAt: Date.now() + 85000, deadlineMonotonicMs: reservationMonotonicNow() + 85000, signal: new AbortController().signal, recordIntent: f.recordIntent });
    expect(f.engine()).not.toBe('');
    const result = await f.monitor.run({ command: `node -e 'const fs=require("fs");if(process.env.GH_TOKEN||process.env.OPENAI_API_KEY||process.env.SAYCODE_RESERVATION_CAPABILITY||fs.existsSync(process.env.HOME+"/.claude"))process.exit(2);require("child_process").spawn("node",["-e","setTimeout(()=>{},60000)"],{detached:true,stdio:"ignore"}).unref();console.log(process.env.HAPPY_AUTOMATION_NOTEPAD)'`, notepad: { cursor: '17\n18' } });
    expect(result).toEqual({ ok: true, stdout: JSON.stringify({ cursor: '17\n18' }) + '\n' });
    expect(await f.monitor.run({ command: "printf '%s' '{\"wake\":false,\"notepad\":{\"cursor\":\"19\"}}'", notepad: {} })).toMatchObject({ ok: true });
    await f.monitor.close(); await f.monitor.close();
    await f.containers.cleanupPreparation(f.scope, f.engine()); // Idempotent, anchored on the original engine.
    expect(await readFile(f.sourceTranscript, 'utf8')).toContain('private chat history');
    expect(await readdir(join(f.root, 'private'))).toEqual([]);
    expect((await exec('git', ['-C', f.repo, 'config', 'credential.helper'])).stdout).toContain('host-secret');
  } finally { await f.monitor.close(); }
}, 60000);
it('does not accept engine changes as evidence that a preparation command exited', async () => {
  const { vi } = await import('vitest');
  const containers = new ReservationNativeContainers({ command: vi.fn(async () => JSON.stringify({ OSType: 'linux', ID: 'different-engine' })), attach: vi.fn() });
  await expect(containers.cleanupPreparation({ role: 'preparation', owner: 'a'.repeat(64), descriptorHash: 'b'.repeat(64), runId: 'r', sessionId: 's', epoch: 'e' }, 'original-engine')).rejects.toThrow('RESERVATION_ENGINE_CHANGED');
});

it.skipIf(!process.env.RESERVATION_NATIVE_TEST_IMAGE)('allows only explicitly declared monitor origins through an isolated proxy and cleans its network', async () => {
  const server = createServer((_request, response) => response.end('local monitor fixture'));
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const origin = `http://host.docker.internal:${(server.address() as { port: number }).port}`;
  const f = await fixture([origin]);
  try {
    await f.monitor.prepare({ epoch: 'epoch', descriptorHash: f.descriptorHash, expiresAt: Date.now() + 85000, deadlineMonotonicMs: reservationMonotonicNow() + 85000, signal: new AbortController().signal, recordIntent: f.recordIntent });
    const probe = (url: string) => `NODE_USE_ENV_PROXY=0 node -e 'require("http").get({host:"egress",port:8080,path:${JSON.stringify(url)}},r=>{let s="";r.on("data",b=>s+=b);r.on("end",()=>console.log(r.statusCode+":"+s))}).on("error",()=>process.exit(2))'`;
    expect(await f.monitor.run({ command: probe(origin + '/state'), notepad: {} })).toEqual({ ok: true, stdout: '200:local monitor fixture\n' });
    expect((await f.monitor.run({ command: probe('http://example.invalid/denied'), notepad: {} })).stdout).toContain('403:');
    await f.monitor.close(); await f.containers.cleanupPreparation(f.scope, f.engine());
  } finally { await f.monitor.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60000);
