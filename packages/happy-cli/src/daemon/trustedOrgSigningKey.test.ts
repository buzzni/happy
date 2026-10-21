import nacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { orgSetupTokenKeyId } from '@slopus/happy-wire';
import { fetchTrustedOrgSigningKey } from './trustedOrgSigningKey';

const pair = nacl.sign.keyPair();
const publicKey = Buffer.from(pair.publicKey).toString('base64url');
const respond = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const call = (fetchImpl: typeof fetch) => fetchTrustedOrgSigningKey({ studioOrigin: 'https://studio.example.com', token: 'machine-token', companyId: 'company 1', machineId: 'machine-1', fetchImpl });

it('reads the organization key from the trusted origin with the machine bearer, refusing redirects', async () => {
    const keyId = await orgSetupTokenKeyId(pair.publicKey);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond(200, { signingGeneration: 1, publicKey, keyId }));
    await expect(call(fetchImpl as unknown as typeof fetch)).resolves.toEqual({ signingGeneration: 1, publicKey, keyId });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://studio.example.com/api/org-signing-key/daemon/public?companyId=company+1&machineId=machine-1');
    expect(init).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer machine-token' } });
});

it('answers null when the organization has no server-held key, so the PC keeps the manual confirmation', async () => {
    await expect(call((async () => respond(404, { error: 'ORG_SERVER_SIGNER_MISSING' })) as unknown as typeof fetch)).resolves.toBeNull();
});

it('refuses a key whose id it cannot recompute, a malformed key and any other failure', async () => {
    const keyId = await orgSetupTokenKeyId(pair.publicKey);
    for (const body of [{ signingGeneration: 1, publicKey, keyId: 'f'.repeat(64) }, { signingGeneration: 1, publicKey: 'short', keyId }, { signingGeneration: 0, publicKey, keyId }, { signingGeneration: 1, publicKey, keyId, extra: 1 }])
        await expect(call((async () => respond(200, body)) as unknown as typeof fetch)).rejects.toThrow('ORG_SIGNING_KEY_INVALID');
    await expect(call((async () => respond(409, { error: 'ORG_SERVER_SIGNER_MISMATCH' })) as unknown as typeof fetch)).rejects.toThrow('ORG_SIGNING_KEY_UNAVAILABLE');
    await expect(call((async () => respond(200, 'x'.repeat(20_000))) as unknown as typeof fetch)).rejects.toThrow('ORG_SIGNING_KEY_INVALID');
});
