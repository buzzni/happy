import * as z from "zod";

export const FeedBodySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('friend_request'), uid: z.string() }),
    z.object({ kind: z.literal('friend_accepted'), uid: z.string() }),
    z.object({ kind: z.literal('text'), text: z.string() }),
    z.object({
        kind: z.literal('mr_created'),
        mergeRequestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        title: z.string(),
        authorUsername: z.string().nullable()
    }),
    z.object({
        kind: z.literal('mr_approved'),
        mergeRequestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        title: z.string(),
        actorUsername: z.string().nullable()
    }),
    z.object({
        kind: z.literal('mr_merged'),
        mergeRequestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        title: z.string(),
        actorUsername: z.string().nullable()
    }),
    z.object({
        kind: z.literal('mr_comment'),
        mergeRequestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        title: z.string(),
        commentBody: z.string(),
        authorUsername: z.string().nullable()
    }),
    z.object({
        kind: z.literal('workspace_created'),
        workspaceId: z.string(),
        workspaceName: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        creatorUsername: z.string().nullable()
    }),
    // specs/collab-lifecycle-notifications Phase 1 (G1) — collab-request
    // lifecycle 5 kinds. Emitted by web-ui server through the internal
    // /v1/internal/collab-feed-post route (see internalFeedRoutes.ts).
    // expired carries no toast on the client (D2-2 silent decision) — store
    // updates only; the other four drive both a toast and a store update.
    z.object({
        kind: z.literal('collab_request_created'),
        requestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        requesterUsername: z.string().nullable(),
        message: z.string().nullable(),
        createdAt: z.number()
    }),
    z.object({
        kind: z.literal('collab_request_accepted'),
        requestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        ownerUsername: z.string().nullable(),
        respondedAt: z.number()
    }),
    z.object({
        kind: z.literal('collab_request_rejected'),
        requestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        ownerUsername: z.string().nullable(),
        rejectReason: z.string().nullable(),
        respondedAt: z.number()
    }),
    z.object({
        kind: z.literal('collab_request_cancelled'),
        requestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        requesterUsername: z.string().nullable(),
        respondedAt: z.number()
    }),
    z.object({
        kind: z.literal('collab_request_expired'),
        requestId: z.string(),
        projectId: z.string(),
        projectName: z.string(),
        requesterUsername: z.string().nullable(),
        expiredAt: z.number()
    })
]);

export type FeedBody = z.infer<typeof FeedBodySchema>;

export interface UserFeedItem {
    id: string;
    userId: string;
    repeatKey: string | null;
    body: FeedBody;
    createdAt: number;
    cursor: string;
}

export interface FeedCursor {
    before?: string;
    after?: string;
}

export interface FeedOptions {
    limit?: number;
    cursor?: FeedCursor;
}

export interface FeedResult {
    items: UserFeedItem[];
    hasMore: boolean;
}