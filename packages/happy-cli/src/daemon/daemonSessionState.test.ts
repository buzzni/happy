import { describe, expect, it, vi } from 'vitest';
import { createDaemonSessionStateHandler } from './daemonSessionState';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { MachineMetadataSchema } from '@/api/types';
import { logger } from '@/ui/logger';

function tracked(happySessionId?: string) {
    return { happySessionId, pid: 123, startedBy: 'daemon' };
}

describe('daemon-session-state', () => {
    it('returns only presence for the requested currently tracked session', async () => {
        const handler = createDaemonSessionStateHandler(() => [tracked('live'), tracked('other')]);
        expect(await handler({ sessionId: 'live' })).toEqual({ version: 1, state: 'present' });
        expect(await handler({ sessionId: 'absent' })).toEqual({ version: 1, state: 'missing' });
    });

    it('reads the current children on every call, including an empty daemon', async () => {
        const children = [tracked('live')];
        const handler = createDaemonSessionStateHandler(() => children);
        expect(await handler({ sessionId: 'live' })).toEqual({ version: 1, state: 'present' });
        children.pop();
        expect(await handler({ sessionId: 'live' })).toEqual({ version: 1, state: 'missing' });
    });

    it('uses the list identity, not pending resume targets or archived records', async () => {
        const handler = createDaemonSessionStateHandler(() => [
            { ...tracked(), resumeTargetSessionId: 'pending' },
        ]);
        expect(await handler({ sessionId: 'pending' })).toEqual({ version: 1, state: 'missing' });
        expect(await handler({ sessionId: 'archived' })).toEqual({ version: 1, state: 'missing' });
    });

    it.each([null, undefined, {}, { sessionId: '' }, { sessionId: '  ' }, { sessionId: 1 }])(
        'returns unknown for malformed request %j without reading children', async (input) => {
            const read = vi.fn(() => []);
            expect(await createDaemonSessionStateHandler(read)(input)).toEqual({ version: 1, state: 'unknown' });
            expect(read).not.toHaveBeenCalled();
        },
    );

    it('returns unknown and logs when tracked children cannot be read', async () => {
        const log = vi.spyOn(logger, 'debug');
        const error = new Error('unavailable');
        const read = () => { throw error; };
        expect(await createDaemonSessionStateHandler(read)({ sessionId: 'live' }))
            .toEqual({ version: 1, state: 'unknown' });
        expect(log).toHaveBeenCalledWith('[DAEMON SESSION STATE] Could not read tracked children');
        log.mockRestore();
    });

    it('retains encrypted machine dispatch and managed restrictions', async () => {
        const key = new Uint8Array(32);
        const manager = new RpcHandlerManager({ scopePrefix: 'machine', encryptionKey: key, encryptionVariant: 'legacy' });
        const read = vi.fn(() => [tracked('live')]);
        manager.registerHandler('daemon-session-state', createDaemonSessionStateHandler(read));
        const request = { method: 'machine:daemon-session-state', params: encodeBase64(encrypt(key, 'legacy', { sessionId: 'live' })) };
        const response = decrypt(key, 'legacy', decodeBase64(await manager.handleRequest(request)));
        expect(response).toEqual({ version: 1, state: 'present' });
        manager.setManagedAllowlist(['managed:status']);
        read.mockClear();
        const denied = decrypt(key, 'legacy', decodeBase64(await manager.handleRequest(request)));
        expect(denied).toMatchObject({ code: 'MANAGED_CAPABILITY_REQUIRED' });
        expect(read).not.toHaveBeenCalled();
    });

    it('preserves the versioned capability in machine metadata', () => {
        const base = { host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happy', happyLibDir: '/lib/happy' };
        expect(MachineMetadataSchema.parse({ ...base, daemonSessionState: { version: 1 } }).daemonSessionState)
            .toEqual({ version: 1 });
        expect(MachineMetadataSchema.safeParse({ ...base, daemonSessionState: { version: 2 } }).success).toBe(false);
        expect(MachineMetadataSchema.safeParse(base).success).toBe(true);
    });
});
