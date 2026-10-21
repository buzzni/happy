import nacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { signOrgSetupTokenDocument, orgSetupTokenKeyId } from '@slopus/happy-wire';
import { createDeviceEnrollment } from './deviceEnrollment';

// aplus specs/shared-machine-server-signing S6 (contract §20.5) — a shared PC confirms a server-signed approval itself.
async function sharedFixture(options: { machineType?: 'shared' | 'dedicated'; autoConfirm?: ReturnType<typeof vi.fn>; onSharedPinned?: ReturnType<typeof vi.fn> } = {}) {
    const machineType = options.machineType ?? 'shared';
    const store = { get: vi.fn().mockResolvedValue(null), pin: vi.fn().mockResolvedValue(undefined) };
    const keys = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() };
    const signer = nacl.sign.keyPair();
    const state = createDeviceEnrollment({ machineId: 'machine', keys, store, now: () => 1000,
        ...(options.autoConfirm ? { autoConfirm: options.autoConfirm as never } : {}),
        ...(options.onSharedPinned ? { onSharedPinned: options.onSharedPinned as never } : {}) });
    const pending = await state.begin({ companyId: 'company', machineType, ownerUserId: machineType === 'shared' ? null : 'user',
        orgSigningPublicKey: Buffer.from(signer.publicKey).toString('base64url'), signingGeneration: 1 });
    const t = pending.transcript;
    const approval = JSON.stringify(await signOrgSetupTokenDocument({ version: 1, kind: 'device-approval', companyId: t.companyId,
        signingGeneration: 1, signingKeyId: await orgSetupTokenKeyId(signer.publicKey), issuedAt: 1000, approvalId: 'approval',
        approvalRevision: 1, machineId: t.machineId, machineType: t.machineType, ownerUserId: t.ownerUserId,
        deviceSigningPublicKey: t.deviceSigningPublicKey, recipientPublicKey: t.recipientPublicKey, enrollmentDigest: pending.digest }, signer.secretKey));
    const confirm = () => state.confirm({ companyId: 'company', machineId: 'machine', enrollmentDigest: pending.digest });
    return { state, store, pending, approval, confirm };
}

it('pins a shared PC\'s server-signed approval without a local confirmation when the automatic check agrees', async () => {
    const autoConfirm = vi.fn(async () => true);
    const f = await sharedFixture({ autoConfirm });
    expect(f.state.autoConfirms).toBe(true);
    await f.state.approve(f.approval);
    expect(f.store.pin).toHaveBeenCalledTimes(1);
    expect(f.state.status()).toMatchObject({ locallyConfirmed: true, pinned: true });
    const [{ transcript, approval }] = autoConfirm.mock.calls[0] as unknown as [{ transcript: { machineType: string; orgSigningPublicKey: string }; approval: { body: { signingKeyId: string } } }];
    expect(transcript).toMatchObject({ machineType: 'shared', orgSigningPublicKey: f.pending.transcript.orgSigningPublicKey });
    expect(approval.body.signingKeyId).toMatch(/^[0-9a-f]{64}$/);
});

it('waits for the local confirmation when the automatic check declines or fails', async () => {
    for (const autoConfirm of [vi.fn(async () => false), vi.fn(async () => { throw new Error('studio unreachable'); })]) {
        const f = await sharedFixture({ autoConfirm });
        await expect(f.state.approve(f.approval)).resolves.toBeUndefined();
        expect(f.store.pin).not.toHaveBeenCalled();
        expect(f.state.status()).toMatchObject({ locallyConfirmed: false, pinned: false });
        await f.confirm();
        expect(f.store.pin).toHaveBeenCalledTimes(1);
    }
});

it('never confirms a dedicated PC automatically, and does not advertise it without an automatic check', async () => {
    const autoConfirm = vi.fn(async () => true);
    const f = await sharedFixture({ machineType: 'dedicated', autoConfirm });
    await f.state.approve(f.approval);
    expect(autoConfirm).not.toHaveBeenCalled();
    expect(f.store.pin).not.toHaveBeenCalled();
    expect((await sharedFixture()).state.autoConfirms).toBe(false);
});

it('marks the PC as shared once a shared approval is pinned, however it was confirmed', async () => {
    for (const autoConfirm of [vi.fn(async () => true), vi.fn(async () => false)]) {
        const onSharedPinned = vi.fn(async () => {});
        const f = await sharedFixture({ autoConfirm, onSharedPinned });
        await f.state.approve(f.approval);
        if (!f.state.status()?.pinned) await f.confirm();
        expect(onSharedPinned).toHaveBeenCalledTimes(1);
    }
    const onSharedPinned = vi.fn(async () => {});
    const dedicated = await sharedFixture({ machineType: 'dedicated', onSharedPinned });
    await dedicated.state.approve(dedicated.approval);
    await dedicated.confirm();
    expect(dedicated.store.pin).toHaveBeenCalledTimes(1);
    expect(onSharedPinned).not.toHaveBeenCalled();
});
