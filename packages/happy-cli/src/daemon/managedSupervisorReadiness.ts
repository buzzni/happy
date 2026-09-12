import { dirname, isAbsolute, resolve } from 'node:path';
import {
    assertProvisioningStat, defaultProvisioningDeps, readRootProtectedFile, trustedPathRefusal,
    type ManagedIdentityResolution, type ManagedProvisioningDeps,
} from './managedRuntimeIdentity';
import { readManagedLauncherBinding, type ManagedLauncherBinding } from './launch/managedLauncherBinding';
import { readManagedSupervisorAttestation } from '@/managed/managedSupervisorAttestation';
import type { LauncherHelloResult } from './launch/launcherClient';

type ActiveIdentity = Extract<ManagedIdentityResolution, { status: 'active' }>;
export type ReadinessReason =
    | 'backend-busy'
    | 'backend-marker-unavailable'
    | 'backend-marker-changed'
    | 'backend-attestation-absent'
    | 'backend-attestation-untrusted'
    | 'backend-attestation-unusable'
    | 'backend-binding-unavailable'
    | 'backend-instance-mismatch'
    | 'backend-path-untrusted'
    | 'backend-hello-timeout'
    | 'backend-hello-unavailable';
export type ReadinessObservation = { verified: true } | { verified: false; reason: ReadinessReason };

/** A fresh consistency observation, not renewed lease or isolation authority. */
export function createManagedSupervisorReadiness(input: {
    admitted: ActiveIdentity;
    markerPath: string;
    launcher: null | { binding: ManagedLauncherBinding; hello: () => Promise<LauncherHelloResult> };
}, over?: {
    provisioning?: ManagedProvisioningDeps;
    readProtectedFile?: typeof readRootProtectedFile;
    readBinding?: typeof readManagedLauncherBinding;
    readAttestation?: typeof readManagedSupervisorAttestation;
}): { observe(): Promise<ReadinessObservation> } {
    const admittedSha = input.admitted.markerSha256;
    const { runtimeId, provisioningOperationId, stateDir } = input.admitted.identity;
    const markerPath = input.markerPath;
    const socketPath = input.launcher?.binding.socketPath;
    const token = input.launcher?.binding.token;
    const hello = input.launcher?.hello;
    const provisioning = over?.provisioning ?? defaultProvisioningDeps;
    const readMarker = over?.readProtectedFile ?? readRootProtectedFile;
    const readBinding = over?.readBinding ?? readManagedLauncherBinding;
    const readAttestation = over?.readAttestation ?? readManagedSupervisorAttestation;
    let busy = false;

    return {
        async observe(): Promise<ReadinessObservation> {
            if (busy) return { verified: false, reason: 'backend-busy' };
            busy = true;
            try {
                if (!hello) return { verified: false, reason: 'backend-hello-unavailable' };
                let marker: ReturnType<typeof readRootProtectedFile>;
                try {
                    if (!isAbsolute(markerPath)
                        || trustedPathRefusal(dirname(resolve(markerPath)), 0, 'not-root-owned', provisioning)) {
                        return { verified: false, reason: 'backend-marker-unavailable' };
                    }
                    marker = readMarker(markerPath, assertProvisioningStat);
                } catch { return { verified: false, reason: 'backend-marker-unavailable' }; }
                if (marker.kind !== 'ok') return { verified: false, reason: 'backend-marker-unavailable' };
                const freshSha = marker.sha256;
                if (freshSha !== admittedSha) return { verified: false, reason: 'backend-marker-changed' };

                let observed: ReturnType<typeof readManagedSupervisorAttestation>;
                try { observed = readAttestation({ stateDir, deps: provisioning }); }
                catch { return { verified: false, reason: 'backend-attestation-unusable' }; }
                if (!observed.ok) {
                    const reason = observed.reason === 'absent' ? 'backend-attestation-absent'
                        : observed.reason === 'untrusted' ? 'backend-attestation-untrusted'
                        : 'backend-attestation-unusable';
                    return { verified: false, reason };
                }
                // Preserve this read's values across the asynchronous hello.
                const attestation = { ...observed.attestation };
                let binding: ReturnType<typeof readManagedLauncherBinding>;
                try { binding = readBinding({ stateDir, deps: provisioning }); }
                catch { return { verified: false, reason: 'backend-binding-unavailable' }; }
                if (!binding.ok) return { verified: false, reason: 'backend-binding-unavailable' };
                if (binding.binding.socketPath !== socketPath || binding.binding.token !== token
                    || attestation.socketPath !== socketPath || attestation.runtimeId !== runtimeId
                    || attestation.provisioningOperationId !== provisioningOperationId
                    || attestation.markerSha256 !== freshSha) {
                    return { verified: false, reason: 'backend-instance-mismatch' };
                }
                let answer: LauncherHelloResult;
                try { answer = await hello(); }
                catch { return { verified: false, reason: 'backend-hello-unavailable' }; }
                if (!answer.ok) {
                    const reason = answer.reason === 'timeout' ? 'backend-hello-timeout'
                        : answer.reason === 'backend-path-untrusted' ? 'backend-path-untrusted'
                        : 'backend-hello-unavailable';
                    return { verified: false, reason };
                }
                if (answer.result.runtimeId !== runtimeId
                    || answer.result.provisioningOperationId !== provisioningOperationId
                    || answer.result.markerSha256 !== freshSha
                    || answer.result.instanceNonce !== attestation.instanceNonce) {
                    return { verified: false, reason: 'backend-instance-mismatch' };
                }
                return { verified: true };
            } finally { busy = false; }
        },
    };
}
