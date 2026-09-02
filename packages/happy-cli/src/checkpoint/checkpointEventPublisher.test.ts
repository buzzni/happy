import { describe, expect, it, vi } from 'vitest';
import { decodeBase64, decrypt } from '@/api/encryption';
import {
    createCheckpointEventPublisher,
    type CheckpointEventRequest,
} from './checkpointEventPublisher';

describe('checkpoint event publisher', () => {
    const encryptionKey = new Uint8Array(32).fill(7);
    const now = 1_788_111_000_000;

    it('encrypts relative-path detail while exposing only the idempotency envelope', async () => {
        const post = vi.fn(async (_request: CheckpointEventRequest) => ({
            event: { id: 'event-1', seq: 7, createdAt: now, idempotent: false },
        }));
        const publisher = createCheckpointEventPublisher({
            token: 'token-1',
            sessionId: 'session-1',
            serverUrl: 'https://api.happy.engineering',
            encryption: { encryptionKey, encryptionVariant: 'legacy' },
        }, { post, now: () => now });

        await expect(publisher.snapshot({
            operationId: 'turn-1',
            checkpointId: 'a'.repeat(40),
            excluded: [{ path: '.env.local', reason: 'secret' }],
        })).resolves.toEqual({ id: 'event-1', seq: 7, createdAt: now, idempotent: false });

        expect(post).toHaveBeenCalledOnce();
        const request = post.mock.calls[0]?.[0];
        expect(request).toMatchObject({
            url: 'https://api.happy.engineering/v3/sessions/session-1/events',
            token: 'token-1',
            body: {
                eventType: 'checkpoint-snapshot',
                checkpoint: {
                    schemaVersion: 1,
                    operationId: 'turn-1',
                    checkpointId: 'a'.repeat(40),
                    state: 'created',
                    actor: 'agent',
                    timestamp: now,
                },
            },
        });
        expect(request?.body.checkpoint).not.toHaveProperty('summary');
        expect(decrypt(
            encryptionKey,
            'legacy',
            decodeBase64(request?.body.content ?? ''),
        )).toEqual({
            schemaVersion: 1,
            checkpointId: 'a'.repeat(40),
            state: 'created',
            actor: 'agent',
            timestamp: now,
            summary: {
                files: [],
                excluded: [{ path: '.env.local', reason: 'secret' }],
            },
        });
    });

    it('keeps rewind retries on the same server idempotency key', async () => {
        const post = vi.fn<(request: CheckpointEventRequest) => Promise<unknown>>()
            .mockResolvedValueOnce({
                event: { id: 'event-2', seq: 8, createdAt: now, idempotent: false },
            })
            .mockResolvedValueOnce({
                event: { id: 'event-2', seq: 8, createdAt: now, idempotent: true },
            });
        const publisher = createCheckpointEventPublisher({
            token: 'token-1',
            sessionId: 'session-1',
            serverUrl: 'https://api.happy.engineering',
            encryption: { encryptionKey, encryptionVariant: 'legacy' },
        }, { post, now: () => now });
        const rewind = {
            operationId: 'restore-1',
            checkpointId: 'b'.repeat(40),
            state: 'partial' as const,
            files: [{ path: 'src/app.ts', action: 'modified' as const }],
        };

        await publisher.rewind(rewind);
        await expect(publisher.rewind(rewind)).resolves.toMatchObject({
            id: 'event-2', seq: 8, idempotent: true,
        });

        expect(post.mock.calls.map(([request]) => request.body.checkpoint)).toEqual([
            expect.objectContaining({ operationId: 'restore-1', state: 'partial' }),
            expect.objectContaining({ operationId: 'restore-1', state: 'partial' }),
        ]);
    });

    it('propagates transport failures and rejects malformed acknowledgements', async () => {
        const input = {
            token: 'token-1',
            sessionId: 'session-1',
            serverUrl: 'https://api.happy.engineering',
            encryption: { encryptionKey, encryptionVariant: 'legacy' as const },
        };
        const event = { operationId: 'turn-1', checkpointId: 'c'.repeat(40), excluded: [] };

        await expect(createCheckpointEventPublisher(input, {
            post: vi.fn(async () => { throw new Error('offline'); }),
        }).snapshot(event)).rejects.toThrow('offline');
        await expect(createCheckpointEventPublisher(input, {
            post: vi.fn(async () => ({
                event: { id: 'event-1', seq: -1, createdAt: 0, idempotent: false },
            })),
        }).snapshot(event)).rejects.toThrow('invalid acknowledgement');
    });
});
