import { describe, expect, it, vi } from 'vitest';

import { scriptAutomationAccountId } from './run';

/**
 * The account the script automation preflight runs for. Asserted here rather
 * than through `startDaemon`, as for the managed-runtime gate next to it.
 */

describe('script automation account', () => {
    it('takes a protected daemon account from its execution binding without reading the account profile', async () => {
        // The device credential is not an account token, and the profile
        // route refuses it; the binding names the account it was issued for.
        const readProfile = vi.fn(async () => ({ id: 'profile-account' }));
        await expect(scriptAutomationAccountId({ workMachineAccountId: 'bound-account', readProfile }))
            .resolves.toBe('bound-account');
        expect(readProfile).not.toHaveBeenCalled();
    });

    it('reads the account profile for an unprotected daemon', async () => {
        await expect(scriptAutomationAccountId({ workMachineAccountId: null, readProfile: async () => ({ id: 'profile-account' }) }))
            .resolves.toBe('profile-account');
        await expect(scriptAutomationAccountId({ workMachineAccountId: null, readProfile: async () => ({ id: '' }) }))
            .rejects.toThrow('SCRIPT_ACCOUNT_UNAVAILABLE');
        await expect(scriptAutomationAccountId({ workMachineAccountId: null, readProfile: async () => ({}) }))
            .rejects.toThrow('SCRIPT_ACCOUNT_UNAVAILABLE');
    });
});
