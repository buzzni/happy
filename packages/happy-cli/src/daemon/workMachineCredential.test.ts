import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as credential from './workMachineCredential';
const { getWorkMachineDeviceId, openWorkMachineCredentials } = credential;

const serverUrl = 'https://happy.example.test';
let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'work-machine-test-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('work machine device credentials', () => {
    it('proves possession of the enrolled machine device key without exposing private material', async () => {
        await writeFile(join(home, 'sessions.json'), JSON.stringify({ sessions: { 'S-2': {}, 'S-1': {} } }), { mode: 0o600 });
        const prepared = await credential.prepareWorkMachineDevice(home, 'machine');
        expect(prepared.machineId).toBe('machine');
        expect(Object.keys(prepared.proof).sort()).toEqual(['issuedAt', 'publicKey', 'signature']);
        const der = Buffer.from(prepared.proof.publicKey, 'base64url');
        const publicKey = createPublicKey({ key: der, type: 'spki', format: 'der' });
        expect(prepared.deviceId).toBe(await getWorkMachineDeviceId(home, 'machine'));
        expect(prepared.sessionIds).toEqual(['S-1', 'S-2']);
        const wire = Buffer.from(JSON.stringify(['happy-work-machine-enrollment-v2', 'machine', prepared.deviceId, prepared.proof.issuedAt, prepared.sessionIds]));
        expect(verify(null, wire, publicKey, Buffer.from(prepared.proof.signature, 'base64url'))).toBe(true);
    });

    it('refuses to prove an empty inventory when the session store is corrupt', async () => {
        await writeFile(join(home, 'sessions.json'), '{', { mode: 0o600 });
        await expect(credential.prepareWorkMachineDevice(home, 'machine')).rejects.toThrow('inventory');
    });

    it('loads only a private local binding and never silently ignores a corrupt or redirected record', async () => {
        const deviceId = await getWorkMachineDeviceId(home, 'machine');
        const binding = { accountId: 'owner', machineId: 'machine', generation: 2, deviceId, serverOrigin: serverUrl };
        await expect(credential.readWorkMachineExecutionBinding(home)).resolves.toBeNull();
        await credential.saveWorkMachineExecutionBinding(home, binding);
        await expect(credential.readWorkMachineExecutionBinding(home)).resolves.toEqual(binding);
        await expect(credential.saveWorkMachineExecutionBinding(home, { ...binding, generation: 1 })).rejects.toThrow();
        const path = join(home, 'work-machine-execution.json');
        await rm(path);
        await symlink(join(home, 'missing-binding'), path);
        await expect(credential.readWorkMachineExecutionBinding(home)).rejects.toThrow('binding');
    });

    it('refreshes before expiry, retries a brief outage and stops when the device is revoked', async () => {
        vi.useFakeTimers();
        try {
            const renew = vi.fn()
                .mockRejectedValueOnce(new credential.WorkMachineRenewalError(false))
                .mockImplementationOnce(async () => ({ token: 'wmx_second', expiresAt: Date.now() + 300_000 }))
                .mockRejectedValueOnce(new credential.WorkMachineRenewalError(true));
            const apply = vi.fn(), stop = vi.fn();
            const dispose = credential.watchWorkMachineCredential({
                initial: { token: 'wmx_first', expiresAt: Date.now() + 300_000 }, renew, apply, stop, retrying: vi.fn(),
            });
            await vi.advanceTimersByTimeAsync(239_000);
            expect(renew).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(renew).toHaveBeenCalledTimes(1);
            expect(stop).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(5_000);
            expect(apply).toHaveBeenCalledWith(expect.objectContaining({ token: 'wmx_second' }));
            await vi.advanceTimersByTimeAsync(240_000);
            expect(stop).toHaveBeenCalledWith('revoked');
            await vi.advanceTimersByTimeAsync(300_000);
            expect(renew).toHaveBeenCalledTimes(3);
            dispose();
        } finally { vi.useRealTimers(); }
    });

    it('uses the same device signing key after restart and binds daemon and session credentials to the selected generation', async () => {
        const deviceId = await getWorkMachineDeviceId(home, 'machine');
        const binding = { accountId: 'owner', machineId: 'machine', generation: 2, deviceId, serverOrigin: serverUrl };
        const request = vi.fn<typeof fetch>(async () => Response.json({ token: 'wmx_fresh', expiresAt: Date.now() + 300_000 }));
        for (const sessionId of [undefined, 'existing-session']) {
            const device = await openWorkMachineCredentials(home, serverUrl, binding, request);
            expect(await device.renew(sessionId)).toMatchObject({ token: 'wmx_fresh' });
            const [url, init] = request.mock.lastCall!;
            expect(url).toBe(`${serverUrl}/v1/work-machines/machine/execution-renewal`);
            expect(init?.redirect).toBe('error');
            expect(new Headers(init?.headers).get('Authorization')).toBeNull();
            const body = JSON.parse(String(init?.body));
            const der = Buffer.from(body.publicKey, 'base64url');
            const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
            expect(createHash('sha256').update(der).digest('base64url')).toBe(deviceId);
            expect(verify(null, Buffer.from(JSON.stringify([
                'happy-work-machine-renew-v1', 'owner', 'machine', deviceId, 2, sessionId ?? null, body.issuedAt, body.nonce,
            ])), key, Buffer.from(body.signature, 'base64url'))).toBe(true);
        }
        expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).nonce)
            .not.toBe(JSON.parse(String(request.mock.calls[1]?.[1]?.body)).nonce);
    });

    it('checks origin and device binding before sending and surfaces a revoked generation', async () => {
        const deviceId = await getWorkMachineDeviceId(home, 'machine');
        const binding = { accountId: 'owner', machineId: 'machine', generation: 1, deviceId, serverOrigin: serverUrl };
        const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 403 }));
        await expect(openWorkMachineCredentials(home, 'https://other.example.test', binding, request)).rejects.toThrow('server');
        await expect(openWorkMachineCredentials(home, serverUrl, { ...binding, deviceId: 'A'.repeat(43) }, request)).rejects.toThrow('device');
        expect(request).not.toHaveBeenCalled();
        const device = await openWorkMachineCredentials(home, serverUrl, binding, request);
        await expect(device.renew()).rejects.toMatchObject({ revoked: true });
    });

    it('opens a protected provider only for an existing conversation and refreshes the same scope', async () => {
        const deviceId = await getWorkMachineDeviceId(home, 'machine');
        const request = vi.fn<typeof fetch>(async () => Response.json({ token: 'wmx_session', expiresAt: Date.now() + 300_000 }));
        await expect(credential.openWorkMachineSessionCredentials(home, serverUrl, undefined, request)).resolves.toBeNull();
        await credential.saveWorkMachineExecutionBinding(home, { accountId: 'owner', machineId: 'machine', generation: 2, deviceId, serverOrigin: serverUrl });
        await expect(credential.openWorkMachineSessionCredentials(home, serverUrl, undefined, request)).rejects.toThrow('existing session');
        expect(request).not.toHaveBeenCalled();
        const session = await credential.openWorkMachineSessionCredentials(home, serverUrl, 'existing', request);
        expect(session).toMatchObject({ sessionId: 'existing', initial: { token: 'wmx_session' } });
        expect(await session!.renew()).toMatchObject({ token: 'wmx_session' });
        expect(request.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).sessionId)).toEqual(['existing', 'existing']);
    });
});
