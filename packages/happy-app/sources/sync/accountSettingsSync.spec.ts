import { describe, expect, it, vi } from 'vitest';
import { settingsDefaults } from './settings';
import { syncPendingAccountSettings } from './accountSettingsSync';

describe('syncPendingAccountSettings', () => {
    it('posts the merged encrypted settings with the current version and personal token', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            json: async () => ({ success: true, version: 5 }),
        });
        const onSuccess = vi.fn();

        await syncPendingAccountSettings({
            apiBaseUrl: 'https://happy.example',
            personalToken: 'personal-token',
            clientId: 'desktop',
            fetchImpl,
            encryptSettings: async settings => JSON.stringify(settings),
            decryptSettings: async settings => JSON.parse(settings),
            getSnapshot: () => ({
                settings: { ...settingsDefaults, futureField: 'preserved' } as typeof settingsDefaults,
                settingsVersion: 4,
                pending: { saycodeSystemPromptEnabled: false },
            }),
            onConflict: vi.fn(),
            onSuccess,
        });

        expect(fetchImpl).toHaveBeenCalledWith('https://happy.example/v1/account/settings', {
            method: 'POST',
            body: expect.any(String),
            headers: {
                Authorization: 'Bearer personal-token',
                'Content-Type': 'application/json',
                'X-Happy-Client': 'desktop',
            },
        });
        const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(request.expectedVersion).toBe(4);
        expect(JSON.parse(request.settings)).toMatchObject({
            futureField: 'preserved',
            saycodeSystemPromptEnabled: false,
        });
        expect(onSuccess).toHaveBeenCalledWith({
            sentPending: { saycodeSystemPromptEnabled: false },
            version: 5,
        });
    });

    it('merges a version mismatch with concurrent and unknown server fields before retrying', async () => {
        const serverSettings = JSON.stringify({
            ...settingsDefaults,
            showLineNumbers: false,
            futureServerField: 'keep-me',
        });
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({
                json: async () => ({
                    success: false,
                    error: 'version-mismatch',
                    currentVersion: 8,
                    currentSettings: serverSettings,
                }),
            })
            .mockResolvedValueOnce({ json: async () => ({ success: true, version: 9 }) });
        let snapshot = {
            settings: { ...settingsDefaults },
            settingsVersion: 7 as number | null,
            pending: { saycodeSystemPromptEnabled: false },
        };

        await syncPendingAccountSettings({
            apiBaseUrl: 'https://happy.example',
            personalToken: 'personal-token',
            clientId: 'web',
            fetchImpl,
            encryptSettings: async settings => JSON.stringify(settings),
            decryptSettings: async settings => JSON.parse(settings),
            getSnapshot: () => snapshot,
            onConflict: ({ settings, version }) => {
                snapshot = { ...snapshot, settings, settingsVersion: version };
            },
            onSuccess: vi.fn(),
        });

        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const retryRequest = JSON.parse(fetchImpl.mock.calls[1][1].body);
        expect(retryRequest.expectedVersion).toBe(8);
        expect(JSON.parse(retryRequest.settings)).toMatchObject({
            showLineNumbers: false,
            futureServerField: 'keep-me',
            saycodeSystemPromptEnabled: false,
        });
    });

    it('stops after the bounded number of version conflicts', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            json: async () => ({
                success: false,
                error: 'version-mismatch',
                currentVersion: 12,
                currentSettings: JSON.stringify(settingsDefaults),
            }),
        });

        await expect(syncPendingAccountSettings({
            apiBaseUrl: 'https://happy.example',
            personalToken: 'personal-token',
            clientId: 'mobile',
            fetchImpl,
            encryptSettings: async settings => JSON.stringify(settings),
            decryptSettings: async settings => JSON.parse(settings),
            getSnapshot: () => ({
                settings: { ...settingsDefaults },
                settingsVersion: 11,
                pending: { saycodeSystemPromptEnabled: true },
            }),
            onConflict: vi.fn(),
            onSuccess: vi.fn(),
            maxRetries: 3,
        })).rejects.toThrow('Settings sync failed after 3 retries due to version conflicts');

        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
});
