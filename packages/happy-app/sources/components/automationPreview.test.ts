import { describe, expect, it, vi } from 'vitest';

import {
    automationPreviewConfirmation,
    automationPreviewNotice,
    openAutomationPreview,
} from './automationPreview';

describe('automationPreviewConfirmation', () => {
    it('explains that scheduled automations are an internal preview', () => {
        expect(automationPreviewConfirmation).toEqual({
            title: 'Internal Preview',
            message: 'Scheduled Automations is an administrator-only test feature and will be released more broadly later.',
            confirmText: 'Continue',
            cancelText: 'Cancel',
        });
    });

    it('preserves the encryption and no-local-queue disclosure on the preview screen', () => {
        expect(automationPreviewNotice).toContain('encrypted end to end');
        expect(automationPreviewNotice).toContain('never create a local mutation queue');
    });

    it('opens the automation screen only after confirmation', async () => {
        const onConfirm = vi.fn();
        const cancel = vi.fn(async () => false);

        await openAutomationPreview({
            confirm: cancel,
            onConfirm,
        });
        expect(cancel).toHaveBeenCalledWith(
            automationPreviewConfirmation.title,
            automationPreviewConfirmation.message,
            {
                confirmText: automationPreviewConfirmation.confirmText,
                cancelText: automationPreviewConfirmation.cancelText,
            },
        );
        expect(onConfirm).not.toHaveBeenCalled();

        await openAutomationPreview({
            confirm: vi.fn(async () => true),
            onConfirm,
        });
        expect(onConfirm).toHaveBeenCalledOnce();
    });
});
