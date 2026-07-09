import { describe, expect, it, vi } from 'vitest';
import { guardClusterAdapterLocalDelivery } from './adapterLocalDeliveryGuard';

describe('guardClusterAdapterLocalDelivery', () => {
    it('returns false for adapters without a publish method (in-memory adapter)', () => {
        expect(guardClusterAdapterLocalDelivery({}, () => { })).toBe(false);
        expect(guardClusterAdapterLocalDelivery(null, () => { })).toBe(false);
    });

    it('passes through successful publish offsets', async () => {
        const adapter = { publishAndReturnOffset: vi.fn(async (_message: unknown) => '123-4') };
        expect(guardClusterAdapterLocalDelivery(adapter, () => { })).toBe(true);
        await expect(adapter.publishAndReturnOffset('m')).resolves.toBe('123-4');
    });

    it('resolves with a dummy offset when the publish rejects (READONLY replica)', async () => {
        const logs: string[] = [];
        const adapter = {
            publishAndReturnOffset: vi.fn(async (_message: unknown) => {
                throw new Error("READONLY You can't write against a read only replica.");
            }),
        };
        guardClusterAdapterLocalDelivery(adapter, (message) => logs.push(message));
        await expect(adapter.publishAndReturnOffset('m')).resolves.toBe('0-0');
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('READONLY');
    });

    it('resolves with a dummy offset when the publish hangs (offline queue)', async () => {
        const adapter = { publishAndReturnOffset: vi.fn((_message: unknown) => new Promise<string>(() => { })) };
        guardClusterAdapterLocalDelivery(adapter, () => { }, 20);
        await expect(adapter.publishAndReturnOffset('m')).resolves.toBe('0-0');
    });

    it('throttles repeated failure logs', async () => {
        const logs: string[] = [];
        const adapter = {
            publishAndReturnOffset: vi.fn(async (_message: unknown) => {
                throw new Error('boom');
            }),
        };
        guardClusterAdapterLocalDelivery(adapter, (message) => logs.push(message));
        await adapter.publishAndReturnOffset('a');
        await adapter.publishAndReturnOffset('b');
        expect(logs).toHaveLength(1);
    });
});
