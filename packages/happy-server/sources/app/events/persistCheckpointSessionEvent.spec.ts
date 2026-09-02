import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
    transaction: vi.fn(),
    findFirst: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        $transaction: mocks.transaction,
        sessionEvent: { findFirst: mocks.findFirst },
    },
}));

import { persistCheckpointSessionEvent } from './persistCheckpointSessionEvent';

const checkpoint = {
    schemaVersion: 1,
    operationId: 'operation-1',
    checkpointId: 'checkpoint-1',
    state: 'created',
    actor: 'agent',
    timestamp: 1_788_111_000_000,
} as const;

describe('persistCheckpointSessionEvent', () => {
    beforeEach(() => vi.clearAllMocks());

    it('persists metadata and its idempotency key with the session sequence transaction', async () => {
        const createdAt = new Date('2026-09-02T00:00:00.000Z');
        const tx = {
            session: {
                update: vi.fn(async () => ({ eventSeq: 7 })),
            },
            sessionEvent: {
                create: vi.fn(async () => ({ id: 'event-1', seq: 7, createdAt })),
            },
        };
        mocks.transaction.mockImplementation((callback) => callback(tx));

        await expect(persistCheckpointSessionEvent({
            sessionId: 'session-1',
            eventType: 'checkpoint-snapshot',
            content: 'encrypted-detail',
            checkpoint,
        })).resolves.toEqual({ id: 'event-1', seq: 7, createdAt, idempotent: false });

        expect(tx.session.update).toHaveBeenCalledWith({
            where: { id: 'session-1' },
            select: { eventSeq: true },
            data: { eventSeq: { increment: 1 } },
        });
        expect(tx.sessionEvent.create).toHaveBeenCalledWith({
            data: {
                sessionId: 'session-1',
                eventType: 'checkpoint-snapshot',
                seq: 7,
                content: { t: 'encrypted', c: 'encrypted-detail' },
                checkpoint,
                idempotencyKey: 'checkpoint-snapshot:operation-1:created',
            },
            select: { id: true, seq: true, createdAt: true },
        });
    });

    it('returns the existing event after a concurrent duplicate insert rolls back', async () => {
        const existing = {
            id: 'event-existing',
            seq: 4,
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
        };
        mocks.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
            'duplicate checkpoint event',
            {
                code: 'P2002',
                clientVersion: 'test',
                meta: { target: ['sessionId', 'idempotencyKey'] },
            },
        ));
        mocks.findFirst.mockResolvedValue(existing);

        await expect(persistCheckpointSessionEvent({
            sessionId: 'session-1',
            eventType: 'checkpoint-snapshot',
            content: 'encrypted-detail',
            checkpoint,
        })).resolves.toEqual({ ...existing, idempotent: true });

        expect(mocks.findFirst).toHaveBeenCalledWith({
            where: {
                sessionId: 'session-1',
                idempotencyKey: 'checkpoint-snapshot:operation-1:created',
            },
            select: { id: true, seq: true, createdAt: true },
        });
    });

    it('does not mistake another unique constraint failure for an idempotent retry', async () => {
        const error = new Prisma.PrismaClientKnownRequestError(
            'duplicate generated id',
            { code: 'P2002', clientVersion: 'test', meta: { target: ['id'] } },
        );
        mocks.transaction.mockRejectedValue(error);
        mocks.findFirst.mockResolvedValue({
            id: 'event-existing',
            seq: 4,
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
        });

        await expect(persistCheckpointSessionEvent({
            sessionId: 'session-1',
            eventType: 'checkpoint-snapshot',
            content: 'encrypted-detail',
            checkpoint,
        })).rejects.toBe(error);
        expect(mocks.findFirst).not.toHaveBeenCalled();
    });
});
