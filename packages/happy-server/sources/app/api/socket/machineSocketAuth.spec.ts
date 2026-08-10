import { describe, expect, it, vi } from 'vitest';
import { machineSocketIdentityExists } from './machineSocketAuth';

describe('machineSocketIdentityExists', () => {
    it('binds the verified token account to the handshake machine id', async () => {
        const findFirst = vi.fn(async () => ({ id: 'machine-1' }));
        await expect(machineSocketIdentityExists({ machine: { findFirst } } as never, 'account-1', 'machine-1'))
            .resolves.toBe(true);
        expect(findFirst).toHaveBeenCalledWith({
            where: { accountId: 'account-1', id: 'machine-1' },
            select: { id: true },
        });
    });

    it('rejects an unregistered or cross-account machine id', async () => {
        const findFirst = vi.fn(async () => null);
        await expect(machineSocketIdentityExists({ machine: { findFirst } } as never, 'account-1', 'foreign-machine'))
            .resolves.toBe(false);
    });
});
