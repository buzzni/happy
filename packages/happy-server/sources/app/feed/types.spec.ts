import { describe, it, expect } from 'vitest';
import { FeedBodySchema } from './types';

/**
 * Schema invariant guard for FeedBody. Both feedPostToUser (server-side) and
 * the web-ui sync handler depend on this discriminated union matching across
 * the wire. Tests pin each `kind` so a typo or accidental field rename will
 * fail loudly in CI rather than silently dropping notifications.
 *
 * specs/collab-lifecycle-notifications Phase 1 (G1) — collab_request_*
 * additions.
 */
describe('FeedBodySchema — collab_request_* (G1 Phase 1)', () => {
    const baseRequest = {
        requestId: 'cr-abc-123',
        projectId: 'mp7zt2fi9bx6',
        projectName: '할일 관리',
    };

    it('accepts collab_request_created with message + createdAt', () => {
        const body = {
            kind: 'collab_request_created',
            ...baseRequest,
            requesterUsername: 'bob',
            message: '백엔드 작업 도와드릴 수 있어요',
            createdAt: 1747440000000,
        };
        expect(FeedBodySchema.parse(body)).toEqual(body);
    });

    it('accepts collab_request_created with null username + null message', () => {
        const body = {
            kind: 'collab_request_created',
            ...baseRequest,
            requesterUsername: null,
            message: null,
            createdAt: 1747440000000,
        };
        expect(FeedBodySchema.parse(body)).toEqual(body);
    });

    it('accepts collab_request_accepted', () => {
        const body = {
            kind: 'collab_request_accepted',
            ...baseRequest,
            ownerUsername: 'alice',
            respondedAt: 1747440000000,
        };
        expect(FeedBodySchema.parse(body)).toEqual(body);
    });

    it('accepts collab_request_rejected with rejectReason', () => {
        const body = {
            kind: 'collab_request_rejected',
            ...baseRequest,
            ownerUsername: 'alice',
            rejectReason: '프로젝트 범위와 다름',
            respondedAt: 1747440000000,
        };
        expect(FeedBodySchema.parse(body)).toEqual(body);
    });

    it('accepts collab_request_rejected with null rejectReason (옛 데이터)', () => {
        const body = {
            kind: 'collab_request_rejected',
            ...baseRequest,
            ownerUsername: 'alice',
            rejectReason: null,
            respondedAt: 1747440000000,
        };
        expect(FeedBodySchema.parse(body)).toEqual(body);
    });

    it('accepts collab_request_cancelled', () => {
        const body = {
            kind: 'collab_request_cancelled',
            ...baseRequest,
            requesterUsername: 'bob',
            respondedAt: 1747440000000,
        };
        expect(FeedBodySchema.parse(body)).toEqual(body);
    });

    it('accepts collab_request_expired', () => {
        const body = {
            kind: 'collab_request_expired',
            ...baseRequest,
            requesterUsername: 'bob',
            expiredAt: 1747440000000,
        };
        expect(FeedBodySchema.parse(body)).toEqual(body);
    });

    it('rejects collab_request_created without requestId', () => {
        expect(() =>
            FeedBodySchema.parse({
                kind: 'collab_request_created',
                projectId: 'mp7zt2fi9bx6',
                projectName: '할일 관리',
                requesterUsername: 'bob',
                message: null,
                createdAt: 1747440000000,
            }),
        ).toThrow();
    });

    it('rejects unknown collab_request_* kind', () => {
        expect(() =>
            FeedBodySchema.parse({
                kind: 'collab_request_pending',
                ...baseRequest,
                requesterUsername: 'bob',
                createdAt: 1747440000000,
            }),
        ).toThrow();
    });

    it('keeps existing kinds untouched (mr_created round-trip)', () => {
        const body = {
            kind: 'mr_created',
            mergeRequestId: 'mr-1',
            projectId: 'p-1',
            projectName: 'p',
            title: 't',
            authorUsername: 'bob',
        };
        expect(FeedBodySchema.parse(body)).toEqual(body);
    });

    it('keeps existing kinds untouched (workspace_created round-trip)', () => {
        const body = {
            kind: 'workspace_created',
            workspaceId: 'w-1',
            workspaceName: 'Bob 의 작업공간',
            projectId: 'p-1',
            projectName: 'p',
            creatorUsername: 'bob',
        };
        expect(FeedBodySchema.parse(body)).toEqual(body);
    });
});
