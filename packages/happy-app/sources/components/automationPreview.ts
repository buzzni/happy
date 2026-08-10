export const automationPreviewConfirmation = {
    title: 'Internal Preview',
    message: 'Scheduled Automations is an administrator-only test feature and will be released more broadly later.',
    confirmText: 'Continue',
    cancelText: 'Cancel',
} as const;

export const automationPreviewNotice = 'Internal preview: administrator-only test feature. Public release is planned later. Automations are encrypted end to end. Server failures never create a local mutation queue.';

type AutomationPreviewConfirm = (
    title: string,
    message: string,
    options: { confirmText: string; cancelText: string },
) => Promise<boolean>;

export async function openAutomationPreview(input: {
    confirm: AutomationPreviewConfirm;
    onConfirm: () => void;
}): Promise<void> {
    const confirmed = await input.confirm(
        automationPreviewConfirmation.title,
        automationPreviewConfirmation.message,
        {
            confirmText: automationPreviewConfirmation.confirmText,
            cancelText: automationPreviewConfirmation.cancelText,
        },
    );
    if (confirmed) input.onConfirm();
}
