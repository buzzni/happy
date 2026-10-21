import type { DeviceAutoConfirm } from './deviceEnrollment';
import type { MachineType } from './machineTypeMarker';
import { fetchTrustedOrgSigningKey } from './trustedOrgSigningKey';

/**
 * aplus specs/shared-machine-server-signing S6 (contract §20.5) — the check that replaces the person comparing a shared
 * PC's fingerprint. Both must hold: this PC recorded itself as shared (S6a; a Studio database row alone cannot), and
 * the approval names exactly the key, generation and key id its trusted Studio origin serves. Anything else declines,
 * which leaves the manual confirmation in place.
 */
export function createSharedPcAutoConfirm(deps: {
    marker: { read(): Promise<MachineType | null> };
    machineId: string;
    token: () => string;
    studioOrigin: string;
    fetchKey?: typeof fetchTrustedOrgSigningKey;
    log: (message: string, details: Record<string, unknown>) => void;
}): DeviceAutoConfirm {
    return async ({ transcript, approval }) => {
        if (await deps.marker.read() !== 'shared') return false;
        const companyId = transcript.companyId;
        const decline = (reason: string) => { deps.log('[device-auto-confirm] declined', { companyId, reason }); return false; };
        let key;
        try {
            key = await (deps.fetchKey ?? fetchTrustedOrgSigningKey)({ studioOrigin: deps.studioOrigin, token: deps.token(), companyId, machineId: deps.machineId });
        } catch (error) { return decline(error instanceof Error ? error.message : 'ORG_SIGNING_KEY_UNAVAILABLE'); }
        if (!key) return decline('ORG_SERVER_SIGNER_MISSING');
        if (key.publicKey !== transcript.orgSigningPublicKey || key.signingGeneration !== transcript.signingGeneration || key.keyId !== approval.body.signingKeyId)
            return decline('ORG_SIGNING_KEY_DIFFERS');
        return true;
    };
}
