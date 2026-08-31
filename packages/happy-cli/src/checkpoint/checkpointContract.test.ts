import { describe, expect, it } from 'vitest';
import {
    checkpointEventDetailSchema,
    checkpointMutationGateRequestSchema,
    checkpointProtectionStateSchema,
} from './checkpointContract';

describe('checkpoint mutation gate contract', () => {
    const validRequest = {
        schemaVersion: 1,
        operationId: 'operation-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        worktreeId: null,
        projectPath: '/workspace/project-1',
    };

    it('requires the authoritative project binding inputs on every gate request', () => {
        expect(checkpointMutationGateRequestSchema.parse(validRequest)).toEqual(validRequest);

        for (const field of ['sessionId', 'projectId', 'worktreeId', 'projectPath'] as const) {
            const invalid: Partial<typeof validRequest> = { ...validRequest };
            delete invalid[field];
            expect(checkpointMutationGateRequestSchema.safeParse(invalid).success).toBe(false);
        }
    });

    it('does not accept a caller-asserted account identity as ownership proof', () => {
        expect(checkpointMutationGateRequestSchema.safeParse({
            ...validRequest,
            accountId: 'account-from-caller',
        }).success).toBe(false);
    });
});

describe('checkpoint protection state contract', () => {
    it('accepts only protected, unavailable, and legacy session states', () => {
        expect(checkpointProtectionStateSchema.parse({ status: 'protected' }))
            .toEqual({ status: 'protected' });
        expect(checkpointProtectionStateSchema.parse({
            status: 'unavailable',
            reason: 'snapshot-failed',
        })).toEqual({ status: 'unavailable', reason: 'snapshot-failed' });
        expect(checkpointProtectionStateSchema.parse({ status: 'legacy' }))
            .toEqual({ status: 'legacy' });

        expect(checkpointProtectionStateSchema.safeParse({ status: 'disabled' }).success)
            .toBe(false);
        expect(checkpointProtectionStateSchema.safeParse({ status: 'unavailable' }).success)
            .toBe(false);
    });
});

describe('encrypted checkpoint event detail contract', () => {
    const validDetail = {
        schemaVersion: 1,
        checkpointId: 'checkpoint-1',
        state: 'created',
        actor: 'agent',
        timestamp: 1_788_111_000_000,
        summary: {
            files: [{ path: 'src/index.ts', action: 'modified' }],
            excluded: [{ path: '.env', reason: 'secret' }],
        },
    };

    it('accepts project-relative summaries without file content', () => {
        expect(checkpointEventDetailSchema.parse(validDetail)).toEqual(validDetail);
    });

    it.each([
        '/Users/person/project/src/index.ts',
        '../../outside.txt',
        'C:outside.txt',
        'C:\\Users\\person\\project\\src\\index.ts',
        'src/index.ts\0.env',
    ])('rejects non-relative summary path %s', (path) => {
        expect(checkpointEventDetailSchema.safeParse({
            ...validDetail,
            summary: {
                ...validDetail.summary,
                files: [{ path, action: 'modified' }],
            },
        }).success).toBe(false);
    });

    it('rejects file content and credentials even inside the encrypted detail DTO', () => {
        expect(checkpointEventDetailSchema.safeParse({
            ...validDetail,
            summary: {
                ...validDetail.summary,
                files: [{ path: '.env', action: 'modified', content: 'SECRET=value' }],
            },
        }).success).toBe(false);
        expect(checkpointEventDetailSchema.safeParse({
            ...validDetail,
            credential: 'token',
        }).success).toBe(false);
    });
});
