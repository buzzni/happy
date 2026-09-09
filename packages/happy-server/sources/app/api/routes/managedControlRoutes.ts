/**
 * The control plane's write surface.
 *
 * Two independent proofs are required on every route here, and neither is
 * sufficient alone. The account bearer says which account is being acted for;
 * the Ed25519 assertion says the control plane asked. A stolen account token
 * would otherwise be enough to mint session grants for that account, which is
 * the authority this server is being asked to delegate in the first place.
 *
 * A scoped bearer is never accepted. `auth.verifyToken` refuses one by
 * construction — the two token kinds are signed under different services — so a
 * managed child cannot reach these routes even if it learns their paths.
 *
 * The decisions themselves live in `managedAuthorityProjection` and
 * `managedSessionGrant`. These handlers translate HTTP and check who is asking;
 * they do not decide what is allowed, so a second caller of those functions
 * cannot be weaker than this one.
 */

import { z } from 'zod';

import { type Fastify } from '../types';
import { CONTROL_ASSERTION_PURPOSE, type ControlOperation } from '@/app/managed/managedControlAssertion';
import type { ManagedControlRuntime } from '@/app/managed/managedControlRuntime';
import {
    readAuthoritySnapshot,
    syncRunAuthority,
    syncWorkspaceAuthority,
} from '@/app/managed/managedAuthorityProjection';
import {
    issueSessionGrant,
    renewSessionGrant,
    resolveSessionGrant,
    revokeSessionGrant,
    type ManagedScope,
} from '@/app/managed/managedSessionGrant';

export const CONTROL_ASSERTION_HEADER = 'x-happy-control-assertion';

const identifier = z.string().trim().min(1).max(200);
const version = z.number().int().min(0);
/**
 * An instant this server will compare and store. `z.number().int()` alone
 * accepts values past `Number.MAX_SAFE_INTEGER`, where JSON round-trips stop
 * being exact — so the bound is stated here rather than assumed from the
 * validator's version.
 */
const instant = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
    .refine(Number.isSafeInteger, { message: 'must be a safe integer' });

const scopeSchema = z.object({
    tenantId: identifier,
    projectId: identifier,
    workspaceId: identifier,
    runtimeId: identifier,
    epoch: version,
    runId: identifier,
    attemptId: identifier,
    sessionId: identifier,
    accountId: identifier,
    workspaceAuthorityVersion: version,
    runAuthorityVersion: version,
}).strict();

const workspaceSyncSchema = z.object({
    ownerAccountId: identifier,
    expectedVersion: version,
    body: z.object({
        workspaceId: identifier,
        tenantId: identifier,
        projectId: identifier,
        epoch: version,
        runtimeId: identifier,
    }).strict(),
}).strict();

const runSyncSchema = z.object({
    expectedVersion: version,
    body: z.object({
        runId: identifier,
        workspaceId: identifier,
        accountId: identifier,
        currentAttemptId: identifier,
        cancelled: z.boolean(),
    }).strict(),
}).strict();

const mintSchema = z.object({
    scope: scopeSchema,
    grantId: identifier,
    requestId: identifier,
    expiresAt: z.number().int().min(1),
}).strict();

const renewSchema = z.object({
    scope: scopeSchema,
    expectedRenewalSeq: version,
    expiresAt: z.number().int().min(1),
}).strict();

const snapshotSchema = z.object({
    requestId: identifier,
    tenantId: identifier,
    projectId: identifier,
    workspaceId: identifier,
    runId: identifier,
    accountId: identifier,
}).strict();

const resolveSchema = z.object({
    requestId: identifier,
    scope: scopeSchema,
    requestedTokenExpiresAt: instant,
}).strict();

const revokeSchema = z.object({
    scope: scopeSchema,
    reason: z.string().trim().min(1).max(200),
}).strict();

/**
 * Failures that are the caller's mistake about state rather than a refusal to
 * let them act. Everything else is 403: the request was understood and denied.
 */
const CONFLICT_REASONS = new Set([
    'version-conflict', 'body-conflict', 'request-conflict',
    'family-exists', 'renewal-conflict', 'not-extending',
]);

function failureStatus(reason: string): number {
    if (CONFLICT_REASONS.has(reason)) return 409;
    if (reason === 'run-unknown' || reason === 'workspace-missing' || reason === 'grant-unknown') return 404;
    return 403;
}

export function managedControlRoutes(
    app: Fastify,
    getRuntime: () => ManagedControlRuntime | null,
) {
    /**
     * Refuses before Fastify validates the body.
     *
     * Fastify runs schema validation ahead of `preHandler`, so an authentication
     * check placed there answers 400 to an anonymous caller with a malformed
     * body — telling them the route's shape before establishing they may ask at
     * all. `onRequest` runs first, which is where both the bearer and the
     * unconfigured refusal belong.
     */
    async function requireConfigured(
        _request: unknown,
        reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    ) {
        if (!getRuntime()) {
            // Unconfigured is refusal, never a fallback to the bearer alone.
            return reply.code(503).send({ error: 'Managed control is not configured' });
        }
    }

    /**
     * The second proof, checked against the exact body this handler will act on
     * — which is why it cannot move any earlier than the parsed request.
     */
    function authorize(
        request: { headers: Record<string, unknown>; body: unknown; userId: string },
        reply: { code: (n: number) => { send: (b: unknown) => unknown } },
        operation: ControlOperation,
    ): ManagedControlRuntime | null {
        const runtime = getRuntime();
        if (!runtime) {
            reply.code(503).send({ error: 'Managed control is not configured' });
            return null;
        }
        const header = request.headers[CONTROL_ASSERTION_HEADER];
        if (typeof header !== 'string' || header.length === 0) {
            reply.code(403).send({ error: 'Missing control assertion' });
            return null;
        }
        const verified = runtime.assertions.verify({
            assertion: header,
            operation,
            body: request.body,
            now: Date.now(),
        });
        if (!verified.ok) {
            reply.code(403).send({ error: 'Invalid control assertion', reason: verified.reason });
            return null;
        }
        return runtime;
    }

    app.post('/v1/managed/control/authority/workspace', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: workspaceSyncSchema },
    }, async (request, reply) => {
        if (!authorize(request as never, reply as never, 'authority-sync')) return;
        // The workspace row carries no owner of its own, so the caller states
        // which account it is acting for and the bearer has to be that account.
        if (request.body.ownerAccountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }
        const result = await syncWorkspaceAuthority({
            body: request.body.body,
            expectedVersion: request.body.expectedVersion,
            now: Date.now(),
        });
        if (!result.ok) return reply.code(failureStatus(result.reason)).send({ error: result.reason });
        return reply.send({ version: result.version, idempotent: result.idempotent });
    });

    app.post('/v1/managed/control/authority/run', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: runSyncSchema },
    }, async (request, reply) => {
        if (!authorize(request as never, reply as never, 'authority-sync')) return;
        if (request.body.body.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }
        const result = await syncRunAuthority({
            body: request.body.body,
            expectedVersion: request.body.expectedVersion,
            now: Date.now(),
        });
        if (!result.ok) return reply.code(failureStatus(result.reason)).send({ error: result.reason });
        return reply.send({ version: result.version, idempotent: result.idempotent });
    });

    /**
     * Reads both projections so a control plane that lost its own memory can
     * sign the next body against what this server actually holds.
     *
     * A signed POST rather than a GET: the verifier binds the request body, so
     * a GET's path and query would carry no proof at all.
     */
    app.post('/v1/managed/control/authority/snapshot', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: snapshotSchema },
    }, async (request, reply) => {
        if (!authorize(request as never, reply as never, 'authority-snapshot')) return;
        if (request.body.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }
        const snapshot = await readAuthoritySnapshot({
            tenantId: request.body.tenantId,
            projectId: request.body.projectId,
            workspaceId: request.body.workspaceId,
            runId: request.body.runId,
            accountId: request.body.accountId,
        });
        // A mismatch is a refusal, never a `null` that reads as "create it".
        if (!snapshot.ok) return reply.code(403).send({ error: snapshot.reason });
        return reply.send({
            requestId: request.body.requestId,
            workspace: snapshot.workspace,
            run: snapshot.run,
        });
    });

    app.post('/v1/managed/control/grants/mint', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: mintSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'grant-mint');
        if (!runtime) return;
        const scope = request.body.scope as ManagedScope;
        if (scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }

        const now = Date.now();
        const issued = await issueSessionGrant({
            scope,
            grantId: request.body.grantId,
            requestId: request.body.requestId,
            expiresAt: request.body.expiresAt,
            now,
        });
        if (!issued.ok) return reply.code(failureStatus(issued.reason)).send({ error: issued.reason });

        // The token is minted from the stored grant, not from the request: a
        // bearer must never claim more than the row that authorises it.
        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: issued.grant.grantId,
            accountId: issued.grant.accountId,
            sessionId: issued.grant.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: issued.grant.workspaceId,
            runtimeId: scope.runtimeId,
            runId: issued.grant.runId,
            attemptId: issued.grant.attemptId,
            epoch: issued.grant.epoch,
            workspaceAuthorityVersion: issued.grant.workspaceAuthorityVersion,
            runAuthorityVersion: issued.grant.runAuthorityVersion,
            expiresAt: issued.grant.expiresAt,
        }, now);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            token: minted.token,
            grantId: issued.grant.grantId,
            expiresAt: issued.grant.expiresAt,
            renewalSeq: issued.grant.renewalSeq,
            idempotent: issued.idempotent,
            serverUrl: runtime.publicUrl,
        });
    });

    app.post('/v1/managed/control/grants/renew', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: renewSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'grant-renew');
        if (!runtime) return;
        const scope = request.body.scope as ManagedScope;
        if (scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }

        const now = Date.now();
        const renewed = await renewSessionGrant({
            scope,
            expectedRenewalSeq: request.body.expectedRenewalSeq,
            expiresAt: request.body.expiresAt,
            now,
        });
        if (!renewed.ok) return reply.code(failureStatus(renewed.reason)).send({ error: renewed.reason });

        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: renewed.grant.grantId,
            accountId: renewed.grant.accountId,
            sessionId: renewed.grant.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: renewed.grant.workspaceId,
            runtimeId: scope.runtimeId,
            runId: renewed.grant.runId,
            attemptId: renewed.grant.attemptId,
            epoch: renewed.grant.epoch,
            workspaceAuthorityVersion: renewed.grant.workspaceAuthorityVersion,
            runAuthorityVersion: renewed.grant.runAuthorityVersion,
            expiresAt: renewed.grant.expiresAt,
        }, now);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            token: minted.token,
            grantId: renewed.grant.grantId,
            expiresAt: renewed.grant.expiresAt,
            renewalSeq: renewed.grant.renewalSeq,
            idempotent: renewed.idempotent,
            serverUrl: runtime.publicUrl,
        });
    });

    /**
     * Recovers the token for a grant that already exists.
     *
     * It writes nothing, but it issues a credential, so it carries the same two
     * proofs and the same scope checks as a mint. The token's expiry is the
     * lesser of the grant's own and the one the caller signed for, and the
     * expiry is re-checked at the moment of issue: the read may have waited on
     * the database long enough for the grant to lapse in between.
     */
    app.post('/v1/managed/control/grants/resolve', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: resolveSchema },
    }, async (request, reply) => {
        const runtime = authorize(request as never, reply as never, 'grant-resolve');
        if (!runtime) return;
        const scope = request.body.scope as ManagedScope;
        if (scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }

        const resolved = await resolveSessionGrant({
            scope,
            requestedTokenExpiresAt: request.body.requestedTokenExpiresAt,
            now: Date.now(),
        });
        if (!resolved.ok) {
            return reply.code(failureStatus(resolved.reason)).send({ error: resolved.reason });
        }
        const { grant, tokenExpiresAt } = resolved.resolved;

        // Issued against the clock now, not the one the read started with.
        const issuedAt = Date.now();
        if (tokenExpiresAt <= issuedAt) {
            return reply.code(403).send({ error: 'expired' });
        }
        const minted = await runtime.scopedTokens.mint({
            v: 1,
            grantId: grant.grantId,
            accountId: grant.accountId,
            sessionId: grant.sessionId,
            tenantId: scope.tenantId,
            projectId: scope.projectId,
            workspaceId: grant.workspaceId,
            runtimeId: scope.runtimeId,
            runId: grant.runId,
            attemptId: grant.attemptId,
            epoch: grant.epoch,
            workspaceAuthorityVersion: grant.workspaceAuthorityVersion,
            runAuthorityVersion: grant.runAuthorityVersion,
            expiresAt: tokenExpiresAt,
        }, issuedAt);
        if (!minted.ok) return reply.code(500).send({ error: 'Grant token could not be minted' });

        return reply.send({
            requestId: request.body.requestId,
            scope,
            grantId: grant.grantId,
            token: minted.token,
            tokenExpiresAt,
            grantExpiresAt: grant.expiresAt,
            renewalSeq: grant.renewalSeq,
        });
    });

    app.post('/v1/managed/control/grants/revoke', {
        onRequest: [app.authenticate, requireConfigured],
        schema: { body: revokeSchema },
    }, async (request, reply) => {
        if (!authorize(request as never, reply as never, 'grant-revoke')) return;
        const scope = request.body.scope as ManagedScope;
        if (scope.accountId !== request.userId) {
            return reply.code(403).send({ error: 'Bearer does not own this scope' });
        }
        const result = await revokeSessionGrant({ scope, reason: request.body.reason, now: Date.now() });
        if (!result.ok) return reply.code(failureStatus(result.reason)).send({ error: result.reason });
        return reply.send({ state: result.state, alreadyRevoked: result.alreadyRevoked });
    });
}

export const MANAGED_CONTROL_PURPOSE = CONTROL_ASSERTION_PURPOSE;
