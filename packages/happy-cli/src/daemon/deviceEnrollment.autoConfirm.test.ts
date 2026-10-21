import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';
import { signOrgSetupTokenDocument, orgSetupTokenKeyId } from '@slopus/happy-wire';
import { createDeviceEnrollment } from './deviceEnrollment';

// aplus specs/shared-machine-server-signing S6 (contract §20.5) — a shared PC confirms a server-signed approval itself.
function memoryMarker(initial: 'shared' | 'dedicated' | null = null) {
    let value = initial;
    return { read: vi.fn(async () => value), record: vi.fn(async (type: 'shared' | 'dedicated') => { if (value) return 'exists' as const; value = type; return 'recorded' as const; }) };
}
async function sharedFixture(options: { machineType?: 'shared' | 'dedicated'; autoConfirm?: ReturnType<typeof vi.fn>; marker?: ReturnType<typeof memoryMarker> } = {}) {
    const machineType = options.machineType ?? 'shared';
    const store = { get: vi.fn().mockResolvedValue(null), pin: vi.fn().mockResolvedValue(undefined) };
    const keys = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() };
    const signer = nacl.sign.keyPair();
    const state = createDeviceEnrollment({ machineId: 'machine', keys, store, now: () => 1000,
        ...(options.autoConfirm ? { autoConfirm: options.autoConfirm as never } : {}),
        ...(options.marker ? { marker: options.marker } : {}) });
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
        const marker = memoryMarker();
        const f = await sharedFixture({ autoConfirm, marker });
        await f.state.approve(f.approval);
        if (!f.state.status()?.pinned) await f.confirm();
        expect(marker.record).toHaveBeenCalledExactlyOnceWith('shared');
    }
    const marker = memoryMarker();
    const dedicated = await sharedFixture({ machineType: 'dedicated', marker });
    await dedicated.state.approve(dedicated.approval);
    await dedicated.confirm();
    expect(dedicated.store.pin).toHaveBeenCalledTimes(1);
    expect(marker.record).not.toHaveBeenCalled();
});

// S6b·S6c — "use this PC as the organization's shared PC", from the PC itself or an administrator's customer-key request.
describe('useAsShared', () => {
    it('marks an unmarked PC shared and confirms the server-signed approval it is waiting on', async () => {
        const marker = memoryMarker();
        const f = await sharedFixture({ marker, autoConfirm: vi.fn(async () => (await marker.read()) === 'shared') });
        await f.state.approve(f.approval);
        expect(f.state.status()?.pinned).toBe(false);
        await expect(f.state.useAsShared({ companyId: 'company', machineId: 'machine' }, 'local')).resolves.toEqual({ accepted: true, confirmed: true });
        expect(await marker.read()).toBe('shared');
        expect(f.store.pin).toHaveBeenCalledTimes(1);
    });

    it('accepts an administrator\'s request without a waiting approval, but the PC\'s own request only while one waits', async () => {
        const remote = await sharedFixture({ marker: memoryMarker(), autoConfirm: vi.fn(async () => true) });
        await expect(remote.state.useAsShared({ companyId: 'other-company', machineId: 'machine' }, 'remote')).resolves.toEqual({ accepted: true, confirmed: false });
        const local = await sharedFixture({ marker: memoryMarker(), autoConfirm: vi.fn(async () => true) });
        await expect(local.state.useAsShared({ companyId: 'other-company', machineId: 'machine' }, 'local')).rejects.toThrow('DEVICE_AUTO_APPROVAL_REQUIRED');
        const dedicated = await sharedFixture({ machineType: 'dedicated', marker: memoryMarker(), autoConfirm: vi.fn(async () => true) });
        await expect(dedicated.state.useAsShared({ companyId: 'company', machineId: 'machine' }, 'local')).rejects.toThrow('DEVICE_AUTO_APPROVAL_REQUIRED');
    });

    it('refuses another machine, an already marked PC, and a daemon that cannot record or confirm', async () => {
        const f = await sharedFixture({ marker: memoryMarker(), autoConfirm: vi.fn(async () => true) });
        await expect(f.state.useAsShared({ companyId: 'company', machineId: 'other' }, 'remote')).rejects.toThrow('DEVICE_USE_AS_SHARED_MISMATCH');
        for (const existing of ['shared', 'dedicated'] as const) {
            const marked = await sharedFixture({ marker: memoryMarker(existing), autoConfirm: vi.fn(async () => true) });
            await expect(marked.state.useAsShared({ companyId: 'company', machineId: 'machine' }, 'remote')).rejects.toThrow('DEVICE_MACHINE_TYPE_SET');
            // Already marked is the answer even when nothing waits, so the PC does not suggest waiting for an approval.
            await expect(marked.state.useAsShared({ companyId: 'other-company', machineId: 'machine' }, 'local')).rejects.toThrow('DEVICE_MACHINE_TYPE_SET');
        }
        const unable = await sharedFixture({ marker: memoryMarker() });
        await expect(unable.state.useAsShared({ companyId: 'company', machineId: 'machine' }, 'remote')).rejects.toThrow('DEVICE_USE_AS_SHARED_UNAVAILABLE');
    });

    it('reports the marker and whether a shared approval waits for this PC', async () => {
        const f = await sharedFixture({ marker: memoryMarker(), autoConfirm: vi.fn(async () => false) });
        await expect(f.state.sharedStatus('company')).resolves.toEqual({ machineType: null, awaitingSharedConfirmation: true });
        await f.state.useAsShared({ companyId: 'company', machineId: 'machine' }, 'local');
        await expect(f.state.sharedStatus('company')).resolves.toEqual({ machineType: 'shared', awaitingSharedConfirmation: true });
        await expect(f.state.sharedStatus('other')).resolves.toEqual({ machineType: 'shared', awaitingSharedConfirmation: false });
    });
});
