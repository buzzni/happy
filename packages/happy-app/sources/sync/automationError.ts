import { AutomationApiError } from '@slopus/happy-wire';

export function automationErrorMessage(error: unknown): string {
    if (error instanceof AutomationApiError && error.code === 'viewer-key-in-use') {
        return 'Existing database automations use a different workspace key. Restore the original key or ask a project owner to remove those database automations before retrying.';
    }
    if (error instanceof AutomationApiError && error.status === 409) {
        return 'This automation changed elsewhere. The latest version was reloaded.';
    }
    if (error instanceof AutomationApiError && error.status === 404) {
        return 'Server-backed automations are not enabled for this account.';
    }
    return error instanceof Error ? error.message : String(error);
}
