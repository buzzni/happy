import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type * as GrantModule from '@/app/managed/managedSessionGrant';
import type * as ProjectionModule from '@/app/managed/managedAuthorityProjection';
import type { SessionScopedClaims } from '@/app/auth/sessionScopedToken';

/**
 * Real-PostgreSQL suite, opt-in only — see the header of
 * `managedAuthorityProjection.spec.ts` for why these guarantees cannot be
 * asserted against a fake, and how the database is scoped and cleaned.
 *
 * Accounts and sessions here are real rows, not placeholder strings: the checks
 * under test include who currently owns the session, which nothing but the real
 * table can answer.
 */

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
const enabled = Boolean(TEST_DATABASE_URL);

const priorEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_PROVIDER: process.env.DB_PROVIDER,
};
if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
}
function restoreEnv(): void {
    for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

type Fn = (...args: never[]) => never;

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

let db: PrismaClient;
let grants: typeof GrantModule;
let projection: typeof ProjectionModule;

const createdWorkspaceIds = new Set<string>();
const createdRunIds = new Set<string>();
const createdSessionIds = new Set<string>();
const createdAccountIds = new Set<string>();

let workspaceId: string;
let runId: string;
let sessionId: string;
let accountId: string;
let otherAccountId: string;

function scope(over: Partial<GrantModule.ManagedScope> = {}): GrantModule.ManagedScope {
    return {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        workspaceId,
        runtimeId: 'runtime-1',
        epoch: 1,
        runId,
        attemptId: 'attempt-1',
        sessionId,
        accountId,
        workspaceAuthorityVersion: 1,
        runAuthorityVersion: 1,
        ...over,
    };
}

function issueInput(over: Partial<GrantModule.IssueGrantInput> = {}): GrantModule.IssueGrantInput {
    return {
        scope: scope(),
        grantId: `grant-${randomUUID()}`,
        expiresAt: NOW + HOUR,
        requestId: `req-${randomUUID()}`,
        now: NOW,
        ...over,
    };
}

function claimsFor(over: Partial<SessionScopedClaims> = {}): SessionScopedClaims {
    const s = scope();
    return {
        v: 1,
        grantId: 'set-by-caller',
        accountId: s.accountId,
        sessionId: s.sessionId,
        tenantId: s.tenantId,
        projectId: s.projectId,
        workspaceId: s.workspaceId,
        runtimeId: s.runtimeId,
        runId: s.runId,
        attemptId: s.attemptId,
        epoch: s.epoch,
        workspaceAuthorityVersion: s.workspaceAuthorityVersion,
        runAuthorityVersion: s.runAuthorityVersion,
        expiresAt: NOW + HOUR,
        ...over,
    };
}

async function createAccount(): Promise<string> {
    const account = await db.account.create({
        data: { publicKey: `pk-${randomUUID()}` },
    });
    createdAccountIds.add(account.id);
    return account.id;
}

describe.skipIf(!enabled)('managed session grants (real PostgreSQL)', () => {
    beforeEach(async () => {
        if (!grants) {
            grants = await import('@/app/managed/managedSessionGrant');
            projection = await import('@/app/managed/managedAuthorityProjection');
            db = (await import('@/storage/db')).db as unknown as PrismaClient;
        }
        workspaceId = `ws-${randomUUID()}`;
        runId = `run-${randomUUID()}`;
        createdWorkspaceIds.add(workspaceId);
        createdRunIds.add(runId);

        accountId = await createAccount();
        otherAccountId = await createAccount();
        const session = await db.session.create({
            data: { accountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        sessionId = session.id;
        createdSessionIds.add(sessionId);

        await projection.syncWorkspaceAuthority({
            body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 1, runtimeId: 'runtime-1' },
            expectedVersion: 0,
            now: NOW,
        });
        await projection.syncRunAuthority({
            body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-1', cancelled: false },
            expectedVersion: 0,
            now: NOW,
        });
    });

    afterEach(async () => {
        await db.managedSessionGrant.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedRunAuthority.deleteMany({ where: { runId: { in: [...createdRunIds] } } });
        await db.managedWorkspaceAuthority.deleteMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
        });
        await db.session.deleteMany({ where: { id: { in: [...createdSessionIds] } } });
        await db.account.deleteMany({ where: { id: { in: [...createdAccountIds] } } });
    });

    afterAll(async () => {
        for (const [name, count] of [
            ['grants', await db.managedSessionGrant.count({ where: { runId: { in: [...createdRunIds] } } })],
            ['runs', await db.managedRunAuthority.count({ where: { runId: { in: [...createdRunIds] } } })],
            ['workspaces', await db.managedWorkspaceAuthority.count({ where: { workspaceId: { in: [...createdWorkspaceIds] } } })],
            ['sessions', await db.session.count({ where: { id: { in: [...createdSessionIds] } } })],
            ['accounts', await db.account.count({ where: { id: { in: [...createdAccountIds] } } })],
        ] as const) {
            expect(count, name).toBe(0);
        }
        await db.$disconnect();
        restoreEnv();
    });

    describe('the family is derived, not chosen', () => {
        it('gives the same family to the same identity and a different one to a different attempt', () => {
            expect(grants.deriveGrantFamily(scope())).toBe(grants.deriveGrantFamily(scope()));
            expect(grants.deriveGrantFamily(scope({ attemptId: 'attempt-2' })))
                .not.toBe(grants.deriveGrantFamily(scope()));
        });

        it('does not change when only the authority versions move', () => {
            // Otherwise every version bump would open a fresh family and a
            // revoke could be walked around by waiting for one.
            expect(grants.deriveGrantFamily(scope({ epoch: 9, workspaceAuthorityVersion: 9, runAuthorityVersion: 9 })))
                .toBe(grants.deriveGrantFamily(scope()));
        });

        it('refuses a second mint for the same identity under any spelling', async () => {
            await grants.issueSessionGrant(issueInput());
            // A caller cannot pick a new family: the same run, attempt and
            // session always resolve to the same one.
            expect(await grants.issueSessionGrant(issueInput()))
                .toEqual({ ok: false, reason: 'family-exists' });
        });
    });

    describe('the signed scope is compared exactly', () => {
        it('issues when every field still matches the projection', async () => {
            const result = await grants.issueSessionGrant(issueInput());
            expect(result).toMatchObject({ ok: true, idempotent: false });
            if (result.ok) {
                expect(result.grant).toMatchObject({
                    sessionId, accountId, runId, attemptId: 'attempt-1',
                    epoch: 1, workspaceAuthorityVersion: 1, runAuthorityVersion: 1, renewalSeq: 0,
                });
            }
        });

        it('refuses a mint signed against an older workspace generation', async () => {
            await projection.syncWorkspaceAuthority({
                body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 4, runtimeId: 'runtime-2' },
                expectedVersion: 1,
                now: NOW,
            });
            // The delayed assertion must not be promoted to the new generation
            // by filling its epoch and versions from the current row.
            expect(await grants.issueSessionGrant(issueInput()))
                .toEqual({ ok: false, reason: 'authority-stale' });
        });

        it('refuses each stale field on its own', async () => {
            for (const over of [
                { epoch: 2 },
                { runtimeId: 'runtime-2' },
                { workspaceAuthorityVersion: 2 },
                { runAuthorityVersion: 2 },
            ] as Partial<GrantModule.ManagedScope>[]) {
                expect(await grants.issueSessionGrant(issueInput({ scope: scope(over) })), JSON.stringify(over))
                    .toEqual({ ok: false, reason: 'authority-stale' });
            }
        });

        it('refuses a binding that names another tenant, project or workspace', async () => {
            for (const over of [
                { tenantId: 'tenant-2' },
                { projectId: 'project-2' },
                { workspaceId: `ws-${randomUUID()}` },
            ] as Partial<GrantModule.ManagedScope>[]) {
                expect(await grants.issueSessionGrant(issueInput({ scope: scope(over) })), JSON.stringify(over))
                    .toEqual({ ok: false, reason: 'binding-mismatch' });
            }
        });

        it('refuses an attempt the run has moved past and an account it does not act as', async () => {
            expect(await grants.issueSessionGrant(issueInput({ scope: scope({ attemptId: 'attempt-2' }) })))
                .toEqual({ ok: false, reason: 'attempt-mismatch' });
            expect(await grants.issueSessionGrant(issueInput({ scope: scope({ accountId: otherAccountId }) })))
                .toEqual({ ok: false, reason: 'account-mismatch' });
        });

        it('refuses to mint for a session that does not exist or belongs elsewhere', async () => {
            // Without this the control plane can mint a token that no action
            // will ever resolve, and the failure surfaces at the child instead.
            expect(await grants.issueSessionGrant(issueInput({
                scope: scope({ sessionId: `session-${randomUUID()}` }),
            }))).toEqual({ ok: false, reason: 'session-unknown' });

            const foreign = await db.session.create({
                data: { accountId: otherAccountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
            });
            createdSessionIds.add(foreign.id);
            expect(await grants.issueSessionGrant(issueInput({ scope: scope({ sessionId: foreign.id }) })))
                .toEqual({ ok: false, reason: 'session-owner-changed' });
        });

        it('refuses a cancelled run and one it has never been told about', async () => {
            expect(await grants.issueSessionGrant(issueInput({ scope: scope({ runId: `run-${randomUUID()}` }) })))
                .toEqual({ ok: false, reason: 'run-unknown' });
            await projection.syncRunAuthority({
                body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-1', cancelled: true },
                expectedVersion: 1,
                now: NOW,
            });
            expect(await grants.issueSessionGrant(issueInput()))
                .toEqual({ ok: false, reason: 'run-cancelled' });
        });

        it('refuses a grant that is already expired when minted', async () => {
            expect(await grants.issueSessionGrant(issueInput({ expiresAt: NOW })))
                .toEqual({ ok: false, reason: 'already-expired' });
        });
    });

    describe('retrying a mint', () => {
        it('returns the same grant for an exact retry', async () => {
            const input = issueInput();
            const first = await grants.issueSessionGrant(input);
            const retry = await grants.issueSessionGrant(input);
            expect(retry).toMatchObject({ ok: true, idempotent: true });
            if (first.ok && retry.ok) expect(retry.grant.grantId).toBe(first.grant.grantId);
        });

        it('refuses a different body under a used request id', async () => {
            const input = issueInput();
            await grants.issueSessionGrant(input);
            expect(await grants.issueSessionGrant({
                ...input, grantId: `grant-${randomUUID()}`, expiresAt: NOW + 2 * HOUR,
            })).toEqual({ ok: false, reason: 'request-conflict' });
        });

        it('refuses a retry after the family was revoked', async () => {
            const input = issueInput();
            await grants.issueSessionGrant(input);
            await grants.revokeSessionGrant({ scope: scope(), reason: 'operator', now: NOW });
            // Repeating the mint must not hand a withdrawn child a live token.
            expect(await grants.issueSessionGrant(input))
                .toEqual({ ok: false, reason: 'family-revoked' });
        });

        it('refuses a retry once the authority has moved on', async () => {
            const input = issueInput();
            await grants.issueSessionGrant(input);
            await projection.syncRunAuthority({
                body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-2', cancelled: false },
                expectedVersion: 1,
                now: NOW,
            });
            expect(await grants.issueSessionGrant(input))
                .toEqual({ ok: false, reason: 'attempt-mismatch' });
        });

        it('refuses a retry after the grant it produced has expired', async () => {
            const input = issueInput();
            await grants.issueSessionGrant(input);
            expect(await grants.issueSessionGrant({ ...input, now: NOW + HOUR }))
                .toEqual({ ok: false, reason: 'already-expired' });
        });

        it('does not let a replayed mint inherit a later renewal*s expiry', async () => {
            const input = issueInput({ expiresAt: NOW + 60_000 });
            const first = await grants.issueSessionGrant(input);
            expect(first).toMatchObject({ ok: true });

            await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 300_000, now: NOW + 20_000,
            });

            // Replaying the original request must not hand back the extended
            // expiry: the assertion behind it only ever authorised 60 seconds.
            const replay = await grants.issueSessionGrant({ ...input, now: NOW + 30_000 });
            expect(replay).toMatchObject({ ok: true, idempotent: true });
            if (replay.ok) expect(replay.grant.expiresAt).toBe(NOW + 60_000);

            // The grant itself keeps the renewed expiry; only what the replay
            // may claim is capped.
            const row = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
            expect(Number(row.expiresAt)).toBe(NOW + 300_000);
        });

        it('refuses the replay once the originally signed expiry has passed', async () => {
            const input = issueInput({ expiresAt: NOW + 60_000 });
            await grants.issueSessionGrant(input);
            await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 300_000, now: NOW + 20_000,
            });
            expect(await grants.issueSessionGrant({ ...input, now: NOW + 60_000 }))
                .toEqual({ ok: false, reason: 'already-expired' });
        });

        it('lets exactly one of two concurrent mints win', async () => {
            const [a, b] = await Promise.all([
                grants.issueSessionGrant(issueInput()),
                grants.issueSessionGrant(issueInput()),
            ]);
            expect([a, b].filter((r) => r.ok)).toHaveLength(1);
            expect(await db.managedSessionGrant.count({ where: { runId } })).toBe(1);
        });
    });

    describe('revoking', () => {
        it('revokes a live grant and stays terminal', async () => {
            await grants.issueSessionGrant(issueInput());
            expect(await grants.revokeSessionGrant({ scope: scope(), reason: 'operator', now: NOW }))
                .toEqual({ ok: true, state: 'revoked', alreadyRevoked: false });
            expect(await grants.revokeSessionGrant({ scope: scope(), reason: 'again', now: NOW + 1 }))
                .toEqual({ ok: true, state: 'revoked', alreadyRevoked: true });
            const row = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
            expect(row.revokedAt).not.toBeNull();
            // The first reason stands, so an audit reads what stopped the child.
            expect(row.revokedReason).toBe('operator');
        });

        it('tombstones a revoke that arrives before the mint it cancels', async () => {
            expect(await grants.revokeSessionGrant({ scope: scope(), reason: 'cancelled', now: NOW }))
                .toEqual({ ok: true, state: 'tombstoned', alreadyRevoked: false });
            const row = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
            // The tombstone carries the same scope the mint would have.
            expect(row).toMatchObject({
                tombstone: true, sessionId, accountId, workspaceId, attemptId: 'attempt-1',
            });
            expect(await grants.issueSessionGrant(issueInput()))
                .toEqual({ ok: false, reason: 'family-revoked' });
        });

        it('does not resurrect a revoked family under a new grant id', async () => {
            await grants.issueSessionGrant(issueInput());
            await grants.revokeSessionGrant({ scope: scope(), reason: 'operator', now: NOW });
            expect(await grants.issueSessionGrant(issueInput()))
                .toEqual({ ok: false, reason: 'family-revoked' });
        });

        it('reports a run it has never been told about instead of writing a tombstone', async () => {
            const unknownRun = `run-${randomUUID()}`;
            expect(await grants.revokeSessionGrant({
                scope: scope({ runId: unknownRun }), reason: 'x', now: NOW,
            })).toEqual({ ok: false, reason: 'run-unknown' });
            expect(await db.managedSessionGrant.count({ where: { runId: unknownRun } })).toBe(0);
        });

        it('revokes the mint that won the insert, not the label it returned', async () => {
            // The interleaving that matters: the revoke reads an empty family,
            // a mint commits, and the revoke's own insert then hits the unique
            // constraint. That violation aborts its transaction, so recovery has
            // to re-run — and must land on the row the mint actually created.
            const minted = await grants.issueSessionGrant(issueInput());
            expect(minted).toMatchObject({ ok: true });

            let injected = false;
            const original = (db as unknown as { $transaction: Fn }).$transaction.bind(db);
            (db as unknown as { $transaction: Fn }).$transaction = ((...args: never[]) => {
                if (injected) return original(...args);
                injected = true;
                return Promise.reject(new Prisma.PrismaClientKnownRequestError(
                    'Unique constraint failed',
                    { code: 'P2002', clientVersion: Prisma.prismaVersion.client },
                ));
            }) as Fn;

            let result;
            try {
                result = await grants.revokeSessionGrant({ scope: scope(), reason: 'race', now: NOW + 1 });
            } finally {
                (db as unknown as { $transaction: Fn }).$transaction = original;
            }
            expect(injected).toBe(true);
            expect(result).toMatchObject({ ok: true });

            const rows = await db.managedSessionGrant.findMany({ where: { runId } });
            expect(rows).toHaveLength(1);
            // The row itself, not the label the call returned.
            expect(rows[0].revokedAt).not.toBeNull();
            expect(rows[0].revokedReason).toBe('race');
            expect(rows[0].tombstone).toBe(false);
            expect(rows[0].grantId).toBe(minted.ok ? minted.grant.grantId : '');
        });

        it('revokes the winner when a mint and a revoke run concurrently', async () => {
            const [minted, revoked] = await Promise.all([
                grants.issueSessionGrant(issueInput()),
                grants.revokeSessionGrant({ scope: scope(), reason: 'race', now: NOW }),
            ]);
            expect(revoked).toMatchObject({ ok: true });
            const rows = await db.managedSessionGrant.findMany({ where: { runId } });
            expect(rows).toHaveLength(1);
            if (minted.ok) {
                // A mint that succeeded before the revoke must be revoked by it;
                // one that lost sees the tombstone.
                expect(rows[0].revokedAt).not.toBeNull();
            } else {
                expect(rows[0].tombstone).toBe(true);
            }
            // Either way nothing live is left behind.
            expect(rows[0].revokedAt).not.toBeNull();
        });
    });

    describe('renewing', () => {
        it('extends in place under compare-and-set', async () => {
            await grants.issueSessionGrant(issueInput());
            const renewed = await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW,
            });
            expect(renewed).toMatchObject({ ok: true, idempotent: false });
            if (renewed.ok) expect(renewed.grant).toMatchObject({ renewalSeq: 1, expiresAt: NOW + 2 * HOUR });
        });

        it('returns the stored grant for an exact retry', async () => {
            await grants.issueSessionGrant(issueInput());
            const args = { scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW };
            await grants.renewSessionGrant(args);
            expect(await grants.renewSessionGrant(args)).toMatchObject({ ok: true, idempotent: true });
        });

        it('refuses an idempotent retry once the authority has moved on', async () => {
            await grants.issueSessionGrant(issueInput());
            const args = { scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW };
            await grants.renewSessionGrant(args);
            await projection.syncRunAuthority({
                body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-2', cancelled: false },
                expectedVersion: 1,
                now: NOW,
            });
            // The stored answer is not returned before the checks run.
            expect(await grants.renewSessionGrant(args))
                .toEqual({ ok: false, reason: 'attempt-mismatch' });
        });

        it('refuses a stale sequence and a renewal that shortens the grant', async () => {
            await grants.issueSessionGrant(issueInput());
            await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW,
            });
            expect(await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 3 * HOUR, now: NOW,
            })).toEqual({ ok: false, reason: 'renewal-conflict' });
            expect(await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 1, expiresAt: NOW + HOUR, now: NOW,
            })).toEqual({ ok: false, reason: 'not-extending' });
        });

        it('refuses to revive a revoked grant by extending it', async () => {
            await grants.issueSessionGrant(issueInput());
            await grants.revokeSessionGrant({ scope: scope(), reason: 'operator', now: NOW });
            expect(await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW,
            })).toEqual({ ok: false, reason: 'revoked' });
        });

        it('refuses a renewal signed against a stale generation', async () => {
            await grants.issueSessionGrant(issueInput());
            await projection.syncWorkspaceAuthority({
                body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 2, runtimeId: 'runtime-2' },
                expectedVersion: 1,
                now: NOW,
            });
            expect(await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW,
            })).toEqual({ ok: false, reason: 'authority-stale' });
        });

        it('refuses to renew a grant that is already past its expiry', async () => {
            await grants.issueSessionGrant(issueInput());
            // Renewing an expired grant would revive a child the expiry already
            // stopped; a new mint is the only way back.
            expect(await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 10 * HOUR, now: NOW + HOUR,
            })).toEqual({ ok: false, reason: 'expired' });
        });

        it('refuses an idempotent retry once the renewed grant has expired', async () => {
            await grants.issueSessionGrant(issueInput());
            const args = { scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW };
            await grants.renewSessionGrant(args);
            expect(await grants.renewSessionGrant({ ...args, now: NOW + 3 * HOUR }))
                .toEqual({ ok: false, reason: 'expired' });
        });

        it('refuses to promote a grant minted against an older generation', async () => {
            await grants.issueSessionGrant(issueInput());
            await projection.syncWorkspaceAuthority({
                body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 2, runtimeId: 'runtime-2' },
                expectedVersion: 1,
                now: NOW,
            });
            const current = scope({ epoch: 2, runtimeId: 'runtime-2', workspaceAuthorityVersion: 2 });
            // The scope is current, so the projection comparison passes. The
            // grant is not, and renewing must not carry it forward.
            expect(await grants.renewSessionGrant({
                scope: current, expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW,
            })).toEqual({ ok: false, reason: 'authority-stale' });
            const row = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
            expect(row).toMatchObject({ epoch: 1, workspaceAuthorityVersion: 1, renewalSeq: 0 });
        });

        it('reports the stored versions, not the ones the caller sent', async () => {
            await grants.issueSessionGrant(issueInput());
            const renewed = await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW,
            });
            const row = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
            expect(renewed).toMatchObject({ ok: true });
            if (renewed.ok) {
                expect(renewed.grant).toMatchObject({
                    epoch: row.epoch,
                    workspaceAuthorityVersion: row.workspaceAuthorityVersion,
                    runAuthorityVersion: row.runAuthorityVersion,
                    renewalSeq: row.renewalSeq,
                    expiresAt: Number(row.expiresAt),
                });
            }
        });

        it('lets exactly one of two concurrent renewals win', async () => {
            await grants.issueSessionGrant(issueInput());
            const [a, b] = await Promise.all([
                grants.renewSessionGrant({ scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 2 * HOUR, now: NOW }),
                grants.renewSessionGrant({ scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 3 * HOUR, now: NOW }),
            ]);
            expect([a, b].filter((r) => r.ok)).toHaveLength(1);
            const row = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
            expect(row.renewalSeq).toBe(1);
        });
    });

    describe('resolving a grant after a lost response', () => {
        async function storedRows() {
            return db.managedSessionGrant.findMany({
                where: { runId: { in: [...createdRunIds] } }, orderBy: { grantId: 'asc' },
            });
        }

        it('returns the current grant capped by the signed request and writes nothing', async () => {
            expect(await grants.issueSessionGrant(issueInput({ expiresAt: NOW + 500 })))
                .toMatchObject({ ok: true });
            expect(await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 1_500, now: NOW,
            })).toMatchObject({ ok: true });

            const before = await storedRows();
            const resolved = await grants.resolveSessionGrant({
                scope: scope(), requestedTokenExpiresAt: NOW + 1_000, now: NOW,
            });
            expect(resolved).toMatchObject({ ok: true });
            if (resolved.ok) {
                // Not the first answer (500) and never the renewal (1500).
                expect(resolved.resolved.tokenExpiresAt).toBe(NOW + 1_000);
                expect(resolved.resolved.grant).toMatchObject({
                    renewalSeq: 1, expiresAt: NOW + 1_500,
                });
            }
            expect(await storedRows()).toEqual(before);
        });

        it('caps at the grant when the request asks for later', async () => {
            await grants.issueSessionGrant(issueInput({ expiresAt: NOW + 500 }));
            const resolved = await grants.resolveSessionGrant({
                scope: scope(), requestedTokenExpiresAt: NOW + HOUR, now: NOW,
            });
            expect(resolved).toMatchObject({ ok: true });
            if (resolved.ok) expect(resolved.resolved.tokenExpiresAt).toBe(NOW + 500);
        });

        it.each([
            ['no grant at all', async () => {}, 'grant-unknown'],
            ['a revoked family', async () => {
                await grants.issueSessionGrant(issueInput());
                await grants.revokeSessionGrant({ scope: scope(), reason: 'operator', now: NOW });
            }, 'revoked'],
            ['a revoke that arrived first', async () => {
                await grants.revokeSessionGrant({ scope: scope(), reason: 'operator', now: NOW });
            }, 'grant-unknown'],
            ['an expired grant', async () => {
                await grants.issueSessionGrant(issueInput({ expiresAt: NOW + 10 }));
            }, 'expired'],
        ])('refuses %s and creates nothing', async (_label, prepare, reason) => {
            await prepare();
            const before = await storedRows();
            expect(await grants.resolveSessionGrant({
                scope: scope(), requestedTokenExpiresAt: NOW + HOUR, now: NOW + 1_000,
            })).toEqual({ ok: false, reason });
            expect(await storedRows()).toEqual(before);
        });

        it('refuses a requested expiry that has already passed', async () => {
            await grants.issueSessionGrant(issueInput());
            expect(await grants.resolveSessionGrant({
                scope: scope(), requestedTokenExpiresAt: NOW - 1, now: NOW,
            })).toEqual({ ok: false, reason: 'already-expired' });
        });

        it('refuses a stored grant left behind by an authority advance', async () => {
            // The family deliberately excludes epoch and the versions, so an old
            // grant is still found by a fresh scope. Returning it would hand out
            // a token whose claims say "epoch 2" over a row minted at epoch 1.
            await grants.issueSessionGrant(issueInput());
            expect(await projection.syncWorkspaceAuthority({
                body: {
                    workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                    epoch: 2, runtimeId: 'runtime-1',
                },
                expectedVersion: 1, now: NOW,
            })).toMatchObject({ ok: true, version: 2 });

            const fresh = scope({ epoch: 2, workspaceAuthorityVersion: 2 });
            const before = await storedRows();
            expect(await grants.resolveSessionGrant({
                scope: fresh, requestedTokenExpiresAt: NOW + HOUR, now: NOW,
            })).toEqual({ ok: false, reason: 'grant-stale' });
            expect(await storedRows()).toEqual(before);
        });

        it.each([
            ['not a safe integer', Number.MAX_SAFE_INTEGER + 1],
            ['NaN', Number.NaN],
            ['Infinity', Number.POSITIVE_INFINITY],
            ['fractional', 1_800_000_000_000.5],
        ])('refuses a requested expiry that is %s', async (_label, requested) => {
            await grants.issueSessionGrant(issueInput());
            expect(await grants.resolveSessionGrant({
                scope: scope(), requestedTokenExpiresAt: requested, now: NOW,
            })).toEqual({ ok: false, reason: 'already-expired' });
        });

        it('runs the same scope, session and freshness checks as a mint', async () => {
            await grants.issueSessionGrant(issueInput());
            for (const [over, reason] of [
                [{ epoch: 2 }, 'authority-stale'],
                [{ runtimeId: 'runtime-2' }, 'authority-stale'],
                [{ workspaceAuthorityVersion: 2 }, 'authority-stale'],
                [{ runAuthorityVersion: 2 }, 'authority-stale'],
                [{ attemptId: 'attempt-2' }, 'attempt-mismatch'],
                [{ tenantId: 'tenant-other' }, 'binding-mismatch'],
                [{ projectId: 'project-other' }, 'binding-mismatch'],
            ] as const) {
                expect(await grants.resolveSessionGrant({
                    scope: scope(over), requestedTokenExpiresAt: NOW + HOUR, now: NOW,
                }), JSON.stringify(over)).toEqual({ ok: false, reason });
            }

            await db.session.update({
                where: { id: sessionId }, data: { accountId: await createAccount() },
            });
            expect(await grants.resolveSessionGrant({
                scope: scope(), requestedTokenExpiresAt: NOW + HOUR, now: NOW,
            })).toEqual({ ok: false, reason: 'session-owner-changed' });
        });
    });

    describe('the check every action makes', () => {
        let grantId: string;

        beforeEach(async () => {
            const issued = await grants.issueSessionGrant(issueInput());
            if (!issued.ok) throw new Error(`fixture failed: ${issued.reason}`);
            grantId = issued.grant.grantId;
        });

        function resolve(over: Partial<SessionScopedClaims> = {}, now = NOW) {
            return grants.resolveLiveGrant({ claims: claimsFor({ grantId, ...over }), now });
        }

        it('resolves a live grant whose claims match the row and the projection', async () => {
            expect(await resolve()).toMatchObject({ ok: true });
        });

        it('keeps a token issued before a renewal working until its own expiry', async () => {
            // Stated contract: a renewal extends the grant and issues a longer
            // token; it does not shorten the one already handed out. Revocation
            // is what stops a token early, and it is checked on every action.
            await grants.renewSessionGrant({
                scope: scope(), expectedRenewalSeq: 0, expiresAt: NOW + 5 * HOUR, now: NOW,
            });
            expect(await resolve({}, NOW + HOUR - 1)).toMatchObject({ ok: true });
            expect(await resolve({}, NOW + HOUR)).toEqual({ ok: false, reason: 'expired' });
        });

        it('stops resolving the moment the grant is revoked', async () => {
            await grants.revokeSessionGrant({ scope: scope(), reason: 'operator', now: NOW });
            expect(await resolve()).toEqual({ ok: false, reason: 'revoked' });
        });

        it('refuses at and past the expiry of either the row or the token', async () => {
            expect(await resolve({}, NOW + HOUR)).toEqual({ ok: false, reason: 'expired' });
            expect(await resolve({ expiresAt: NOW + 1 }, NOW + 1)).toEqual({ ok: false, reason: 'expired' });
        });

        it('refuses a token that claims to outlive the row authorising it', async () => {
            expect(await resolve({ expiresAt: NOW + 10 * HOUR }))
                .toEqual({ ok: false, reason: 'claims-mismatch' });
        });

        it('compares every claim, not just the grant id', async () => {
            for (const over of [
                { sessionId: `session-${randomUUID()}` },
                { accountId: otherAccountId },
                { runId: `run-${randomUUID()}` },
                { attemptId: 'attempt-2' },
                { epoch: 2 },
                { workspaceAuthorityVersion: 2 },
                { runAuthorityVersion: 2 },
                { workspaceId: `ws-${randomUUID()}` },
            ] as Partial<SessionScopedClaims>[]) {
                expect(await resolve(over), JSON.stringify(over))
                    .toEqual({ ok: false, reason: 'claims-mismatch' });
            }
        });

        it('compares the claims the row does not carry against the projection', async () => {
            // tenant, project and runtime live only on the workspace row, so a
            // token could otherwise claim any of them freely.
            for (const over of [
                { tenantId: 'tenant-2' },
                { projectId: 'project-2' },
            ] as Partial<SessionScopedClaims>[]) {
                // These are part of the identity the family is derived from.
                expect(await resolve(over), JSON.stringify(over))
                    .toEqual({ ok: false, reason: 'claims-mismatch' });
            }
            // The runtime is a generation rather than an identity, so it is
            // refused by the projection comparison instead.
            expect(await resolve({ runtimeId: 'runtime-2' }))
                .toEqual({ ok: false, reason: 'authority-stale' });
        });

        it('goes stale when the workspace or the run advances', async () => {
            await projection.syncRunAuthority({
                body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-2', cancelled: false },
                expectedVersion: 1,
                now: NOW,
            });
            // Nobody walked the grant table to do this.
            expect(await resolve()).toEqual({ ok: false, reason: 'attempt-mismatch' });
        });

        it('refuses once the run is cancelled', async () => {
            await projection.syncRunAuthority({
                body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-1', cancelled: true },
                expectedVersion: 1,
                now: NOW,
            });
            expect(await resolve()).toEqual({ ok: false, reason: 'run-cancelled' });
        });

        it('refuses when the session no longer exists or changed owner', async () => {
            await db.session.update({ where: { id: sessionId }, data: { accountId: otherAccountId } });
            expect(await resolve()).toEqual({ ok: false, reason: 'session-owner-changed' });

            await db.session.delete({ where: { id: sessionId } });
            expect(await resolve()).toEqual({ ok: false, reason: 'session-unknown' });
        });

        it('refuses an unknown grant and a tombstone', async () => {
            expect(await resolve({ grantId: 'never-issued' }))
                .toEqual({ ok: false, reason: 'grant-unknown' });

            const otherAttempt = scope({ attemptId: 'attempt-2' });
            await grants.revokeSessionGrant({ scope: otherAttempt, reason: 'x', now: NOW });
            expect(await grants.resolveLiveGrant({
                claims: claimsFor({
                    grantId: `tombstone:${grants.deriveGrantFamily(otherAttempt)}`,
                    attemptId: 'attempt-2',
                }),
                now: NOW,
            })).toEqual({ ok: false, reason: 'grant-unknown' });
        });
    });
});
