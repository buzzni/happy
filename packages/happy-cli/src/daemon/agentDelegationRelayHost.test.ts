import { describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { PersistedSession } from '@/persistence';
import { createAgentDelegationRelayHost } from './agentDelegationRelayHost';

const key = new Uint8Array(32).fill(3);
const persisted = (overrides: Omit<Partial<PersistedSession>, 'metadata'> & { metadata?: Partial<PersistedSession['metadata']> } = {}): PersistedSession => ({
    encryptionKey: encodeBase64(key),
    encryptionVariant: 'dataKey',
    seq: 0,
    metadataVersion: 1,
    agentStateVersion: 1,
    savedAt: 500,
    ...overrides,
    metadata: { path: '/work/app', host: 'b', machineId: 'machine-b', summary: { text: 'Fix login', updatedAt: 1 }, ...overrides.metadata } as PersistedSession['metadata'],
});

const host = (input: Partial<Parameters<typeof createAgentDelegationRelayHost>[0]> = {}) => createAgentDelegationRelayHost({
    serverUrl: 'https://server.test',
    machineId: 'machine-b',
    token: async () => 'token-b',
    readSessions: () => ({ s1: persisted(), elsewhere: persisted({ metadata: { machineId: 'machine-x' } }), broken: persisted({ encryptionKey: 'short' }) }),
    isSessionLive: () => true,
    relationHost: async () => ({ serverUrl: 'https://server.test', machineId: 'machine-b', token: 'token-b' }),
    ...input,
});

describe('agent-delegation relay host', () => {
    it('offers only well-formed sessions this machine ran, titled by their summary', () => {
        expect(host().sessions()).toEqual([{ sessionId: 's1', directory: '/work/app', title: 'Fix login', updatedAt: 500, encryptionKey: key, encryptionVariant: 'dataKey' }]);
    });

    it('reads one server page with the same cursor the CLI uses and hands back the ciphertext', async () => {
        const get = vi.fn(async () => ({ data: { messages: [{ seq: 2, localId: 'x', createdAt: 9, content: { t: 'encrypted', c: 'cipher' } }, { seq: 3, content: { t: 'plain' } }] } }));
        const relay = host({ get: get as never });
        const binding = relay.sessions()[0]!;
        expect(await relay.fetchPage(binding, { limit: 20, beforeSeq: 10 })).toEqual([{ seq: 2, localId: 'x', createdAt: 9, ciphertext: 'cipher' }]);
        expect(get).toHaveBeenCalledWith('https://server.test/v3/sessions/s1/messages', expect.objectContaining({
            params: { limit: 20, before_seq: 10 }, headers: { Authorization: 'Bearer token-b' },
        }));
    });

    it('encrypts a prompt with the session key and posts it under its local id', async () => {
        const post = vi.fn(async () => ({}));
        const relay = host({ post: post as never });
        const binding = relay.sessions()[0]!;
        await relay.postUserMessage(binding, { localId: 'local-1', content: { role: 'user', content: { type: 'text', text: 'hi' } } });
        const [url, body] = post.mock.calls[0] as unknown as [string, { messages: Array<{ localId: string; content: string }> }];
        expect(url).toBe('https://server.test/v3/sessions/s1/messages');
        expect(body.messages[0]!.localId).toBe('local-1');
        expect(decrypt(key, 'dataKey', decodeBase64(body.messages[0]!.content))).toEqual({ role: 'user', content: { type: 'text', text: 'hi' } });
        expect(relay.decrypt(binding, encodeBase64(encrypt(key, 'dataKey', { ok: true })))).toEqual({ ok: true });
    });

    it('asks the server about ownership as this machine and keeps only own sessions', async () => {
        const fetch = vi.fn(async (url: string) => new Response(url.endsWith('/v1/account/profile')
            ? JSON.stringify({ id: 'account-1' })
            : JSON.stringify({ v: 1, callerAccountId: 'account-1', proof: 'personal-same-account', relations: { s1: 'own', s2: 'not-own' } })));
        const owned = await host({ fetch: fetch as never }).ownedBy('requester', ['s1', 's2']);
        expect([...owned]).toEqual(['s1']);
        const relationCall = fetch.mock.calls.find(([url]) => String(url).endsWith('/v1/session-ownership/relation')) as unknown as [string, RequestInit];
        expect(JSON.parse(String(relationCall[1].body))).toEqual({ v: 1, callerSessionId: 'requester', machineId: 'machine-b', sessionIds: ['s1', 's2'] });
    });

    it('proves nothing when this machine has no confirmed identity', async () => {
        expect([...await host({ relationHost: async () => null }).ownedBy('requester', ['s1'])]).toEqual([]);
    });
});
