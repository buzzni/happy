import { describe, expect, it } from 'vitest';
import { AutomationApiError } from '@slopus/happy-wire';
import { automationErrorMessage } from './automationError';

describe('automationErrorMessage', () => {
    it('explains why an in-use viewer key cannot be replaced', () => {
        expect(automationErrorMessage(new AutomationApiError(409, 'viewer-key-in-use')))
            .toContain('different workspace key');
    });

    it('keeps the generic conflict and rollout messages for other API failures', () => {
        expect(automationErrorMessage(new AutomationApiError(409, 'revision-conflict')))
            .toContain('changed elsewhere');
        expect(automationErrorMessage(new AutomationApiError(404, 'feature-disabled')))
            .toContain('not enabled');
    });
});
