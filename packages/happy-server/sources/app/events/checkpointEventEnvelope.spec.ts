import { describe, expect, it } from 'vitest';
import { checkpointEventEnvelopeSchema } from './checkpointEventEnvelope';

describe('checkpointEventEnvelopeSchema', () => {
    const validEnvelope = {
        schemaVersion: 1,
        operationId: '123e4567-e89b-42d3-a456-426614174000',
        checkpointId: 'a'.repeat(40),
        state: 'created',
        actor: 'agent',
        timestamp: 1_788_111_000_000,
    };

    it('accepts versioned metadata needed for idempotency and rendering', () => {
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

    it.each(['   ', 'identifier\n2', 'identifier\0two'])(
        'rejects unsafe operation and checkpoint identifiers %j',
        (identifier) => {
            expect(checkpointEventEnvelopeSchema.safeParse({
                ...validEnvelope,
                operationId: identifier,
            }).success).toBe(false);
            expect(checkpointEventEnvelopeSchema.safeParse({
                ...validEnvelope,
                checkpointId: identifier,
            }).success).toBe(false);
        },
    );

    it.each([
        { operationId: '/Users/person/project/.env' },
        { operationId: 'SECRET=credential' },
        { checkpointId: '/Users/person/project/source.ts' },
        { checkpointId: 'sk-live-secret-credential' },
    ])('rejects filesystem or credential data encoded as an identifier (%j)', (override) => {
        expect(checkpointEventEnvelopeSchema.safeParse({
            ...validEnvelope,
            ...override,
        }).success).toBe(false);
    });
});
