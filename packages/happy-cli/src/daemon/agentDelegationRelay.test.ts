import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgentDelegationRelay, type AgentDelegationRelayHost, type RelaySessionBinding } from './agentDelegationRelay';
import type { RpcCallContext } from '@/api/rpc/types';

const PEER: RpcCallContext = { lane: 'delegation', peer: 'machine-a' };

const binding = (sessionId: string, overrides: Partial<RelaySessionBinding> = {}): RelaySessionBinding => ({
    sessionId,
    directory: `/work/${sessionId}`,
    title: `title ${sessionId}`,
    updatedAt: 1_000,
    encryptionKey: new Uint8Array(32).fill(7),
    encryptionVariant: 'dataKey',
    ...overrides,
});

describe('agent-delegation relay', () => {
    let handlers: Map<string, (params: unknown, context?: RpcCallContext) => any>;
    let links: Set<string>;
    let children: Map<string, string>;
    let owned: Set<string>;
    let live: Set<string>;
    let bindings: RelaySessionBinding[];
    let ownedBy: ReturnType<typeof vi.fn>;
    let fetchPage: ReturnType<typeof vi.fn>;
    let postUserMessage: ReturnType<typeof vi.fn>;
    let now: number;

    const setup = (host: Partial<AgentDelegationRelayHost> = {}) => {
        handlers = new Map();
        registerAgentDelegationRelay((method, handler) => handlers.set(method, handler), {
            store: {
                targetLink: (peer) => links.has(peer) ? { createdBy: { accountId: 'linker' } } : null,
                childOf: (sessionId, peer) => children.get(sessionId) === peer,
            },
            sessions: () => bindings,
            isSessionLive: (sessionId) => live.has(sessionId),
            ownedBy: ownedBy as never,
            fetchPage: fetchPage as never,
            decrypt: (_binding, ciphertext) => ciphertext.startsWith('bad') ? null : JSON.parse(ciphertext),
            postUserMessage: postUserMessage as never,
            now: () => now,
            ...host,
        });
    };
    const call = (method: string, params: unknown) => handlers.get(method)!(params, PEER);

    beforeEach(() => {
        links = new Set(['machine-a']);
        children = new Map([['child-1', 'machine-a'], ['child-of-other', 'machine-z']]);
        owned = new Set(['mine-1', 'mine-2']);
        live = new Set(['mine-1', 'child-1']);
        bindings = [binding('mine-1', { updatedAt: 3_000 }), binding('mine-2', { updatedAt: 1_000 }), binding('child-1', { updatedAt: 2_000 }),
            binding('theirs'), binding('child-of-other'), binding('requester')];
        ownedBy = vi.fn(async (_requester: string, ids: string[]) => new Set(ids.filter((id) => owned.has(id))));
        fetchPage = vi.fn(async () => [
            { seq: 4, localId: 'l4', createdAt: 40, ciphertext: JSON.stringify({ role: 'agent', content: { type: 'text', text: 'done' } }) },
            { seq: 3, localId: null, createdAt: 30, ciphertext: 'bad-ciphertext' },
        ]);
        postUserMessage = vi.fn(async () => undefined);
        now = 0;
        setup();
    });

    describe('relay-sessions', () => {
        it('lists the peer\'s children and this person\'s own sessions, newest first, never the requester itself', async () => {
            const reply = await call('agent-delegation:relay-sessions', { requesterSessionId: 'requester' });
            expect(reply).toEqual({ type: 'success', sessions: [
                { id: 'mine-1', directory: '/work/mine-1', title: 'title mine-1', active: true, updatedAt: 3_000, delegated: false },
                { id: 'child-1', directory: '/work/child-1', title: 'title child-1', active: true, updatedAt: 2_000, delegated: true },
                { id: 'mine-2', directory: '/work/mine-2', title: 'title mine-2', active: false, updatedAt: 1_000, delegated: false },
            ] });
            // Ownership is asked of the server for everything that is not this link's child.
            expect(ownedBy).toHaveBeenCalledWith('requester', ['mine-1', 'mine-2', 'theirs', 'child-of-other']);
        });

        it('lists only the link\'s children when ownership cannot be proven', async () => {
            owned = new Set();
            const reply = await call('agent-delegation:relay-sessions', { requesterSessionId: 'requester' });
            expect(reply.sessions.map((session: { id: string }) => session.id)).toEqual(['child-1']);
        });
    });

    describe('relay-read', () => {
        it('returns the decrypted page oldest first and skips what does not decrypt', async () => {
            const reply = await call('agent-delegation:relay-read', { requesterSessionId: 'requester', sessionId: 'mine-1', limit: 20, beforeSeq: 10 });
            expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'mine-1' }), { limit: 20, beforeSeq: 10 });
            expect(reply).toEqual({
                type: 'success',
                session: { id: 'mine-1', directory: '/work/mine-1', active: true },
                messages: [{ seq: 4, localId: 'l4', createdAt: 40, content: { role: 'agent', content: { type: 'text', text: 'done' } } }],
            });
        });

        it('reads a child of this link without asking about ownership', async () => {
            const reply = await call('agent-delegation:relay-read', { requesterSessionId: 'requester', sessionId: 'child-1', afterSeq: 2 });
            expect(reply.type).toBe('success');
            expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'child-1' }), { limit: 50, afterSeq: 2 });
            expect(ownedBy).not.toHaveBeenCalled();
        });

        it.each([
            ['another person\'s session', 'theirs'],
            ['another link\'s child', 'child-of-other'],
            ['a session this machine holds no key for', 'unknown-session'],
            ['the requester itself', 'requester'],
        ])('answers %s exactly like a missing one', async (_name, sessionId) => {
            owned.add('requester');
            const reply = await call('agent-delegation:relay-read', { requesterSessionId: 'requester', sessionId });
            expect(reply).toEqual({ type: 'error', code: 'session_not_found', errorMessage: 'No such session is reachable from the requesting machine' });
            expect(fetchPage).not.toHaveBeenCalled();
        });

        it('refuses outside the delegation lane and after the link is revoked', async () => {
            // The customer and server lanes call handlers with no context.
            expect(await handlers.get('agent-delegation:relay-read')!({ requesterSessionId: 'requester', sessionId: 'mine-1' }))
                .toMatchObject({ type: 'error', code: 'delegation_lane_required' });
            links.clear();
            expect(await call('agent-delegation:relay-read', { requesterSessionId: 'requester', sessionId: 'mine-1' }))
                .toMatchObject({ type: 'error', code: 'machine_not_delegatable' });
            expect(fetchPage).not.toHaveBeenCalled();
        });

        it.each([
            { requesterSessionId: 'requester', sessionId: 'mine-1', beforeSeq: 5, afterSeq: 1 },
            { requesterSessionId: 'requester', sessionId: 'mine-1', limit: 201 },
            { requesterSessionId: 'requester', sessionId: 'mine-1', extra: true },
            { sessionId: 'mine-1' },
        ])('rejects a malformed request %#', async (params) => {
            expect(await call('agent-delegation:relay-read', params)).toMatchObject({ type: 'error', code: 'invalid_request' });
        });

        it('reuses a proven ownership for a minute only, so a revoked machine closes soon', async () => {
            await call('agent-delegation:relay-read', { requesterSessionId: 'requester', sessionId: 'mine-1' });
            now = 59_000;
            await call('agent-delegation:relay-read', { requesterSessionId: 'requester', sessionId: 'mine-1' });
            expect(ownedBy).toHaveBeenCalledTimes(1);
            now = 61_000;
            owned.delete('mine-1');
            expect(await call('agent-delegation:relay-read', { requesterSessionId: 'requester', sessionId: 'mine-1' }))
                .toMatchObject({ code: 'session_not_found' });
            expect(ownedBy).toHaveBeenCalledTimes(2);
        });

        it('reports a failed server read as relay_failed, not as an empty conversation', async () => {
            fetchPage.mockRejectedValueOnce(new Error('503'));
            expect(await call('agent-delegation:relay-read', { requesterSessionId: 'requester', sessionId: 'mine-1' }))
                .toMatchObject({ type: 'error', code: 'relay_failed' });
        });
    });

    describe('relay-prompt', () => {
        it('sends a user message marked as coming from the linked machine', async () => {
            const reply = await call('agent-delegation:relay-prompt', { requesterSessionId: 'requester', sessionId: 'mine-1', localId: 'local-0001', text: 'and the tests?' });
            expect(reply).toEqual({ type: 'success', localId: 'local-0001' });
            expect(postUserMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'mine-1' }), {
                localId: 'local-0001',
                content: {
                    role: 'user',
                    content: { type: 'text', text: 'and the tests?' },
                    meta: { sentFrom: 'agent-delegation', delegatedFrom: { machineId: 'machine-a', sessionId: 'requester' } },
                },
            });
        });

        it('refuses a session that is not running here instead of starting it', async () => {
            expect(await call('agent-delegation:relay-prompt', { requesterSessionId: 'requester', sessionId: 'mine-2', localId: 'local-0002', text: 'hi' }))
                .toMatchObject({ type: 'error', code: 'session_not_running' });
            expect(postUserMessage).not.toHaveBeenCalled();
        });

        it('refuses another person\'s live session like a missing one', async () => {
            live.add('theirs');
            expect(await call('agent-delegation:relay-prompt', { requesterSessionId: 'requester', sessionId: 'theirs', localId: 'local-0003', text: 'hi' }))
                .toMatchObject({ type: 'error', code: 'session_not_found' });
            expect(postUserMessage).not.toHaveBeenCalled();
        });

        it.each([
            { requesterSessionId: 'requester', sessionId: 'mine-1', localId: 'short', text: 'hi' },
            { requesterSessionId: 'requester', sessionId: 'mine-1', localId: 'local-0004', text: '   ' },
        ])('rejects a malformed prompt %#', async (params) => {
            expect(await call('agent-delegation:relay-prompt', params)).toMatchObject({ type: 'error', code: 'invalid_request' });
        });
    });
});
