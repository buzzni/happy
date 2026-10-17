import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { afterEach, expect, it } from 'vitest';
import { canonicalOrgSetupTokenJson, signOrgSetupTokenDocument, orgSetupTokenKeyId } from '@slopus/happy-wire';
import { loadOrCreateDeviceKeys } from './deviceKeys';
import { createDeviceOrgPinStore } from './deviceOrgPinStore';
import { createSetupTokenAssignmentRecipient, sealSetupTokenAssignment } from './setupTokenAssignmentWire';
import { createSignedSetupTokenVerifier, setupTokenAccountDigest } from './signedSetupTokenAssignment';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const b64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const tokenA = 'sk-ant-oat01-' + 'a'.repeat(40);
const idA = '00000000-0000-4000-8000-000000000001';
const idB = '00000000-0000-4000-8000-000000000002';
const NOW = 1_800_000_000_000;

function account(managedAccountId: string, accessToken: string, credentialGeneration = 1, displayName = '개발 ' + managedAccountId.slice(-1)) {
    return { number: 1, kind: 'oauth', email: `managed-${managedAccountId}@setup-token.local`, credentialType: 'setup_token', managedAccountId,
        credentialGeneration, displayName, credentials: { claudeAiOauth: { accessToken, scopes: ['user:inference'] } },
        config: { oauthAccount: { emailAddress: `managed-${managedAccountId}@setup-token.local` } } };
}
async function fixture(machineType: 'dedicated' | 'shared' = 'dedicated') {
    const home = await mkdtemp(join(tmpdir(), 'signed-setup-')); homes.push(home);
    const keys = await loadOrCreateDeviceKeys(home, 'machine');
    const signer = nacl.sign.keyPair();
    const signingKeyId = await orgSetupTokenKeyId(signer.publicKey);
    const ownerUserId = machineType === 'dedicated' ? 'user' : null;
    const approval = await signOrgSetupTokenDocument({ version: 1, kind: 'device-approval', companyId: 'company', machineId: 'machine', machineType, ownerUserId,
        signingGeneration: 1, signingKeyId, issuedAt: 1000, approvalId: 'approval', approvalRevision: 1,
        deviceSigningPublicKey: b64(keys.signing.publicKey), recipientPublicKey: b64(keys.recipient.publicKey), enrollmentDigest: 'a'.repeat(64) }, signer.secretKey);
    const pins = createDeviceOrgPinStore({ home, machineId: 'machine', keys });
    await pins.pin({ publicKey: b64(signer.publicKey), approval });
    const recipient = createSetupTokenAssignmentRecipient(keys.recipient.secretKey);
    const verifier = () => createSignedSetupTokenVerifier({ home, machineId: 'machine', keys, pins, recipient, now: () => NOW });
    const assignment = async (accounts: Array<ReturnType<typeof account>>, change: Record<string, unknown> = {}, secretKey = signer.secretKey) =>
        canonicalOrgSetupTokenJson(await signOrgSetupTokenDocument({ version: 1, kind: 'ai-assignment', companyId: 'company', signingGeneration: 1, signingKeyId,
            issuedAt: 2000, bindingId: 'binding', assignmentRevision: 1, credentialGroupId: 'cg', credentialGroupRevision: 3,
            target: machineType === 'dedicated' ? { kind: 'user-group', id: 'ug' } : { kind: 'machine', id: 'machine' },
            accounts: accounts.map(a => ({ managedAccountId: a.managedAccountId, credentialGeneration: a.credentialGeneration,
                credentialDigest: setupTokenAccountDigest({ companyId: 'company', managedAccountId: a.managedAccountId, credentialGeneration: a.credentialGeneration,
                    displayName: a.displayName, accessToken: a.credentials.claudeAiOauth.accessToken }) }))
                .sort((x, y) => (x.managedAccountId < y.managedAccountId ? -1 : 1)),
            ...change }, secretKey));
    const request = (accounts: unknown[], documents: string[], context: Record<string, unknown> = {}) => {
        const principal = machineType === 'shared' ? { userId: 'machine', principalType: 'machine' as const } : { userId: 'user' };
        const sealed = sealSetupTokenAssignment({ version: 1, scope: 'company', machineId: 'machine', provider: 'claude', generation: 4,
            fingerprint: 'f'.repeat(64), leaseId: 'lease', expiresAt: NOW + 60_000, payload: JSON.stringify({ version: 1, encrypted: false, accounts }),
            ...principal, ...context }, recipient.publicKey);
        return { version: 1, scope: 'company', machineId: 'machine', provider: 'claude', credentialType: 'setup_token', payload: null, generation: 4,
            fingerprint: 'f'.repeat(64), leaseId: 'lease', sealedPayload: sealed,
            ...(machineType === 'shared' ? { principalType: 'machine' } : { userId: 'user' }),
            approval: canonicalOrgSetupTokenJson(approval), assignments: documents };
    };
    return { home, keys, signer, signingKeyId, approval, pins, verifier, assignment, request };
}

it('pins the contract §4 per-account digest to the vector the web server also uses', () => {
    expect(setupTokenAccountDigest({ companyId: 'company', managedAccountId: idA, credentialGeneration: 1, displayName: '개발 B', accessToken: 'sk-ant-oat01-' + 'b'.repeat(40) }))
        .toBe('a74819d693b8927d7cdf4783a75f3577e6f62732966cdd97696664d6f6d3a163');
});

it('accepts a sealed payload whose setup-token accounts exactly match the pinned organization\'s signed assignment', async () => {
    const f = await fixture();
    const accounts = [account(idA, tokenA), account(idB, 'sk-ant-oat01-' + 'c'.repeat(40))];
    const outer = await f.verifier().verify(f.request(accounts, [await f.assignment(accounts)]));
    expect(outer).not.toHaveProperty('approval');
    expect(outer).not.toHaveProperty('assignments');
    expect(outer).toMatchObject({ scope: 'company', credentialType: 'setup_token', userId: 'user' });
});

it('accepts a shared machine only for a statement targeting this machine', async () => {
    const f = await fixture('shared');
    const accounts = [account(idA, tokenA)];
    await expect(f.verifier().verify(f.request(accounts, [await f.assignment(accounts)]))).resolves.toMatchObject({ principalType: 'machine' });
    await expect(f.verifier().verify(f.request(accounts, [await f.assignment(accounts, { bindingId: 'b2', target: { kind: 'machine', id: 'other' } })])))
        .rejects.toThrow('CONTEXT_MISMATCH');
});

it('refuses delivery without a local pin, with a forged signature, or with another organization\'s approval', async () => {
    const f = await fixture();
    const accounts = [account(idA, tokenA)];
    const forger = nacl.sign.keyPair();
    await expect(f.verifier().verify(f.request(accounts, [await f.assignment(accounts, { signingKeyId: await orgSetupTokenKeyId(forger.publicKey) }, forger.secretKey)])))
        .rejects.toThrow('SIGNATURE_INVALID');
    const otherApproval = await signOrgSetupTokenDocument({ ...f.approval.body, approvalId: 'other' }, f.signer.secretKey);
    await expect(f.verifier().verify({ ...f.request(accounts, [await f.assignment(accounts)]), approval: canonicalOrgSetupTokenJson(otherApproval) }))
        .rejects.toThrow('DEVICE_APPROVAL_MISMATCH');
    const fresh = await fixture();
    const unpinned = createSignedSetupTokenVerifier({ home: fresh.home, machineId: 'machine', keys: fresh.keys,
        pins: { get: async () => null }, recipient: createSetupTokenAssignmentRecipient(fresh.keys.recipient.secretKey), now: () => NOW });
    await expect(unpinned.verify(fresh.request(accounts, [await fresh.assignment(accounts)]))).rejects.toThrow('DEVICE_APPROVAL_REQUIRED');
});

it('rejects a payload that differs from the signed accounts: extra, missing, replaced token, other generation or non-setup-token account', async () => {
    const f = await fixture();
    const a = account(idA, tokenA), b = account(idB, 'sk-ant-oat01-' + 'c'.repeat(40));
    const signed = await f.assignment([a]);
    for (const payload of [[a, b], [], [account(idA, 'sk-ant-oat01-' + 'z'.repeat(40))], [account(idA, tokenA, 2)], [account(idA, tokenA, 1, '다른 이름')],
        [a, { number: 2, email: 'person@example.com', credentials: { claudeAiOauth: { accessToken: 'oauth' } }, config: {} }],
        [{ ...a, credentialType: 'oauth' }]])
        await expect(f.verifier().verify(f.request(payload, [signed]))).rejects.toThrow('ASSIGNMENT_CONTENT_MISMATCH');
    await expect(f.verifier().verify(f.request([a], []))).rejects.toThrow('SIGNED_ASSIGNMENT_REQUIRED');
});

it('rejects statements for another company, signing generation, principal, or kind of target', async () => {
    const f = await fixture();
    const accounts = [account(idA, tokenA)];
    for (const change of [{ companyId: 'other' }, { target: { kind: 'machine', id: 'machine' } }])
        await expect(f.verifier().verify(f.request(accounts, [await f.assignment(accounts, change)]))).rejects.toThrow('CONTEXT_MISMATCH');
    await expect(f.verifier().verify(f.request(accounts, [await f.assignment(accounts)], { userId: 'someone-else' }))).rejects.toThrow('CONTEXT_MISMATCH');
});

it('remembers accepted revisions across restarts and rejects replay of an older or conflicting statement', async () => {
    const f = await fixture();
    const accounts = [account(idA, tokenA)];
    const second = await f.assignment(accounts, { assignmentRevision: 2, credentialGroupRevision: 4 });
    await f.verifier().verify(f.request(accounts, [second]));
    await expect(f.verifier().verify(f.request(accounts, [second]))).resolves.toBeTruthy();
    await expect(f.verifier().verify(f.request(accounts, [await f.assignment(accounts)]))).rejects.toThrow('REVISION_STALE');
    await expect(f.verifier().verify(f.request(accounts, [await f.assignment(accounts, { assignmentRevision: 2, credentialGroupRevision: 5 })])))
        .rejects.toThrow('REVISION_CONFLICT');
});

it('verifies before opening nothing when the kill switch is on', async () => {
    const f = await fixture();
    const accounts = [account(idA, tokenA)];
    const verifier = createSignedSetupTokenVerifier({ home: f.home, machineId: 'machine', keys: f.keys, pins: f.pins,
        recipient: createSetupTokenAssignmentRecipient(f.keys.recipient.secretKey), now: () => NOW, killSwitch: () => true });
    await expect(verifier.verify(f.request(accounts, [await f.assignment(accounts)]))).rejects.toThrow('CLAUDE_SETUP_TOKEN_ASSIGNMENT_DISABLED');
});
