import { z } from 'zod';
import { orgSetupTokenKeyId } from '@slopus/happy-wire';

/**
 * aplus specs/shared-machine-server-signing S6 (contract §20.5) — the organization signing key this machine's trusted
 * Studio origin serves. A shared PC compares a server-signed approval with it before pinning, so a key placed in
 * Studio's database alone cannot become the PC's pin. Null when the organization has no server-held key (the PC keeps
 * the manual confirmation); any other answer is a failure, never a key.
 */
export type TrustedOrgSigningKey = { signingGeneration: number; publicKey: string; keyId: string };
const MAX_BYTES = 4096;
const keySchema = z.object({
    signingGeneration: z.number().int().min(1),
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    keyId: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export async function fetchTrustedOrgSigningKey(input: {
    studioOrigin: string; token: string; companyId: string; machineId: string; fetchImpl?: typeof fetch;
}): Promise<TrustedOrgSigningKey | null> {
    const url = new URL('/api/org-signing-key/daemon/public', input.studioOrigin);
    url.searchParams.set('companyId', input.companyId);
    url.searchParams.set('machineId', input.machineId);
    const response = await (input.fetchImpl ?? fetch)(url, {
        redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${input.token}` },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('ORG_SIGNING_KEY_UNAVAILABLE');
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error('ORG_SIGNING_KEY_INVALID');
    let key: TrustedOrgSigningKey;
    try { key = keySchema.parse(JSON.parse(text)); } catch { throw new Error('ORG_SIGNING_KEY_INVALID'); }
    const bytes = Buffer.from(key.publicKey, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== key.publicKey || await orgSetupTokenKeyId(bytes) !== key.keyId)
        throw new Error('ORG_SIGNING_KEY_INVALID');
    return key;
}
