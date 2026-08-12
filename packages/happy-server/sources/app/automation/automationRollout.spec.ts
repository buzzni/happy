import { describe, expect, it } from 'vitest';
import { isServerBackedAutomationEnabled } from './automationRollout';

describe('isServerBackedAutomationEnabled', () => {
    it('is fail-closed when the global flag is absent or not true', () => {
        expect(isServerBackedAutomationEnabled(undefined)).toBe(false);
        expect(isServerBackedAutomationEnabled('')).toBe(false);
        expect(isServerBackedAutomationEnabled('false')).toBe(false);
        expect(isServerBackedAutomationEnabled('TRUE')).toBe(false);
    });

    it('opens the server-backed path to every account only when explicitly enabled', () => {
        expect(isServerBackedAutomationEnabled('true')).toBe(true);
    });
});
