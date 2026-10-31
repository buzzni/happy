/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary F8 — `datakey:reseed`
 * moves only to a company key the pinned organization key declared.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { machineKeyDigest, signOrgSetupTokenDocument } from '@slopus/happy-wire';
import { encodeBase64 } from '@/api/encryption';
import { CompanyKeyReseedError, CompanyKeyReseedUnsettledError } from '@/datakey/machineControl';
import { createCompanyKeyReseedHandler } from './companyKeyReseedHandler';

const org = tweetnacl.sign.keyPair();
const stranger = tweetnacl.sign.keyPair();
const company = tweetnacl.box.keyPair();
const newMachineKey = new Uint8Array(32).fill(7);
const keyId = (publicKey: Uint8Array) => createHash('sha256').update(publicKey).digest('hex');
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

const pin = {
    publicKey: b64url(org.publicKey),
    approval: { body: { kind: 'device-approval', companyId: 'company-1', signingGeneration: 1, signingKeyId: keyId(org.publicKey) } },
};

async function declaration(overrides: Record<string, unknown> = {}, signer = org) {
    const body = {
        version: 1, kind: 'company-data-key-generation', companyId: 'company-1', signingGeneration: 1,
        signingKeyId: keyId(signer.publicKey), issuedAt: 1, generation: 2, dataPublicKey: b64url(company.publicKey),
        ...overrides,
    };
    return JSON.stringify(await signOrgSetupTokenDocument(body, signer.secretKey));
}

function setup(options: { pinned?: unknown; reseed?: (target: { publicKey: Uint8Array; generation: number }) => Promise<{ changed: boolean; machineKey: Uint8Array }> } = {}) {
    const events: string[] = [];
    const reseed = vi.fn(options.reseed ?? (async () => ({ changed: true, machineKey: newMachineKey })));
    const handler = createCompanyKeyReseedHandler({
        machineId: 'machine-1',
        pins: { get: async () => (options.pinned === undefined ? pin : options.pinned) as never },
        reseed,
        launches: { close: () => events.push('close'), reopen: () => events.push('reopen') },
        onChanged: () => events.push('restart'),
    });
    return { handler, reseed, events };
}

describe('createCompanyKeyReseedHandler', () => {
    it('moves to the declared key and answers with the new machine key digest, then restarts', async () => {
        const { handler, reseed, events } = setup();
        const answer = await handler({ companyId: 'company-1', declaration: await declaration() });

        expect(answer).toEqual({
            success: true,
            result: { changed: true, generation: 2, machineKeyDigest: encodeBase64(machineKeyDigest('machine-1', newMachineKey)) },
        });
        expect(reseed).toHaveBeenCalledWith({ publicKey: company.publicKey, generation: 2 });
        expect(events).toEqual(['close', 'restart']);
    });

    it('needs the organization key pinned through device approval', async () => {
        const { handler, reseed, events } = setup({ pinned: null });
        expect(await handler({ companyId: 'company-1', declaration: await declaration() })).toMatchObject({ success: false, errorCode: 'DEVICE_APPROVAL_REQUIRED' });
        expect(reseed).not.toHaveBeenCalled();
        expect(events).toEqual([]);
    });

    it('refuses a declaration the pinned key did not sign', async () => {
        const { handler, reseed } = setup();
        const answer = await handler({ companyId: 'company-1', declaration: await declaration({}, stranger) });
        expect(answer).toMatchObject({ success: false, errorCode: 'INVALID_DECLARATION' });
        expect(reseed).not.toHaveBeenCalled();
    });

    it.each([
        ['another company', { companyId: 'company-2' }, 'company-1'],
        ['another signing generation', { signingGeneration: 2 }, 'company-1'],
        ['a request for another company', {}, 'company-2'],
    ])('refuses %s', async (_label, overrides, companyId) => {
        const { handler, reseed } = setup({ pinned: companyId === 'company-2' ? { ...pin, approval: { body: { ...pin.approval.body, companyId: 'company-2' } } } : undefined });
        const answer = await handler({ companyId, declaration: await declaration(overrides) });
        expect(answer).toMatchObject({ success: false, errorCode: 'CONTEXT_MISMATCH' });
        expect(reseed).not.toHaveBeenCalled();
    });

    it('refuses another kind of signed document', async () => {
        const { handler, reseed } = setup();
        const rotation = JSON.stringify(await signOrgSetupTokenDocument({
            version: 1, kind: 'org-signing-rotation', companyId: 'company-1', signingGeneration: 1, signingKeyId: keyId(org.publicKey),
            issuedAt: 1, nextGeneration: 2, nextPublicKey: b64url(stranger.publicKey), nextKeyId: keyId(stranger.publicKey),
        }, org.secretKey));
        expect(await handler({ companyId: 'company-1', declaration: rotation })).toMatchObject({ success: false, errorCode: 'CONTEXT_MISMATCH' });
        expect(reseed).not.toHaveBeenCalled();
    });

    it('passes a refusal through and opens launches again', async () => {
        const { handler, events } = setup({ reseed: async () => { throw new CompanyKeyReseedError('STALE_GENERATION', 'old') } });
        expect(await handler({ companyId: 'company-1', declaration: await declaration() })).toMatchObject({ success: false, errorCode: 'STALE_GENERATION' });
        expect(events).toEqual(['close', 'reopen']);
    });

    it('stays closed and restarts when the server may already hold the new key', async () => {
        const { handler, events } = setup({ reseed: async () => { throw new CompanyKeyReseedUnsettledError('unknown') } });
        expect(await handler({ companyId: 'company-1', declaration: await declaration() })).toMatchObject({ success: false, errorCode: 'RESEED_FAILED' });
        expect(events).toEqual(['close', 'restart']);
        expect(await handler({ companyId: 'company-1', declaration: await declaration() })).toMatchObject({ success: false, errorCode: 'BUSY' });
    });

    it('does not restart when the machine already used the key', async () => {
        const { handler, events } = setup({ reseed: async () => ({ changed: false, machineKey: newMachineKey }) });
        expect(await handler({ companyId: 'company-1', declaration: await declaration() })).toMatchObject({ success: true, result: { changed: false } });
        expect(events).toEqual(['close', 'reopen']);
    });

    it('runs one reseed at a time', async () => {
        let finish: (value: { changed: boolean; machineKey: Uint8Array }) => void = () => {};
        const { handler, reseed } = setup({ reseed: () => new Promise((resolve) => { finish = resolve; }) });
        const first = handler({ companyId: 'company-1', declaration: await declaration() });
        await vi.waitFor(() => expect(reseed).toHaveBeenCalledTimes(1));
        expect(await handler({ companyId: 'company-1', declaration: await declaration() })).toMatchObject({ success: false, errorCode: 'BUSY' });
        finish({ changed: true, machineKey: newMachineKey });
        expect(await first).toMatchObject({ success: true });
        expect(reseed).toHaveBeenCalledTimes(1);
    });

    it('refuses malformed parameters', async () => {
        const { handler } = setup();
        expect(await handler({ companyId: 'company-1' })).toMatchObject({ success: false, errorCode: 'INVALID_PARAMS' });
    });
});
