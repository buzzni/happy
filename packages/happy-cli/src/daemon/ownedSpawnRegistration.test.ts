import { describe, expect, it } from 'vitest';
import { readOwnedRegistration } from './ownedSpawnRegistration';

const credentials = { token: 'machine-token', encryption: { type: 'legacy' } };
const read = (settings: { machineId?: string; machineIdConfirmedByServer?: boolean }, current: typeof credentials | null = credentials) =>
    readOwnedRegistration({ machineId: 'machine', credentials, epoch: '42', readCredentials: async () => current, readSettings: async () => settings });

describe('readOwnedRegistration', () => {
    it('answers the running daemon\'s own machine, credentials and epoch', async () => {
        expect(await read({ machineId: 'machine', machineIdConfirmedByServer: true })).toEqual({ machineId: 'machine', credentials, epoch: '42' });
    });

    it.each([
        ['another machine id in settings', { machineId: 'other', machineIdConfirmedByServer: true }, credentials],
        ['no credentials on disk', { machineId: 'machine', machineIdConfirmedByServer: true }, null],
        ['credentials that changed since the daemon started', { machineId: 'machine', machineIdConfirmedByServer: true }, { ...credentials, token: 'other-token' }],
    ])('refuses %s', async (_name, settings, current) => {
        await expect(read(settings, current)).rejects.toThrow('identity-changed');
    });
});
