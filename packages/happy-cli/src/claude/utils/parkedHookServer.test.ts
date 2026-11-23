import { request } from 'node:http';
import { expect, it, vi } from 'vitest';
import { offerParkedClaudeHookServer, reserveClaudeHookServer } from './parkedHookServer';
import { startHookServer } from './startHookServer';

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn() } }));

function postHook(port: number) {
    return new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/hook/session-start', agent: false }, response => {
            response.resume();
            response.once('end', () => resolve(response.statusCode ?? 0));
        });
        req.once('error', reject);
        req.end(JSON.stringify({ session_id: 'synthetic-session' }));
    });
}

it('rejects unbound hooks and reuses the same endpoint once the Claude session is authorized', async () => {
    const parked = await reserveClaudeHookServer();
    const onSessionHook = vi.fn();
    let authorized: Awaited<ReturnType<typeof startHookServer>> | undefined;
    let other: Awaited<ReturnType<typeof startHookServer>> | undefined;
    try {
        expect(await postHook(parked.port)).toBe(503);
        offerParkedClaudeHookServer(parked);
        authorized = await startHookServer({ onSessionHook });
        expect(authorized.port).toBe(parked.port);
        expect(onSessionHook).not.toHaveBeenCalled();
        expect(await postHook(authorized.port)).toBe(200);
        expect(onSessionHook).toHaveBeenCalledExactlyOnceWith('synthetic-session', { session_id: 'synthetic-session' });
        other = await startHookServer({ onSessionHook: vi.fn() });
        expect(other.port).not.toBe(parked.port);
        authorized.stop();
        await expect(postHook(parked.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
        authorized?.stop();
        other?.stop();
        parked.stop();
    }
});
