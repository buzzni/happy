import { describe, expect, it, vi } from 'vitest';
import { CODEX_AUTH_BLOCKED_NOTICES, CodexAuthRecovery, CodexAuthRecoveryError, describeCodexAuthRecoveryFailure } from './codexAuthRecovery';

function fixture(reconnect = vi.fn(async () => 'authenticated' as const)) {
    const client = { authRecoverySource: 'cli-login' as const, authRecoveryBusy: false, threadId: 'thread-a', reconnectForAuth: reconnect };
    const recovery = new CodexAuthRecovery(client, () => false);
    const request = () => ({ version: 1, runtimeId: recovery.status().runtimeId, generation: recovery.status().generation, operationId: 'operation-1' });
    return { client, recovery, request, reconnect };
}

describe('CodexAuthRecovery session contract', () => {
    it('reconnects once for repeated operations, without sending any prompt', async () => {
        const { recovery, request, reconnect } = fixture();
        const input = request();
        const result = await recovery.recover(input);
        expect(result.status).toBe('ready');
        expect(await recovery.recover(input)).toEqual(result);
        expect(reconnect).toHaveBeenCalledTimes(1);
        expect(recovery.status().generation).toBe(1);
    });

    it('refuses while a turn is preparing, even before the provider becomes busy', async () => {
        const { recovery, request, reconnect } = fixture();
        await recovery.beginTurn();
        expect((await recovery.recover(request())).status).toBe('busy');
        expect(reconnect).not.toHaveBeenCalled();
        recovery.endTurn();
        expect((await recovery.recover(request())).status).toBe('ready');
    });

    it('holds newly queued input until recovery has finished', async () => {
        let finish!: (value: 'authenticated') => void;
        const { recovery, request } = fixture(vi.fn(() => new Promise(resolve => { finish = resolve; })));
        const result = recovery.recover(request());
        expect(() => recovery.assertReady()).toThrow('Codex authentication recovery is required');
        const entered = vi.fn();
        const turn = recovery.beginTurn().then(entered);
        await Promise.resolve();
        expect(entered).not.toHaveBeenCalled();
        finish('authenticated');
        await result;
        await turn;
        expect(entered).toHaveBeenCalledTimes(1);
    });

    it('blocks dispatch after failed resume and never exposes provider error details', async () => {
        const { recovery, request, reconnect } = fixture(vi.fn(async () => { throw new Error('token=secret'); }));
        const result = await recovery.recover(request());
        expect(result.status).toBe('failed');
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(() => recovery.assertReady()).toThrow('Codex authentication recovery is required');
        reconnect.mockResolvedValue('authenticated');
        expect((await recovery.recover({ ...request(), operationId: 'operation-2' })).status).toBe('ready');
        expect(() => recovery.assertReady()).not.toThrow();
    });

    it('retries the same recovery once when the next message arrives, dispatching only after it succeeds', async () => {
        const { recovery, request, reconnect } = fixture(vi.fn(async () => { throw new CodexAuthRecoveryError('limit-reached'); }));
        await recovery.recover(request());
        await recovery.beginTurn();
        await expect(recovery.prepareTurn()).rejects.toMatchObject({ reason: 'limit-reached' });
        expect(reconnect).toHaveBeenCalledTimes(2);
        expect(() => recovery.assertReady()).toThrow('Codex authentication recovery is required');
        recovery.endTurn();

        reconnect.mockResolvedValue('authenticated');
        await recovery.beginTurn();
        await recovery.prepareTurn();
        expect(reconnect).toHaveBeenCalledTimes(3);
        expect(() => recovery.assertReady()).not.toThrow();
        expect(recovery.status()).toMatchObject({ state: 'idle', generation: 3 });
        await recovery.prepareTurn();
        expect(reconnect).toHaveBeenCalledTimes(3);
    });

    it('does not restart the provider for a turn while its approvals are still open', async () => {
        const { recovery, request, reconnect, client } = fixture(vi.fn(async () => { throw new CodexAuthRecoveryError('authentication-required'); }));
        await recovery.recover(request());
        client.authRecoveryBusy = true;
        await expect(recovery.prepareTurn()).rejects.toMatchObject({ reason: 'authentication-required' });
        expect(reconnect).toHaveBeenCalledTimes(1);
    });

    it('names the blocking reason instead of a process crash', () => {
        expect(describeCodexAuthRecoveryFailure(new CodexAuthRecoveryError('limit-reached'))).toBe(CODEX_AUTH_BLOCKED_NOTICES.limitReached);
        expect(describeCodexAuthRecoveryFailure(new CodexAuthRecoveryError('authentication-required'))).toBe(CODEX_AUTH_BLOCKED_NOTICES.signInRequired);
        expect(describeCodexAuthRecoveryFailure(new CodexAuthRecoveryError('resume-failed'))).toBe(CODEX_AUTH_BLOCKED_NOTICES.reconnectFailed);
        expect(describeCodexAuthRecoveryFailure(new Error('spawn failed'))).toBeNull();
    });

    it('refuses stale runtime and generation, and running provider approvals', async () => {
        const { recovery, request, client, reconnect } = fixture();
        expect((await recovery.recover({ ...request(), runtimeId: 'old' })).status).toBe('stale');
        expect((await recovery.recover({ ...request(), generation: -1 })).status).toBe('stale');
        client.authRecoveryBusy = true;
        expect((await recovery.recover(request())).status).toBe('busy');
        expect(reconnect).not.toHaveBeenCalled();
    });

    it('refuses managed authentication before touching the provider', async () => {
        const reconnectForAuth = vi.fn();
        const recovery = new CodexAuthRecovery({ authRecoverySource: 'managed', authRecoveryBusy: false, threadId: 't', reconnectForAuth }, () => false);
        expect((await recovery.recover({ ...recovery.status(), operationId: 'op' })).status).toBe('unsupported');
        expect(reconnectForAuth).not.toHaveBeenCalled();
    });
});
