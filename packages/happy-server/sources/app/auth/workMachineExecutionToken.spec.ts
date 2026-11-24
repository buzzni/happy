import { describe, expect, it } from 'vitest';
import { createBrowserSyncTokenIssuer } from '@/app/auth/browserSyncToken';
import { createWorkMachineExecutionTokenIssuer } from '@/app/auth/workMachineExecutionToken';

const seed = 'work-machine-token-tests-only';
const now = 1_800_000_000_000;
const machineClaims = {
    accountId: 'owner-1',
    machineId: 'logical-machine',
    deviceId: 'device-2',
    generation: 2,
    expiresAt: now + 60_000,
    purpose: 'daemon' as const,
};

describe('work machine execution token', () => {
    it('keeps daemon and session credentials separate from the browser signature and each other', async () => {
        const issuer = await createWorkMachineExecutionTokenIssuer(seed);
        const browserIssuer = await createBrowserSyncTokenIssuer({ seed });
        const daemon = await issuer.mint(machineClaims, now);
        const sessionClaims = { ...machineClaims, purpose: 'session' as const, sessionId: 'original-session' };
        const session = await issuer.mint(sessionClaims, now);
        expect(await issuer.verify(daemon, 'daemon', now)).toEqual(machineClaims);
        expect(await issuer.verify(session, 'session', now)).toEqual(sessionClaims);
        expect(await issuer.verify(daemon, 'session', now)).toBeNull();
        expect(await issuer.verify(session, 'daemon', now)).toBeNull();
        expect(await browserIssuer.verify(daemon, now)).toMatchObject({ ok: false });
    });

    it('refuses expiration, an invalid generation, and a daemon naming a session', async () => {
        const issuer = await createWorkMachineExecutionTokenIssuer(seed);
        const daemon = await issuer.mint(machineClaims, now);
        expect(await issuer.verify(daemon, 'daemon', machineClaims.expiresAt)).toBeNull();
        await expect(issuer.mint({ ...machineClaims, generation: 0 }, now)).rejects.toThrow();
        const ambiguous = { ...machineClaims, sessionId: 'original-session' };
        await expect(issuer.mint(ambiguous, now)).rejects.toThrow();
    });
});
