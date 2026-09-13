import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createManagedSupervisorReadiness } from './managedSupervisorReadiness';
import { assertProvisioningStat, readRootProtectedFile, type ManagedIdentityResolution, type ManagedProvisioningDeps } from './managedRuntimeIdentity';
import { readManagedLauncherBinding } from './launch/managedLauncherBinding';
import { readManagedSupervisorAttestation } from '@/managed/managedSupervisorAttestation';
import type { LauncherHelloResult } from './launch/launcherClient';

const verifier = generateKeyPairSync('ed25519').publicKey;
function fixture() {
    const admitted: Extract<ManagedIdentityResolution, { status: 'active' }> = {
        status: 'active', markerSha256: 'a'.repeat(64), identity: {
            runtimeId: 'runtime-1', provisioningOperationId: 'operation-1', stateDir: '/state',
            workspaceId: 'workspace-1', projectId: 'project-1', keyId: 'key-1', happyMachineId: 'happy-1',
            configDigest: 'b'.repeat(64), providerMachineId: 'machine-1', providerInstanceId: 'instance-1',
            providerVolumeId: 'volume-1', volumeCreatedByOperation: false, verifier, tenant: 'company:1',
            isolation: { backend: 'privileged-launch-supervisor', provider: { uid: 10601, gid: 10601 },
                executor: { uid: 10602, gid: 10602 }, cgroupRoot: '/sys/fs/cgroup/saycode' },
            toolPolicy: { grantTtlMs: 1000, callTimeoutMs: 1000 }, checkpoint: { drainBudgetMs: 1000 },
            checkpointSchedule: { periodMs: 1000, onTurnBoundary: true },
        },
    };
    const binding = { socketPath: '/state/launcher/launcher.sock', token: 't'.repeat(43) };
    const hello = { instanceNonce: 'n'.repeat(32), runtimeId: 'runtime-1',
        provisioningOperationId: 'operation-1', markerSha256: admitted.markerSha256 };
    const attestation = { version: 1 as const, ...hello, socketPath: binding.socketPath };
    const helloFn = vi.fn<() => Promise<LauncherHelloResult>>(async () => ({ ok: true, result: { ...hello } }));
    const provisioning: ManagedProvisioningDeps = {
        getuid: () => 501,
        lstatDir: vi.fn(() => ({ uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false })),
        statGate: vi.fn(() => null),
        probeIsolationBackend: vi.fn<ManagedProvisioningDeps['probeIsolationBackend']>(() => ({ verified: true })),
    };
    const readProtectedFile = vi.fn<typeof readRootProtectedFile>(() => ({ kind: 'ok', content: 'already admitted bytes', sha256: admitted.markerSha256 }));
    const readBinding = vi.fn<typeof readManagedLauncherBinding>(() => ({ ok: true, binding: { ...binding } }));
    const readAttestation = vi.fn<typeof readManagedSupervisorAttestation>(() => ({ ok: true, attestation: { ...attestation } }));
    const input = { admitted, markerPath: '/etc/saycode/managed-runtime.json', launcher: { binding, hello: helloFn } };
    const over = { provisioning, readProtectedFile, readBinding, readAttestation };
    return { input, over, admitted, binding, hello, attestation, helloFn };
}

describe('fresh managed supervisor readiness', () => {
    it('compares fresh records and hello using the fixed protected marker gate without probing again', async () => {
        const f = fixture(); const observer = createManagedSupervisorReadiness(f.input, f.over);
        expect(await observer.observe()).toEqual({ verified: true });
        expect(f.over.readProtectedFile).toHaveBeenCalledExactlyOnceWith(f.input.markerPath, assertProvisioningStat);
        expect(f.over.readAttestation).toHaveBeenCalledExactlyOnceWith({ stateDir: '/state', deps: f.over.provisioning });
        expect(f.over.readBinding).toHaveBeenCalledExactlyOnceWith({ stateDir: '/state', deps: f.over.provisioning });
        expect(f.over.provisioning.statGate).not.toHaveBeenCalled();
        expect(f.over.provisioning.probeIsolationBackend).not.toHaveBeenCalled();
        expect(f.helloFn).toHaveBeenCalledExactlyOnceWith();
    });
    it('refuses relative marker paths before any observation and refuses daemon-owned ancestors', async () => {
        const relative = fixture(); relative.input.markerPath = 'relative.json';
        expect(await createManagedSupervisorReadiness(relative.input, relative.over).observe())
            .toEqual({ verified: false, reason: 'backend-marker-unavailable' });
        expect(relative.over.provisioning.lstatDir).not.toHaveBeenCalled();
        expect(relative.over.readProtectedFile).not.toHaveBeenCalled();
        const owned = fixture(); owned.over.provisioning.lstatDir = vi.fn(() => ({ uid: 501, mode: 0o755, isDirectory: true, isSymbolicLink: false }));
        expect(await createManagedSupervisorReadiness(owned.input, owned.over).observe())
            .toEqual({ verified: false, reason: 'backend-marker-unavailable' });
        expect(owned.over.readProtectedFile).not.toHaveBeenCalled();
        expect(owned.helloFn).not.toHaveBeenCalled();
    });
    it('captures admission, actual client binding and function at construction without rebind', async () => {
        const f = fixture(); const observer = createManagedSupervisorReadiness(f.input, f.over);
        const originalSha = f.admitted.markerSha256;
        const originalBinding = { ...f.binding };
        f.over.readProtectedFile.mockReturnValue({ kind: 'ok', content: '', sha256: originalSha });
        f.over.readBinding.mockReturnValue({ ok: true, binding: originalBinding });
        f.input.markerPath = '/mutated/marker'; f.admitted.markerSha256 = 'f'.repeat(64);
        f.admitted.identity.runtimeId = 'mutated'; f.admitted.identity.provisioningOperationId = 'mutated';
        f.admitted.identity.stateDir = '/mutated'; f.binding.token = 'mutated'; f.binding.socketPath = '/mutated/socket';
        const replacement = vi.fn(); f.input.launcher.hello = replacement;
        expect(await observer.observe()).toEqual({ verified: true });
        expect(f.over.readProtectedFile).toHaveBeenCalledWith('/etc/saycode/managed-runtime.json', assertProvisioningStat);
        expect(f.over.readBinding).toHaveBeenCalledWith({ stateDir: '/state', deps: f.over.provisioning });
        expect(f.helloFn).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
        const absent = createManagedSupervisorReadiness({ ...f.input, launcher: null }, f.over);
        expect(await absent.observe()).toEqual({ verified: false, reason: 'backend-hello-unavailable' });
    });
    it('requires exactly the admitted marker digest even when all displayed identity axes agree', async () => {
        const f = fixture();
        f.over.readProtectedFile.mockReturnValue({ kind: 'ok', content: 'changed configuration', sha256: 'c'.repeat(64) });
        expect(await createManagedSupervisorReadiness(f.input, f.over).observe())
            .toEqual({ verified: false, reason: 'backend-marker-changed' });
        expect(f.over.readAttestation).not.toHaveBeenCalled(); expect(f.helloFn).not.toHaveBeenCalled();
    });
    it.each(['token', 'socketPath'] as const)('checks fresh binding %s against the actual startup client', async (field) => {
        const f = fixture();
        f.over.readBinding.mockReturnValue({ ok: true, binding: { ...f.binding, [field]: 'different' } });
        expect(await createManagedSupervisorReadiness(f.input, f.over).observe())
            .toEqual({ verified: false, reason: 'backend-instance-mismatch' });
        expect(f.helloFn).not.toHaveBeenCalled();
    });
    it.each(['socketPath', 'runtimeId', 'provisioningOperationId', 'markerSha256'] as const)('refuses an attestation %s mismatch before hello', async (field) => {
        const f = fixture();
        f.over.readAttestation.mockReturnValue({ ok: true, attestation: { ...f.attestation, [field]: 'different' } });
        expect(await createManagedSupervisorReadiness(f.input, f.over).observe())
            .toEqual({ verified: false, reason: 'backend-instance-mismatch' });
        expect(f.helloFn).not.toHaveBeenCalled();
    });
    it.each(['instanceNonce', 'runtimeId', 'provisioningOperationId', 'markerSha256'] as const)('refuses a hello %s mismatch', async (field) => {
        const f = fixture(); f.helloFn.mockResolvedValue({ ok: true, result: { ...f.hello, [field]: 'different' } });
        expect(await createManagedSupervisorReadiness(f.input, f.over).observe())
            .toEqual({ verified: false, reason: 'backend-instance-mismatch' });
    });
    it('rereads after success and accepts a matching restart nonce only under the same admission', async () => {
        const f = fixture(); const observer = createManagedSupervisorReadiness(f.input, f.over);
        expect(await observer.observe()).toEqual({ verified: true });
        f.attestation.instanceNonce = 'r'.repeat(32); f.hello.instanceNonce = 'r'.repeat(32);
        expect(await observer.observe()).toEqual({ verified: true });
        expect(f.over.readProtectedFile).toHaveBeenCalledTimes(2);
        expect(f.over.readAttestation).toHaveBeenCalledTimes(2); expect(f.over.readBinding).toHaveBeenCalledTimes(2);
        expect(f.helloFn).toHaveBeenCalledTimes(2);
        f.over.readProtectedFile.mockReturnValue({ kind: 'absent' });
        expect(await observer.observe()).toEqual({ verified: false, reason: 'backend-marker-unavailable' });
    });
    it('refuses overlap and clears busy on hello rejection for a fresh later observation', async () => {
        const f = fixture(); let reject!: (error: Error) => void;
        f.helloFn.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
        const observer = createManagedSupervisorReadiness(f.input, f.over); const first = observer.observe();
        expect(await observer.observe()).toEqual({ verified: false, reason: 'backend-busy' });
        expect(f.over.readProtectedFile).toHaveBeenCalledOnce(); expect(f.helloFn).toHaveBeenCalledOnce();
        reject(new Error('secret/path/token'));
        expect(await first).toEqual({ verified: false, reason: 'backend-hello-unavailable' });
        expect(await observer.observe()).toEqual({ verified: true });
        expect(f.over.readProtectedFile).toHaveBeenCalledTimes(2);
    });
    it.each([
        ['readProtectedFile', 'backend-marker-unavailable'],
        ['readAttestation', 'backend-attestation-unusable'],
        ['readBinding', 'backend-binding-unavailable'],
    ] as const)('maps thrown %s errors to a closed phase code and releases busy', async (reader, reason) => {
        const f = fixture(); f.over[reader].mockImplementationOnce(() => { throw new Error('secret'); });
        const observer = createManagedSupervisorReadiness(f.input, f.over);
        expect(await observer.observe()).toEqual({ verified: false, reason });
        expect(await observer.observe()).toEqual({ verified: true });
    });
    it.each(['absent', 'untrusted', 'unusable'] as const)('preserves the attestation %s classification', async (reason) => {
        const f = fixture(); f.over.readAttestation.mockReturnValue({ ok: false, reason });
        expect(await createManagedSupervisorReadiness(f.input, f.over).observe())
            .toEqual({ verified: false, reason: `backend-attestation-${reason}` });
        expect(f.over.readBinding).not.toHaveBeenCalled(); expect(f.helloFn).not.toHaveBeenCalled();
    });
    it.each([
        ['timeout', 'backend-hello-timeout'], ['backend-path-untrusted', 'backend-path-untrusted'],
        ['transport', 'backend-hello-unavailable'], ['hello-refused', 'backend-hello-unavailable'],
        ['malformed-response', 'backend-hello-unavailable'], ['response-too-large', 'backend-hello-unavailable'],
    ] as const)('maps hello %s without exposing record contents', async (reason, expected) => {
        const f = fixture(); f.helloFn.mockResolvedValue({ ok: false, reason });
        expect(await createManagedSupervisorReadiness(f.input, f.over).observe()).toEqual({ verified: false, reason: expected });
    });
    it.each(['absent', 'unusable', 'socket-outside-state-dir', 'socket-path-untrusted'] as const)('maps binding %s to unavailable without calling hello', async (reason) => {
        const f = fixture(); f.over.readBinding.mockReturnValue({ ok: false, reason });
        expect(await createManagedSupervisorReadiness(f.input, f.over).observe())
            .toEqual({ verified: false, reason: 'backend-binding-unavailable' });
        expect(f.helloFn).not.toHaveBeenCalled();
    });
    it('keeps the observed attestation nonce fixed across the hello await', async () => {
        const f = fixture();
        f.over.readAttestation.mockReturnValue({ ok: true, attestation: f.attestation });
        let finish!: (result: LauncherHelloResult) => void;
        f.helloFn.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        const observer = createManagedSupervisorReadiness(f.input, f.over);
        const pending = observer.observe();
        f.attestation.instanceNonce = 'changed-after-read';
        finish({ ok: true, result: { ...f.hello, instanceNonce: 'changed-after-read' } });
        expect(await pending).toEqual({ verified: false, reason: 'backend-instance-mismatch' });
        expect(f.over.readAttestation).toHaveBeenCalledOnce();
    });
    it('does no work and cannot acquire a newly installed client after a null startup client', async () => {
        const f = fixture();
        const input: Parameters<typeof createManagedSupervisorReadiness>[0] = { ...f.input, launcher: null };
        const observer = createManagedSupervisorReadiness(input, f.over);
        input.launcher = f.input.launcher;
        expect(await observer.observe()).toEqual({ verified: false, reason: 'backend-hello-unavailable' });
        expect(await observer.observe()).toEqual({ verified: false, reason: 'backend-hello-unavailable' });
        expect(f.over.provisioning.lstatDir).not.toHaveBeenCalled();
        expect(f.over.readProtectedFile).not.toHaveBeenCalled();
        expect(f.helloFn).not.toHaveBeenCalled();
    });
    it('maps a thrown ancestor observation to marker unavailable and releases busy', async () => {
        const f = fixture();
        const lstat = vi.fn(f.over.provisioning.lstatDir).mockImplementationOnce(() => { throw new Error('secret'); });
        f.over.provisioning.lstatDir = lstat;
        const observer = createManagedSupervisorReadiness(f.input, f.over);
        expect(await observer.observe()).toEqual({ verified: false, reason: 'backend-marker-unavailable' });
        expect(f.over.readProtectedFile).not.toHaveBeenCalled();
        expect(await observer.observe()).toEqual({ verified: true });
    });
    it('uses the actual protected reader and fixed gate on a file owned by the executing UID', async () => {
        const root = mkdtempSync(join(tmpdir(), 'readiness-marker-'));
        try {
            const f = fixture(); const bytes = 'synthetic admitted document';
            f.input.markerPath = join(root, 'marker.json'); writeFileSync(f.input.markerPath, bytes, { mode: 0o600 });
            f.admitted.markerSha256 = createHash('sha256').update(bytes).digest('hex');
            f.hello.markerSha256 = f.admitted.markerSha256; f.attestation.markerSha256 = f.admitted.markerSha256;
            f.over.readProtectedFile.mockImplementation(readRootProtectedFile);
            const observed = await createManagedSupervisorReadiness(f.input, f.over).observe();
            expect(observed).toEqual(process.getuid?.() === 0 ? { verified: true }
                : { verified: false, reason: 'backend-marker-unavailable' });
            expect(f.over.provisioning.statGate).not.toHaveBeenCalled();
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
});
