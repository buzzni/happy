import { describe, expect, it, vi } from 'vitest';
import { SessionOwnershipRelationRequestSchema } from '@slopus/happy-wire';
import { createAgentRelationAuthority, readAgentRelationHost } from './agentRelationAuthority';

const host = { serverUrl: 'https://happy.example', machineId: 'machine-1', token: 'happy-token' };
const own = { relation: 'own-sibling', proof: 'personal-same-account', reason: 'same-account' };

function harness(answer: (body: { sessionIds: string[] }) => unknown, options: { status?: number; profile?: unknown } = {}) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init! });
        if (String(url).endsWith('/v1/account/profile')) return new Response(JSON.stringify(options.profile ?? { id: 'account-a' }));
        const body = answer(JSON.parse(String(init!.body)));
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: options.status ?? 200 });
    });
    const authority = createAgentRelationAuthority({ host, callerSessionId: 'hub', fetch: fetch as unknown as typeof globalThis.fetch });
    return { authority, calls, fetch };
}
const relations = (ids: string[], value: (id: string) => string, proof: string | null = 'personal-same-account') =>
    ({ v: 1, callerAccountId: 'account-a', proof, relations: Object.fromEntries(ids.map(id => [id, value(id)])) });

describe('broker relation authority (personal-ownership-simplification-plan H-C2)', () => {
    it('asks Happy once for a batch with the host-fixed identity and maps v1 own to a personal sibling', async () => {
        const h = harness(body => relations(body.sessionIds, id => id === 'mine' ? 'own' : 'not-own'));
        expect(await h.authority.inspectMany(['mine', 'theirs'])).toEqual({ mine: own,
            theirs: { relation: 'other', proof: null, reason: 'not-own' } });
        const relation = h.calls.find(c => c.url === 'https://happy.example/v1/session-ownership/relation')!;
        expect(relation.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer happy-token', 'content-type': 'application/json' } });
        expect(JSON.parse(String(relation.init.body))).toEqual({ v: 1, callerSessionId: 'hub', machineId: 'machine-1', sessionIds: ['mine', 'theirs'] });
        // Contract with happy-server: the body is exactly what the shared v1 wire schema accepts.
        expect(SessionOwnershipRelationRequestSchema.parse(JSON.parse(String(relation.init.body)))).toEqual(JSON.parse(String(relation.init.body)));
    });

    it('asks again on every inspection and reads the account only once', async () => {
        const h = harness(body => relations(body.sessionIds, () => 'own'));
        expect(await h.authority.inspect('mine')).toEqual(own);
        expect(await h.authority.inspect('mine')).toEqual(own);
        expect(h.calls.filter(c => c.url.endsWith('/relation'))).toHaveLength(2);
        expect(h.calls.filter(c => c.url.endsWith('/v1/account/profile'))).toHaveLength(1);
    });

    it('treats an ineligible account as unproven and an unavailable answer as unknown', async () => {
        expect(await harness(body => relations(body.sessionIds, () => 'not-own', null)).authority.inspect('x'))
            .toEqual({ relation: 'unknown', proof: null, reason: 'identity-unproven' });
        expect(await harness(() => ({ v: 1, callerAccountId: 'account-a', proof: null, unavailable: true })).authority.inspect('x'))
            .toEqual({ relation: 'unknown', proof: null, reason: 'ownership-unavailable' });
    });

    it.each([
        ['another caller account', (ids: string[]) => ({ ...relations(ids, () => 'own'), callerAccountId: 'account-b' })],
        ['another version', (ids: string[]) => ({ ...relations(ids, () => 'own'), v: 2 })],
        ['an unknown proof', (ids: string[]) => relations(ids, () => 'own', 'company-binding')],
        ['an unknown relation', (ids: string[]) => relations(ids, () => 'owner')],
        ['a missing target', (ids: string[]) => relations(ids.slice(1), () => 'own')],
        ['an extra target', (ids: string[]) => relations([...ids, 'extra'], () => 'own')],
        ['an extra field', (ids: string[]) => ({ ...relations(ids, () => 'own'), accountKind: 'personal' })],
        ['non-JSON', () => 'not json'],
    ])('discards the whole answer with %s', async (_name, answer) => {
        const result = await harness(body => answer(body.sessionIds)).authority.inspectMany(['a', 'b']);
        expect(Object.values(result).every(value => value.relation === 'unknown')).toBe(true);
    });

    it('stays unknown on an old server, an error, or an account it cannot read', async () => {
        expect((await harness(() => ({}), { status: 404 }).authority.inspect('x')).relation).toBe('unknown');
        const noAccount = harness(body => relations(body.sessionIds, () => 'own'), { profile: {} });
        expect((await noAccount.authority.inspect('x')).relation).toBe('unknown');
        expect(noAccount.calls.some(c => c.url.endsWith('/relation'))).toBe(false);
        const offline = harness(() => ({}));
        offline.fetch.mockRejectedValue(new Error('offline'));
        expect((await offline.authority.inspect('x')).relation).toBe('unknown');
    });

    it('answers unknown with no request when the host could not fix its identity', async () => {
        const fetch = vi.fn();
        const authority = createAgentRelationAuthority({ host: null, callerSessionId: 'hub', fetch: fetch as never });
        expect(await authority.inspect('x')).toEqual({ relation: 'unknown', proof: null, reason: 'identity-unavailable' });
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('host identity fixed at start', () => {
    it('uses only a server-confirmed machine id and this home\'s token', async () => {
        const credentials = async () => ({ token: 'happy-token' });
        expect(await readAgentRelationHost({ serverUrl: host.serverUrl, settings: async () => ({ machineId: 'machine-1', machineIdConfirmedByServer: true }), credentials }))
            .toEqual(host);
        expect(await readAgentRelationHost({ serverUrl: host.serverUrl, settings: async () => ({ machineId: 'machine-1' }), credentials })).toBeNull();
        expect(await readAgentRelationHost({ serverUrl: host.serverUrl, settings: async () => ({ machineId: 'machine-1', machineIdConfirmedByServer: true }), credentials: async () => null })).toBeNull();
        expect(await readAgentRelationHost({ serverUrl: host.serverUrl, settings: async () => { throw new Error('unreadable'); }, credentials })).toBeNull();
    });
});
