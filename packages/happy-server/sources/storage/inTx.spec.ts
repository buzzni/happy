import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transaction = vi.hoisted(() => vi.fn());
vi.mock('@/storage/db', () => ({ db: { $transaction: transaction } }));
vi.mock('@/utils/delay', () => ({ delay: async () => {} }));

import { inTx } from '@/storage/inTx';

function knownError(code: string, meta?: Record<string, unknown>) {
    return new Prisma.PrismaClientKnownRequestError('failed', { code, clientVersion: 'test', meta });
}

describe('inTx', () => {
    beforeEach(() => {
        transaction.mockReset();
    });

    it.each([
        ['a serializable conflict', knownError('P2034')],
        // Postgres reports a raw query's serialization failure (e.g. SELECT … FOR SHARE on a row
        // updated after the snapshot) as P2010 with the SQLSTATE in meta, not as P2034.
        ['a raw query serialization failure', knownError('P2010', { code: '40001', message: 'could not serialize access due to concurrent update' })],
        ['a raw query deadlock', knownError('P2010', { code: '40P01', message: 'deadlock detected' })],
    ])('retries %s', async (_label, error) => {
        transaction.mockRejectedValueOnce(error).mockResolvedValueOnce({ result: 'done', callbacks: [] });
        await expect(inTx(async () => 'done')).resolves.toBe('done');
        expect(transaction).toHaveBeenCalledTimes(2);
    });

    it('does not retry other raw query failures', async () => {
        const error = knownError('P2010', { code: '23505', message: 'duplicate key value violates unique constraint' });
        transaction.mockRejectedValue(error);
        await expect(inTx(async () => 'done')).rejects.toBe(error);
        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('gives up after three retries', async () => {
        const error = knownError('P2010', { code: '40001', message: 'could not serialize access due to concurrent update' });
        transaction.mockRejectedValue(error);
        await expect(inTx(async () => 'done')).rejects.toBe(error);
        expect(transaction).toHaveBeenCalledTimes(4);
    });
});
