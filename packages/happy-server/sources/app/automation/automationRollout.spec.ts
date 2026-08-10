import { describe, expect, it } from 'vitest';
import { isServerBackedAutomationEnabled } from './automationRollout';

describe('isServerBackedAutomationEnabled', () => {
    it('is fail-closed when the allowlist is absent', () => {
        expect(isServerBackedAutomationEnabled('account-1', undefined)).toBe(false);
        expect(isServerBackedAutomationEnabled('account-1', '')).toBe(false);
    });

    it('accepts an explicit all marker or a trimmed account id', () => {
        expect(isServerBackedAutomationEnabled('account-1', '*')).toBe(true);
        expect(isServerBackedAutomationEnabled('account-1', 'account-2, account-1')).toBe(true);
        expect(isServerBackedAutomationEnabled('account-1', 'account-10')).toBe(false);
    });
});
