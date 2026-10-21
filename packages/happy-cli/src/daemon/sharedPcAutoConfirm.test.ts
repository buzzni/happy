import { expect, it, vi } from 'vitest';
import { createSharedPcAutoConfirm } from './sharedPcAutoConfirm';

const transcript = { companyId: 'company', machineType: 'shared', ownerUserId: null, orgSigningPublicKey: 'K'.repeat(43), signingGeneration: 1 } as never;
const approval = { body: { signingKeyId: 'a'.repeat(64) } } as never;
const servedKey = { signingGeneration: 1, publicKey: 'K'.repeat(43), keyId: 'a'.repeat(64) };

function fixture(options: { marker?: 'shared' | 'dedicated' | null; key?: typeof servedKey | null; fetchError?: Error } = {}) {
    const fetchKey = vi.fn(async () => { if (options.fetchError) throw options.fetchError; return options.key === undefined ? servedKey : options.key; });
    const log = vi.fn();
    const confirm = createSharedPcAutoConfirm({
        marker: { read: async () => options.marker === undefined ? 'shared' : options.marker }, machineId: 'machine-1',
        token: () => 'machine-token', studioOrigin: 'https://studio.example.com', fetchKey, log,
    });
    return { confirm, fetchKey, log };
}

it('confirms when the PC is marked shared and its trusted origin serves the approval\'s exact key', async () => {
    const f = fixture();
    await expect(f.confirm({ transcript, approval })).resolves.toBe(true);
    expect(f.fetchKey).toHaveBeenCalledWith({ studioOrigin: 'https://studio.example.com', token: 'machine-token', companyId: 'company', machineId: 'machine-1' });
});

it('does not even ask Studio for a PC that is not marked shared', async () => {
    for (const marker of [null, 'dedicated'] as const) {
        const f = fixture({ marker });
        await expect(f.confirm({ transcript, approval })).resolves.toBe(false);
        expect(f.fetchKey).not.toHaveBeenCalled();
    }
});

it('declines, with a reason in the log, when the served key differs, is missing or cannot be read', async () => {
    for (const options of [
        { key: { ...servedKey, publicKey: 'Z'.repeat(43) } }, { key: { ...servedKey, signingGeneration: 2 } }, { key: { ...servedKey, keyId: 'b'.repeat(64) } },
        { key: null }, { fetchError: new Error('ORG_SIGNING_KEY_UNAVAILABLE') },
    ]) {
        const f = fixture(options);
        await expect(f.confirm({ transcript, approval })).resolves.toBe(false);
        expect(f.log).toHaveBeenCalledWith('[device-auto-confirm] declined', expect.objectContaining({ companyId: 'company' }));
    }
});
