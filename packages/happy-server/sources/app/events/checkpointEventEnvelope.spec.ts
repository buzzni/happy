import { describe, expect, it } from 'vitest';
import { checkpointEventEnvelopeSchema } from './checkpointEventEnvelope';

describe('checkpointEventEnvelopeSchema', () => {
    const validEnvelope = {
        schemaVersion: 1,
        operationId: 'operation-1',
        checkpointId: 'checkpoint-1',
        state: 'created',
        actor: 'agent',
        timestamp: 1_788_111_000_000,
    };

    it('accepts versioned metadata needed for ownership and idempotency checks', () => {
        expect(checkpointEventEnvelopeSchema.parse(validEnvelope)).toEqual(validEnvelope);
    });

    it('rejects unsupported versions and incomplete metadata', () => {
        expect(checkpointEventEnvelopeSchema.safeParse({
            ...validEnvelope,
            schemaVersion: 2,
        }).success).toBe(false);
        expect(checkpointEventEnvelopeSchema.safeParse({
            ...validEnvelope,
            operationId: undefined,
        }).success).toBe(false);
    });

    it('rejects project authority and filesystem details from the server-visible envelope', () => {
        expect(checkpointEventEnvelopeSchema.safeParse({
            ...validEnvelope,
            projectId: 'project-1',
        }).success).toBe(false);
        expect(checkpointEventEnvelopeSchema.safeParse({
            ...validEnvelope,
            absolutePath: '/Users/person/project/.env',
        }).success).toBe(false);
        expect(checkpointEventEnvelopeSchema.safeParse({
            ...validEnvelope,
            content: 'SECRET=value',
        }).success).toBe(false);
    });
});
