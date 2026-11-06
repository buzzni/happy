import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDaemonControlServer } from './controlServer';
import { createPortRegistry } from './portRegistry';
import { createSessionRetention } from './sessionRetention';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function start(managedRuntime = false) {
    const home = mkdtempSync(join(tmpdir(), 'retention-control-'));
    const children = [{ startedBy: 'daemon', pid: process.pid, happySessionId: 'a', runtime: { thinking: false, hasOpenToolCall: false, updatedAt: Date.now() } }];
    const server = await startDaemonControlServer({ getChildren: () => children, stopSession: () => ({ stopped: false, reason: 'not-found' }),
        spawnSession: async () => ({ type: 'error', errorMessage: 'not used' }), requestShutdown() {}, onHappySessionWebhook() {},
        managedRuntime, sessionRetention: createSessionRetention({ home, children: () => children }),
        portRegistry: createPortRegistry({ filePath: join(home, 'ports.json'), portMin: 30000, portMax: 30005, isPortBindable: async () => true }) });
    cleanups.push(async () => { await server.stop(); rmSync(home, { recursive: true, force: true }); });
    return { request: (action: string, body: object, secret = server.controlSecret) => fetch(`http://127.0.0.1:${server.port}/session-retention/${action}`, {
        method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }) };
}
it('requires the real control bearer and persists only canonical live sessions', async () => {
    const h = await start();
    expect((await h.request('set', { sessionId: 'a', policy: { mode: 'keep-alive' }, expectedRevision: 0 }, 'wrong')).status).toBe(401);
    expect(await (await h.request('get', { sessionId: 'a' })).json()).toMatchObject({ revision: 0, policy: { mode: 'default' } });
    expect(await (await h.request('set', { sessionId: 'a', policy: { mode: 'keep-alive' }, expectedRevision: 0 })).json()).toMatchObject({ revision: 1, policy: { mode: 'keep-alive' } });
    expect(await (await h.request('set', { sessionId: 'a', policy: { mode: 'default' }, expectedRevision: 0 })).json()).toEqual({ error: 'RETENTION_CONFLICT' });
    expect(await (await h.request('get', { sessionId: 'missing' })).json()).toEqual({ error: 'RETENTION_STOPPED' });
    expect(await (await h.request('set', { sessionId: 'a', policy: { mode: 'idle', durationMs: -1 }, expectedRevision: 1 })).json()).toEqual({ error: 'RETENTION_INVALID' });
});
it('does not open retention control on managed runtimes even with the daemon bearer', async () => {
    const h = await start(true);
    expect((await h.request('get', { sessionId: 'a' })).status).toBe(403);
});
