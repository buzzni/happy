import { describe, expect, it } from 'vitest';

import { automationPreviewConfirmation } from './automationPreview';

describe('automationPreviewConfirmation', () => {
    it('explains that scheduled automations are an internal preview', () => {
        expect(automationPreviewConfirmation).toEqual({
            title: 'Internal Preview',
            message: 'Scheduled Automations is an administrator-only test feature and will be released more broadly later.',
            confirmText: 'Continue',
            cancelText: 'Cancel',
        });
    });
});
