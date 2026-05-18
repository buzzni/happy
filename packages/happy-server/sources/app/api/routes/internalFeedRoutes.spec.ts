import { describe, it, expect } from 'vitest';
import {
    verifyInternalToken,
    InternalCollabFeedBodySchema,
} from './internalFeedRoutes';

/**
 * Unit tests for the internal collab-feed route boundary:
 *   1. shared-secret auth (verifyInternalToken)
 *   2. request body validation (InternalCollabFeedBodySchema)
 *
 * The fastify handler itself is a thin wrapper over these two helpers + a
 * single inTx + feedPostToUser call. We pin the boundary so regressions in
 * the auth gate (the most security-sensitive surface) and the schema (the
 * cross-service contract) fail at unit-test time, not at first emit.
 *
 * specs/collab-lifecycle-notifications Phase 1.1.
 */
describe('verifyInternalToken — shared-secret gate', () => {
    it('accepts a matching header', () => {
        expect(verifyInternalToken('s3cr3t', 's3cr3t')).toBe(true);
    });

    it('rejects a mismatched header', () => {
        expect(verifyInternalToken('wrong', 's3cr3t')).toBe(false);
    });

    it('rejects an empty header even when the expected secret is empty', () => {
        // Empty expected secret means INTERNAL_FEED_TOKEN was not configured
        // — the gate must close, not open, in that case.
        expect(verifyInternalToken('', '')).toBe(false);
        expect(verifyInternalToken(undefined, '')).toBe(false);
    });

    it('rejects an undefined header against a real secret', () => {
        expect(verifyInternalToken(undefined, 's3cr3t')).toBe(false);
    });

    it('rejects an undefined expected (env unset) regardless of header', () => {
        expect(verifyInternalToken('anything', undefined)).toBe(false);
    });

    it('treats Authorization-style "Bearer <token>" headers as opaque (must match exactly)', () => {
        // The gate does NOT silently strip "Bearer " — caller must send the
        // raw secret as the X-Internal-Token header value. Pinning this so
        // a future "convenience" parse doesn't accidentally weaken auth.
        expect(verifyInternalToken('Bearer s3cr3t', 's3cr3t')).toBe(false);
    });
});

describe('InternalCollabFeedBodySchema — request body validation', () => {
    const validBody = {
        targetUserId: 'u-bob-123',
        body: {
            kind: 'collab_request_accepted' as const,
            requestId: 'cr-abc',
            projectId: 'p-1',
            projectName: '할일 관리',
            ownerUsername: 'alice',
            respondedAt: 1747440000000,
        },
    };

    it('accepts a well-formed body', () => {
        expect(InternalCollabFeedBodySchema.parse(validBody)).toEqual(validBody);
    });

    it('rejects when targetUserId is missing', () => {
        const { targetUserId: _omit, ...rest } = validBody;
        expect(() => InternalCollabFeedBodySchema.parse(rest)).toThrow();
    });

    it('rejects when body is missing', () => {
        const { body: _omit, ...rest } = validBody;
        expect(() => InternalCollabFeedBodySchema.parse(rest)).toThrow();
    });

    it('rejects an unknown FeedBody.kind (defense against drift)', () => {
        expect(() =>
            InternalCollabFeedBodySchema.parse({
                targetUserId: 'u-bob',
                body: { kind: 'unknown_kind', foo: 'bar' },
            }),
        ).toThrow();
    });

    it('rejects an empty targetUserId', () => {
        expect(() =>
            InternalCollabFeedBodySchema.parse({ ...validBody, targetUserId: '' }),
        ).toThrow();
    });
});
