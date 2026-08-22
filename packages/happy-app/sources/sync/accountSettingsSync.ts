import {
    applySettings,
    settingsDefaults,
    settingsParse,
    settingsToSyncPayload,
    type Settings,
} from './settings';

type AccountSettingsSnapshot = {
    settings: Settings;
    settingsVersion: number | null;
    pending: Partial<Settings>;
};

type AccountSettingsPostResult = {
    success: true;
    version: number;
} | {
    success: false;
    error: string;
    currentVersion: number;
    currentSettings: string | null;
};

type FetchAccountSettings = (
    input: string,
    init: {
        method: 'POST';
        body: string;
        headers: Record<string, string>;
    },
) => Promise<{ json(): Promise<unknown> }>;

export async function syncPendingAccountSettings({
    apiBaseUrl,
    personalToken,
    clientId,
    fetchImpl,
    encryptSettings,
    decryptSettings,
    getSnapshot,
    onConflict,
    onSuccess,
    maxRetries = 3,
}: {
    apiBaseUrl: string;
    personalToken: string;
    clientId: string;
    fetchImpl: FetchAccountSettings;
    encryptSettings: (settings: Partial<Settings>) => Promise<string>;
    decryptSettings: (settings: string) => Promise<unknown>;
    getSnapshot: () => AccountSettingsSnapshot;
    onConflict: (snapshot: { settings: Settings; version: number }) => void;
    onSuccess: (result: { sentPending: Partial<Settings>; version: number }) => void;
    maxRetries?: number;
}): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const snapshot = getSnapshot();
        const sentPending = { ...snapshot.pending };
        const settings = applySettings(snapshot.settings, sentPending);
        const response = await fetchImpl(`${apiBaseUrl}/v1/account/settings`, {
            method: 'POST',
            body: JSON.stringify({
                settings: await encryptSettings(settingsToSyncPayload(settings)),
                expectedVersion: snapshot.settingsVersion ?? 0,
            }),
            headers: {
                Authorization: `Bearer ${personalToken}`,
                'Content-Type': 'application/json',
                'X-Happy-Client': clientId,
            },
        });
        const data = await response.json() as AccountSettingsPostResult;
        if (data.success) {
            onSuccess({ sentPending, version: data.version });
            return;
        }
        if (data.error !== 'version-mismatch') {
            throw new Error(`Failed to sync settings: ${data.error}`);
        }
        const serverSettings = data.currentSettings
            ? settingsParse(await decryptSettings(data.currentSettings))
            : { ...settingsDefaults };
        onConflict({
            settings: applySettings(serverSettings, snapshot.pending),
            version: data.currentVersion,
        });
    }
    throw new Error(`Settings sync failed after ${maxRetries} retries due to version conflicts`);
}
