import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sharedMachineRotationFixture } from '@slopus/happy-wire';
import { createOrgSubagentRoot } from './orgEndpointSubagentRoot';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { force: true, recursive: true }))); });
async function fixture(startThrows = false) {
    const home = await mkdtemp(join(tmpdir(), 'org-root-')); dirs.push(home);
    const now = 1_800_000_000_000;
    const calls = { create: 0, start: 0 };
    const ticketTemplate = sharedMachineRotationFixture.executionProof.ticket;
    const deps = { home, now: () => now, studioOrigin: 'https://studio.example', happyOrigin: 'https://happy.example',
        deviceSigningPublicKey: ticketTemplate.body.deviceSigningPublicKey,
        capture: async (_raw: unknown, launchId: string, nonce: string) => ({ companyId: 'company', machineAccountId: 'account',
            request: { machineId: 'machine', launchId, initialNonce: nonce, sessionTagHash: 'a'.repeat(64), sessionCreateBodyHash: 'b'.repeat(64) },
            snapshot: { key: 'private-snapshot', options: { initialPrompt: 'private-prompt' } } }),
        create: async () => { calls.create++; return { sessionId: 'root-session', snapshot: { session: 'private-session' } }; },
        start: async () => { calls.start++; if (startThrows) throw new Error('submission uncertain'); return { sessionId: 'root-session', additionalDirectories: { version: 1, accepted: ['/related'], skipped: {} }, launchMcpDropped: [{ name: 'unavailable', reason: 'not-installed' }] }; },
    };
    const root = createOrgSubagentRoot(deps);
    function ticket(prepared: { launchId: string; request: { initialNonce: string } }) {
        return { body: { ...ticketTemplate.body, audience: deps.happyOrigin, studioOrigin: deps.studioOrigin,
            companyId: 'company', machineId: 'machine', machineOwnerAccountId: 'account', sessionOwnerAccountId: 'account',
            launchId: prepared.launchId, operationId: prepared.launchId, initialNonce: prepared.request.initialNonce,
            sessionTagHash: 'a'.repeat(64), sessionCreateBodyHash: 'b'.repeat(64), issuedAt: now, expiresAt: now + 60_000 }, signature: ticketTemplate.signature };
    }
    return { deps, root, calls, ticket };
}
describe('user-gated root bootstrap', () => {
    it('returns only public approval input, and consumes an exact ticket once', async () => {
        const ctx = await fixture(), prepared = await ctx.root.prepare({});
        expect(JSON.stringify(prepared)).not.toContain('private-');
        expect(ctx.calls).toEqual({ create: 0, start: 0 });
        const input = { launchId: prepared.launchId, executionTicket: ctx.ticket(prepared) };
        expect(await ctx.root.start(input)).toMatchObject({ type: 'success', sessionId: 'root-session', additionalDirectories: { accepted: ['/related'] }, launchMcpDropped: [{ name: 'unavailable' }] });
        expect(await ctx.root.start(input)).toMatchObject({ type: 'success', sessionId: 'root-session' });
        expect(ctx.calls).toEqual({ create: 1, start: 1 });
    });
    it.each(['machineId', 'companyId', 'sessionTagHash', 'sessionCreateBodyHash', 'machineOwnerAccountId', 'initialNonce'])(
        'refuses a ticket for another %s before creating a session', async field => {
            const ctx = await fixture(), prepared = await ctx.root.prepare({}), ticket = ctx.ticket(prepared);
            const wrong = field === 'initialNonce' ? Buffer.alloc(32, 9).toString('base64url') : field.includes('Hash') ? 'c'.repeat(64) : 'other';
            await expect(ctx.root.start({ launchId: prepared.launchId, executionTicket: { ...ticket, body: { ...ticket.body, [field]: wrong } } })).rejects.toThrow();
            expect(ctx.calls).toEqual({ create: 0, start: 0 });
        });
    it('never repeats uncertain creation or provider submission on retry or restart', async () => {
        const ctx = await fixture(true), prepared = await ctx.root.prepare({});
        const input = { launchId: prepared.launchId, executionTicket: ctx.ticket(prepared) };
        expect(await ctx.root.start(input)).toMatchObject({ type: 'error', code: 'ORG_LLM_ENDPOINT_ROOT_START_UNCONFIRMED' });
        expect(await createOrgSubagentRoot(ctx.deps).start(input)).toMatchObject({ type: 'error', code: 'ORG_LLM_ENDPOINT_ROOT_START_UNCONFIRMED' });
        expect(ctx.calls).toEqual({ create: 1, start: 1 });
    });
});
