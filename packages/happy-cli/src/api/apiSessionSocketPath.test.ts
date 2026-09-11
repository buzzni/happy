/**
 * Which socket a session client dials.
 *
 * The server runs **two** socket servers on one port: the ordinary one at
 * `/v1/updates`, whose auth verifies account tokens, and the managed one at
 * `/v1/managed-updates`, whose auth verifies scoped runner grants. A managed
 * child carries a runner grant, so dialling the ordinary path means the token
 * falls through to `auth.verifyToken` and is rejected — forever, every three
 * seconds, with `Invalid authentication token`. That is what a real managed
 * runtime did: it spawned, attached its session, posted its webhook, and then
 * could never reach its own server.
 *
 * The path is part of the wire format on the server side, so the client is the
 * side that has to match it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Metadata } from '@/api/types';

let serverUrl = 'https://relay.test';
const captured: Array<{ url: string; opts: { path?: string } }> = [];

vi.mock('@/configuration', () => ({
    configuration: {
        get serverUrl() { return serverUrl; },
        currentCliVersion: '0.0.0-test',
    },
}));
vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), debugLargeJson: vi.fn(), info: vi.fn(), infoDeveloper: vi.fn() },
}));
vi.mock('socket.io-client', () => ({
    io: (url: string, opts: { path?: string }) => {
        captured.push({ url, opts });
        return {
            on: vi.fn(), off: vi.fn(), emit: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
            close: vi.fn(), io: { on: vi.fn(), off: vi.fn() }, connected: false,
        };
    },
}));

function makeSession() {
    return {
        id: 'test-session-id',
        seq: 0,
        metadata: {
            path: '/workspace/project', host: 'localhost', homeDir: '/home/user',
            happyHomeDir: '/home/user/.happy', happyLibDir: '/home/user/.happy/lib',
            happyToolsDir: '/home/user/.happy/tools',
        } as Metadata,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy' as const,
    };
}

beforeEach(() => { captured.length = 0; });

describe('the socket a session client dials', () => {
    it('shouldDialTheManagedPathWhenItHoldsARunnerGrant', async () => {
        const { ApiSessionClient } = await import('@/api/apiSession');
        serverUrl = 'https://relay.test';
        new ApiSessionClient('scoped-token', makeSession(), { serverOrigin: 'https://relay.test' });
        expect(captured).toHaveLength(1);
        expect(captured[0]!.opts.path).toBe('/v1/managed-updates');
    });

    it('shouldDialTheOrdinaryPathForAnAccountClient', async () => {
        const { ApiSessionClient } = await import('@/api/apiSession');
        serverUrl = 'https://relay.test';
        new ApiSessionClient('account-token', makeSession());
        expect(captured).toHaveLength(1);
        // Unchanged: every non-managed session, and the daemon's own paths,
        // keep the socket they have always used.
        expect(captured[0]!.opts.path).toBe('/v1/updates');
    });
});
