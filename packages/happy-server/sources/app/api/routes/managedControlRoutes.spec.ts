import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';

import type { PrismaClient } from '@prisma/client';

/**
 * The control routes against a real Fastify instance and the real database.
 *
 * A refusal has to be provably inert, so every denial case counts the managed
 * rows before and after: an endpoint that rejects the caller but has already
 * written is not a refusal.
 *
 * Opt-in on `HAPPY_MANAGED_TEST_DATABASE_URL`, like the other real-database
 * suites.
 */

const TEST_DATABASE_URL = process.env.HAPPY_MANAGED_TEST_DATABASE_URL;
const enabled = Boolean(TEST_DATABASE_URL);

const priorEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_PROVIDER: process.env.DB_PROVIDER,
    HANDY_MASTER_SECRET: process.env.HANDY_MASTER_SECRET,
};
if (TEST_DATABASE_URL) {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.DB_PROVIDER = 'postgres';
    process.env.HANDY_MASTER_SECRET = 'test-master-secret-not-a-production-key';
}
function restoreEnv(): void {
    for (const [key, value] of Object.entries(priorEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

const EVERY_ROUTE = [
    ['/v1/managed/control/authority/workspace', 'authority-sync'],
    ['/v1/managed/control/authority/run', 'authority-sync'],
    ['/v1/managed/control/grants/mint', 'grant-mint'],
    ['/v1/managed/control/grants/renew', 'grant-renew'],
    ['/v1/managed/control/grants/revoke', 'grant-revoke'],
    ['/v1/managed/control/authority/snapshot', 'authority-snapshot'],
    ['/v1/managed/control/grants/resolve', 'grant-resolve'],
] as const;

const AUDIENCE = 'https://happy.control.test';
const HOUR = 3_600_000;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const CONTROL_KEY_B64 = Buffer
    .from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))
    .toString('base64');

const CONTROL_ENV = {
    HAPPY_MANAGED_CONTROL_VERIFIER_KEYS: JSON.stringify({ 'control-1': CONTROL_KEY_B64 }),
    HAPPY_MANAGED_CONTROL_AUDIENCE: AUDIENCE,
    HAPPY_MANAGED_SCOPED_TOKEN_SEED: 'test-scoped-seed-not-a-production-key',
    HAPPY_MANAGED_PUBLIC_URL: 'https://happy.control.test',
};

let db: PrismaClient;
let modules: {
    routes: typeof import('@/app/api/routes/managedControlRoutes');
    runtime: typeof import('@/app/managed/managedControlRuntime');
    assertion: typeof import('@/app/managed/managedControlAssertion');
    digest: typeof import('@/app/managed/canonicalDigest');
    auth: typeof import('@/app/auth/auth');
    grants: typeof import('@/app/managed/managedSessionGrant');
    projection: typeof import('@/app/managed/managedAuthorityProjection');
};

const createdWorkspaceIds = new Set<string>();
const createdRunIds = new Set<string>();
const createdSessionIds = new Set<string>();
const createdAccountIds = new Set<string>();

let app: FastifyInstance;
let unconfiguredApp: FastifyInstance;
let accountId: string;
let otherAccountId: string;
let accountToken: string;
let otherToken: string;
let workspaceId: string;
let runId: string;
let sessionId: string;

function scope(over: Record<string, unknown> = {}) {
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

function assertionFor(op: string, body: unknown, over: Record<string, unknown> = {}): string {
    const now = Date.now();
    const payload = {
        kid: 'control-1',
        aud: AUDIENCE,
        purpose: modules.assertion.CONTROL_ASSERTION_PURPOSE,
        op,
        bodyDigest: modules.digest.canonicalDigest(body),
        iat: now,
        exp: now + 60_000,
        ...over,
    };
    const bytes = modules.assertion.encodeControlAssertionPayload(payload as never);
    return modules.assertion.encodeControlAssertion(bytes, signBytes(null, bytes, privateKey));
}

async function call(input: {
    path: string;
    op: string;
    body: unknown;
    token?: string;
    assertion?: string | null;
    instance?: FastifyInstance;
}) {
    const headers: Record<string, string> = {
        authorization: `Bearer ${input.token ?? accountToken}`,
        'content-type': 'application/json',
    };
    const assertion = input.assertion === undefined
        ? assertionFor(input.op, input.body)
        : input.assertion;
    if (assertion !== null) headers[modules.routes.CONTROL_ASSERTION_HEADER] = assertion;
    return (input.instance ?? app).inject({
        method: 'POST', url: input.path, headers, payload: JSON.stringify(input.body),
    });
}

/**
 * Every managed row this file created, in full and in a stable order.
 *
 * Counts are not enough: a handler that updates a row and only then refuses
 * leaves the count identical while having already changed the authority — which
 * is exactly the shape of bug these assertions exist to catch. The scope is the
 * fixtures' own ids, so nothing here reads or compares rows belonging to anyone
 * else.
 */
async function managedRowSnapshot() {
    const [workspaces, runs, grants] = await Promise.all([
        db.managedWorkspaceAuthority.findMany({
            where: { workspaceId: { in: [...createdWorkspaceIds] } },
            orderBy: { workspaceId: 'asc' },
        }),
        db.managedRunAuthority.findMany({
            where: { runId: { in: [...createdRunIds] } },
            orderBy: { runId: 'asc' },
        }),
        db.managedSessionGrant.findMany({
            where: { runId: { in: [...createdRunIds] } },
            orderBy: { grantId: 'asc' },
        }),
    ]);
    return { workspaces, runs, grants };
}

async function expectInert<T extends { statusCode: number }>(run: () => Promise<T>, status: number): Promise<T> {
    const before = await managedRowSnapshot();
    const response = await run();
    expect(response.statusCode).toBe(status);
    // Every column, not just the row count.
    expect(await managedRowSnapshot()).toEqual(before);
    return response;
}

async function buildApp(getRuntime: () => unknown): Promise<FastifyInstance> {
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    const typed = instance.withTypeProvider<ZodTypeProvider>();
    // The real decorator, not a stand-in: refusing a scoped bearer is one of
    // the properties under test.
    (await import('@/app/api/utils/enableAuthentication')).enableAuthentication(typed as never);
    modules.routes.managedControlRoutes(typed as never, getRuntime as never);
    await instance.ready();
    return instance;
}

describe.skipIf(!enabled)('managed control routes (real Fastify + PostgreSQL)', () => {
    beforeAll(async () => {
        modules = {
            routes: await import('@/app/api/routes/managedControlRoutes'),
            runtime: await import('@/app/managed/managedControlRuntime'),
            assertion: await import('@/app/managed/managedControlAssertion'),
            digest: await import('@/app/managed/canonicalDigest'),
            auth: await import('@/app/auth/auth'),
            grants: await import('@/app/managed/managedSessionGrant'),
            projection: await import('@/app/managed/managedAuthorityProjection'),
        };
        db = (await import('@/storage/db')).db as unknown as PrismaClient;
        await modules.auth.auth.init();

        const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
        app = await buildApp(() => runtime);
        unconfiguredApp = await buildApp(() => null);
    });

    beforeEach(async () => {
        workspaceId = `ws-${randomUUID()}`;
        runId = `run-${randomUUID()}`;
        createdWorkspaceIds.add(workspaceId);
        createdRunIds.add(runId);

        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const other = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        accountId = account.id;
        otherAccountId = other.id;
        createdAccountIds.add(accountId);
        createdAccountIds.add(otherAccountId);
        accountToken = await modules.auth.auth.createToken(accountId);
        otherToken = await modules.auth.auth.createToken(otherAccountId);

        const session = await db.session.create({
            data: { accountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
        });
        sessionId = session.id;
        createdSessionIds.add(sessionId);
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
        expect(await managedRowSnapshot()).toEqual({ workspaces: [], runs: [], grants: [] });
        await app?.close();
        await unconfiguredApp?.close();
        await db.$disconnect();
        restoreEnv();
    });

    async function syncAuthority() {
        const workspaceBody = {
            ownerAccountId: accountId,
            expectedVersion: 0,
            body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 1, runtimeId: 'runtime-1' },
        };
        expect((await call({
            path: '/v1/managed/control/authority/workspace', op: 'authority-sync', body: workspaceBody,
        })).statusCode).toBe(200);

        const runBody = {
            expectedVersion: 0,
            body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-1', cancelled: false },
        };
        expect((await call({
            path: '/v1/managed/control/authority/run', op: 'authority-sync', body: runBody,
        })).statusCode).toBe(200);
    }

    function mintBody(over: Record<string, unknown> = {}) {
        return {
            scope: scope(),
            grantId: `grant-${randomUUID()}`,
            requestId: `req-${randomUUID()}`,
            expiresAt: Date.now() + HOUR,
            ...over,
        };
    }

    describe('the vertical path', () => {
        it('syncs authority, mints a grant, renews it and revokes it', async () => {
            await syncAuthority();

            const body = mintBody();
            const minted = await call({ path: '/v1/managed/control/grants/mint', op: 'grant-mint', body });
            expect(minted.statusCode).toBe(200);
            const issued = minted.json();
            expect(issued).toMatchObject({ renewalSeq: 0, serverUrl: 'https://happy.control.test' });

            // The token verifies as a managed principal and never as an account.
            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const verified = await runtime!.scopedTokens.verify(issued.token, Date.now());
            expect(verified).toMatchObject({ ok: true });
            if (verified.ok) {
                expect(verified.claims).toMatchObject({ grantId: issued.grantId, sessionId, accountId });
                expect(await modules.grants.resolveLiveGrant({ claims: verified.claims, now: Date.now() }))
                    .toMatchObject({ ok: true });
            }
            await expect(modules.auth.auth.verifyToken(issued.token)).resolves.toBeNull();

            const renewBody = {
                scope: scope(), expectedRenewalSeq: 0, expiresAt: Date.now() + 2 * HOUR,
            };
            const renewed = await call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew', body: renewBody,
            });
            expect(renewed.statusCode).toBe(200);
            expect(renewed.json()).toMatchObject({ renewalSeq: 1 });

            const revoked = await call({
                path: '/v1/managed/control/grants/revoke', op: 'grant-revoke',
                body: { scope: scope(), reason: 'operator' },
            });
            expect(revoked.statusCode).toBe(200);
            expect(revoked.json()).toMatchObject({ state: 'revoked', alreadyRevoked: false });

            // The token stops resolving the moment the grant is revoked.
            if (verified.ok) {
                expect(await modules.grants.resolveLiveGrant({ claims: verified.claims, now: Date.now() }))
                    .toEqual({ ok: false, reason: 'revoked' });
            }
        });
    });

    function snapshotBody(over: Record<string, unknown> = {}) {
        return {
            requestId: `req-${randomUUID()}`,
            tenantId: 'tenant-1',
            projectId: 'project-1',
            workspaceId,
            runId,
            accountId,
            ...over,
        };
    }

    function resolveBody(over: Record<string, unknown> = {}) {
        return {
            requestId: `req-${randomUUID()}`,
            scope: scope(),
            requestedTokenExpiresAt: Date.now() + HOUR,
            ...over,
        };
    }

    describe('authority snapshot', () => {
        it('returns both projections from one read, and null before they exist', async () => {
            const empty = await call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody(),
            });
            expect(empty.statusCode).toBe(200);
            expect(empty.json()).toMatchObject({ workspace: null, run: null });

            await syncAuthority();
            const body = snapshotBody();
            const filled = await call({
                path: '/v1/managed/control/authority/snapshot', op: 'authority-snapshot', body,
            });
            expect(filled.statusCode).toBe(200);
            expect(filled.json()).toEqual({
                requestId: body.requestId,
                workspace: {
                    workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                    epoch: 1, runtimeId: 'runtime-1', version: 1,
                },
                run: {
                    runId, workspaceId, accountId,
                    currentAttemptId: 'attempt-1', cancelled: false, version: 1,
                },
            });
        });

        it('reports a workspace that exists before its run', async () => {
            const workspaceBody = {
                ownerAccountId: accountId, expectedVersion: 0,
                body: {
                    workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                    epoch: 1, runtimeId: 'runtime-1',
                },
            };
            expect((await call({
                path: '/v1/managed/control/authority/workspace',
                op: 'authority-sync', body: workspaceBody,
            })).statusCode).toBe(200);

            const filled = await call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody(),
            });
            expect(filled.statusCode).toBe(200);
            expect(filled.json().workspace).toMatchObject({ workspaceId, epoch: 1 });
            expect(filled.json().run).toBeNull();
        });

        it.each([
            ['tenantId', { tenantId: 'tenant-other' }],
            ['projectId', { projectId: 'project-other' }],
        ])('refuses a %s that does not match the stored workspace', async (_label, over) => {
            await syncAuthority();
            await expectInert(() => call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody(over),
            }), 403);
        });

        it('refuses a run that belongs to another workspace or account', async () => {
            await syncAuthority();
            const otherWorkspaceId = `ws-${randomUUID()}`;
            createdWorkspaceIds.add(otherWorkspaceId);
            await expectInert(() => call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody({ workspaceId: otherWorkspaceId }),
            }), 403);
            await expectInert(() => call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody({ accountId: otherAccountId }),
            }), 403);
        });

        it('refuses when the bearer does not own the scope', async () => {
            await syncAuthority();
            await expectInert(() => call({
                path: '/v1/managed/control/authority/snapshot',
                op: 'authority-snapshot', body: snapshotBody(), token: otherToken,
            }), 403);
        });
    });

    describe('authority snapshot coherency', () => {
        it('reads a committed pair after every interleaved write', async () => {
            await syncAuthority();

            // Writes and reads alternate deterministically: after each commit the
            // snapshot must show exactly that state. A read that took the two
            // projections from different moments would show the pair the writes
            // never had — a run at attempt N+1 beside a workspace at epoch N.
            let workspaceVersion = 1;
            let runVersion = 1;
            let epoch = 1;
            let attempt = 1;

            async function expectSnapshot() {
                const response = await call({
                    path: '/v1/managed/control/authority/snapshot',
                    op: 'authority-snapshot', body: snapshotBody(),
                });
                expect(response.statusCode).toBe(200);
                expect(response.json()).toMatchObject({
                    workspace: { version: workspaceVersion, epoch },
                    run: { version: runVersion, currentAttemptId: `attempt-${attempt}` },
                });
            }

            await expectSnapshot();
            for (let step = 0; step < 4; step += 1) {
                epoch += 1;
                expect((await call({
                    path: '/v1/managed/control/authority/workspace', op: 'authority-sync',
                    body: {
                        ownerAccountId: accountId, expectedVersion: workspaceVersion,
                        body: {
                            workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                            epoch, runtimeId: 'runtime-1',
                        },
                    },
                })).statusCode).toBe(200);
                workspaceVersion += 1;
                // Read between the two writes: the run must still be the old one.
                await expectSnapshot();

                attempt += 1;
                expect((await call({
                    path: '/v1/managed/control/authority/run', op: 'authority-sync',
                    body: {
                        expectedVersion: runVersion,
                        body: {
                            runId, workspaceId, accountId,
                            currentAttemptId: `attempt-${attempt}`, cancelled: false,
                        },
                    },
                })).statusCode).toBe(200);
                runVersion += 1;
                await expectSnapshot();
            }
        });
    });

    describe('grant resolve', () => {
        beforeEach(syncAuthority);

        it('recovers a live grant after a lost mint response without changing it', async () => {
            const minted = await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            });
            expect(minted.statusCode).toBe(200);
            const issued = minted.json();

            const before = await managedRowSnapshot();
            const body = resolveBody();
            const resolved = await call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body,
            });
            expect(resolved.statusCode).toBe(200);
            const payload = resolved.json();
            expect(payload).toMatchObject({
                requestId: body.requestId,
                scope: scope(),
                grantId: issued.grantId,
                grantExpiresAt: issued.expiresAt,
                renewalSeq: 0,
            });
            expect(payload.tokenExpiresAt).toBe(Math.min(issued.expiresAt, body.requestedTokenExpiresAt));
            // A read that issues a credential still must not write.
            expect(await managedRowSnapshot()).toEqual(before);

            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const verified = await runtime!.scopedTokens.verify(payload.token, Date.now());
            expect(verified).toMatchObject({ ok: true });
            if (verified.ok) {
                expect(verified.claims).toMatchObject({
                    grantId: issued.grantId, sessionId, accountId, runId,
                });
                expect(await modules.grants.resolveLiveGrant({ claims: verified.claims, now: Date.now() }))
                    .toMatchObject({ ok: true });
            }
            // Never an account principal.
            await expect(modules.auth.auth.verifyToken(payload.token)).resolves.toBeNull();
        });

        it('re-evaluates the current grant under the signed cap, not the first answer', async () => {
            const base = Date.now();
            const mint = mintBody({ expiresAt: base + 500 });
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mint,
            })).statusCode).toBe(200);

            const renew = { scope: scope(), expectedRenewalSeq: 0, expiresAt: base + 1_500 };
            expect((await call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew', body: renew,
            })).statusCode).toBe(200);

            const body = resolveBody({ requestedTokenExpiresAt: base + 1_000 });
            const resolved = await call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body,
            });
            expect(resolved.statusCode).toBe(200);
            // Capped by the signed request, not the first response (500) and
            // never the renewed value (1500).
            expect(resolved.json()).toMatchObject({
                tokenExpiresAt: base + 1_000, grantExpiresAt: base + 1_500, renewalSeq: 1,
            });
        });

        it('does not create, resurrect or extend anything', async () => {
            // No grant at all.
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body: resolveBody(),
            }), 404);

            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ expiresAt: Date.now() + HOUR }),
            })).statusCode).toBe(200);

            // Revoked.
            expect((await call({
                path: '/v1/managed/control/grants/revoke', op: 'grant-revoke',
                body: { scope: scope(), reason: 'operator' },
            })).statusCode).toBe(200);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body: resolveBody(),
            }), 403);
        });

        it('refuses an expired grant even when the request asks for later', async () => {
            const past = Date.now() + 40;
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ expiresAt: past }),
            })).statusCode).toBe(200);
            await new Promise((resolve) => setTimeout(resolve, 60));
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody({ requestedTokenExpiresAt: Date.now() + HOUR }),
            }), 403);
        });

        it('refuses a requested expiry that is already in the past', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody({ requestedTokenExpiresAt: Date.now() - 1_000 }),
            }), 403);
        });

        it.each([
            ['epoch', { epoch: 2 }],
            ['runtimeId', { runtimeId: 'runtime-2' }],
            ['attemptId', { attemptId: 'attempt-2' }],
            ['workspaceAuthorityVersion', { workspaceAuthorityVersion: 2 }],
            ['runAuthorityVersion', { runAuthorityVersion: 2 }],
            ['tenantId', { tenantId: 'tenant-other' }],
            ['projectId', { projectId: 'project-other' }],
        ])('refuses a stale or wrong %s', async (_label, over) => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody({ scope: scope(over) }),
            }), 403);
        });

        it('refuses when the bearer does not own the scope', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody(), token: otherToken,
            }), 403);
        });

        it('refuses a stored grant left behind by an authority advance', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);

            // The workspace moves on; the caller signs the new generation.
            expect((await call({
                path: '/v1/managed/control/authority/workspace', op: 'authority-sync',
                body: {
                    ownerAccountId: accountId, expectedVersion: 1,
                    body: {
                        workspaceId, tenantId: 'tenant-1', projectId: 'project-1',
                        epoch: 2, runtimeId: 'runtime-1',
                    },
                },
            })).statusCode).toBe(200);

            const fresh = scope({ epoch: 2, workspaceAuthorityVersion: 2 });
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve',
                body: resolveBody({ scope: fresh }),
            }), 403);
        });

        it('issues a token whose claims are exactly the scope it answered with', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            const resolved = await call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body: resolveBody(),
            });
            expect(resolved.statusCode).toBe(200);
            const payload = resolved.json();

            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const verified = await runtime!.scopedTokens.verify(payload.token, Date.now());
            expect(verified).toMatchObject({ ok: true });
            if (verified.ok) {
                // Every one of the eleven axes, plus the expiry the DTO reports.
                const claims = verified.claims as unknown as Record<string, unknown>;
                const answered = payload.scope as Record<string, unknown>;
                expect(Object.keys(answered)).toHaveLength(11);
                for (const key of Object.keys(answered)) {
                    expect(claims[key], key).toEqual(answered[key]);
                }
                expect(verified.claims.grantId).toBe(payload.grantId);
                expect(verified.claims.expiresAt).toBe(payload.tokenExpiresAt);
            }
        });

        it.each([
            ['past the safe integer range', Number.MAX_SAFE_INTEGER + 1],
            ['zero', 0],
            ['negative', -1],
            ['fractional', 1.5],
        ])('refuses a requested expiry %s', async (_label, requested) => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            const body = resolveBody({ requestedTokenExpiresAt: requested });
            const before = await managedRowSnapshot();
            const response = await call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body,
            });
            expect(response.statusCode).not.toBe(200);
            expect(await managedRowSnapshot()).toEqual(before);
        });

        it('refuses an assertion signed for another operation', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            const body = resolveBody();
            await expectInert(() => call({
                path: '/v1/managed/control/grants/resolve', op: 'grant-resolve', body,
                assertion: assertionFor('grant-mint', body),
            }), 403);
        });
    });

    describe('a replayed mint cannot inherit a renewal', () => {
        beforeEach(syncAuthority);

        it('caps the replayed token and response at the originally signed expiry', async () => {
            const signedExpiry = Date.now() + 60_000;
            const body = mintBody({ expiresAt: signedExpiry });
            const assertion = assertionFor('grant-mint', body);

            const first = await call({ path: '/v1/managed/control/grants/mint', op: 'grant-mint', body, assertion });
            expect(first.statusCode).toBe(200);

            const renewedExpiry = Date.now() + 300_000;
            const renewed = await call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew',
                body: { scope: scope(), expectedRenewalSeq: 0, expiresAt: renewedExpiry },
            });
            expect(renewed.statusCode).toBe(200);
            expect(renewed.json().expiresAt).toBe(renewedExpiry);

            // The same body and the same assertion, replayed. It authorised
            // sixty seconds and must not come back carrying five minutes.
            const replay = await call({ path: '/v1/managed/control/grants/mint', op: 'grant-mint', body, assertion });
            expect(replay.statusCode).toBe(200);
            expect(replay.json()).toMatchObject({ idempotent: true, expiresAt: signedExpiry });

            const runtime = await modules.runtime.createManagedControlRuntime(CONTROL_ENV);
            const verified = await runtime!.scopedTokens.verify(replay.json().token, Date.now());
            expect(verified).toMatchObject({ ok: true });
            if (verified.ok) {
                expect(verified.claims.expiresAt).toBe(signedExpiry);
                // And it stops working at that expiry, not at the renewed one.
                expect(await modules.grants.resolveLiveGrant({ claims: verified.claims, now: signedExpiry }))
                    .toEqual({ ok: false, reason: 'expired' });
            }
            // The grant itself keeps the renewal.
            const row = await db.managedSessionGrant.findFirstOrThrow({ where: { runId } });
            expect(Number(row.expiresAt)).toBe(renewedExpiry);
        });
    });

    describe('both proofs are required', () => {
        beforeEach(syncAuthority);

        it('refuses with no bearer at all', async () => {
            await expectInert(() => app.inject({
                method: 'POST', url: '/v1/managed/control/grants/mint',
                headers: { 'content-type': 'application/json' },
                payload: JSON.stringify(mintBody()),
            }), 401);
        });

        it('refuses a valid bearer with no assertion', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody(), assertion: null,
            }), 403);
        });

        it('refuses an assertion signed by a key this server does not verify', async () => {
            const stranger = generateKeyPairSync('ed25519').privateKey;
            const body = mintBody();
            const payload = {
                kid: 'control-1', aud: AUDIENCE,
                purpose: modules.assertion.CONTROL_ASSERTION_PURPOSE, op: 'grant-mint',
                bodyDigest: modules.digest.canonicalDigest(body),
                iat: Date.now(), exp: Date.now() + 60_000,
            };
            const bytes = modules.assertion.encodeControlAssertionPayload(payload as never);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body,
                assertion: modules.assertion.encodeControlAssertion(bytes, signBytes(null, bytes, stranger)),
            }), 403);
        });

        it('refuses an assertion for another operation', async () => {
            const body = mintBody();
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body,
                assertion: assertionFor('grant-revoke', body),
            }), 403);
        });

        it('refuses when the body changed after the assertion was signed', async () => {
            const signed = mintBody();
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: { ...signed, expiresAt: signed.expiresAt + 1 },
                assertion: assertionFor('grant-mint', signed),
            }), 403);
        });

        it('refuses an expired assertion', async () => {
            const body = mintBody();
            const stale = Date.now() - 10 * 60_000;
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body,
                assertion: assertionFor('grant-mint', body, { iat: stale, exp: stale + 60_000 }),
            }), 403);
        });

        it('refuses every route when managed control is not configured', async () => {
            for (const [path, op] of EVERY_ROUTE) {
                // Unconfigured must not degrade to the account bearer alone,
                // and must refuse before the body shape is even considered.
                await expectInert(() => call({
                    path, op, body: mintBody(), instance: unconfiguredApp,
                }), 503);
            }
        });
    });

    describe('the bearer must own the scope', () => {
        beforeEach(syncAuthority);

        it('refuses to mint for an account the bearer is not', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody(), token: otherToken,
            }), 403);
        });

        it('refuses to renew or revoke another account*s grant', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);

            // Refused and untouched: no renewal, no revocation, no timestamp.
            await expectInert(() => call({
                path: '/v1/managed/control/grants/renew', op: 'grant-renew',
                body: { scope: scope(), expectedRenewalSeq: 0, expiresAt: Date.now() + 2 * HOUR },
                token: otherToken,
            }), 403);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/revoke', op: 'grant-revoke',
                body: { scope: scope(), reason: 'x' }, token: otherToken,
            }), 403);
        });

        it('refuses to sync a run for another account', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/authority/run', op: 'authority-sync',
                body: {
                    expectedVersion: 1,
                    body: { runId, workspaceId, accountId: otherAccountId, currentAttemptId: 'attempt-2', cancelled: false },
                },
            }), 403);
        });
    });

    describe('a scoped bearer cannot reach the control plane', () => {
        beforeEach(syncAuthority);

        it('is rejected as unauthenticated on every control route', async () => {
            const minted = await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            });
            expect(minted.statusCode).toBe(200);
            const scopedToken = minted.json().token as string;

            for (const [path, op] of EVERY_ROUTE) {
                // The account verifier refuses it, so the request never reaches
                // a handler that could act on it.
                await expectInert(() => call({ path, op, body: mintBody(), token: scopedToken }), 401);
            }
        });
    });

    describe('rejected requests write nothing', () => {
        beforeEach(syncAuthority);

        it('refuses a mint whose scope is no longer current', async () => {
            expect((await call({
                path: '/v1/managed/control/authority/run', op: 'authority-sync',
                body: {
                    expectedVersion: 1,
                    body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-2', cancelled: false },
                },
            })).statusCode).toBe(200);

            const response = await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            }), 403);
            expect(response.json()).toMatchObject({ error: 'attempt-mismatch' });
        });

        it('refuses a mint for a session the bearer does not own', async () => {
            const foreign = await db.session.create({
                data: { accountId: otherAccountId, tag: `tag-${randomUUID()}`, metadata: '{}' },
            });
            createdSessionIds.add(foreign.id);
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: mintBody({ scope: scope({ sessionId: foreign.id }) }),
            }), 403);
        });

        it('reports a stale expected version as a conflict without writing', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/authority/run', op: 'authority-sync',
                body: {
                    expectedVersion: 7,
                    body: { runId, workspaceId, accountId, currentAttemptId: 'attempt-9', cancelled: false },
                },
            }), 409);
        });

        it('refuses a workspace sync for a bearer that is not its stated owner', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/authority/workspace', op: 'authority-sync',
                body: {
                    ownerAccountId: otherAccountId,
                    expectedVersion: 1,
                    body: { workspaceId, tenantId: 'tenant-1', projectId: 'project-1', epoch: 2, runtimeId: 'runtime-2' },
                },
            }), 403);
        });

        it('refuses a revoke whose scope no longer matches and leaves the grant live', async () => {
            expect((await call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint', body: mintBody(),
            })).statusCode).toBe(200);
            // A different attempt derives a different family, so this revoke
            // must not touch the grant that exists — and must not tombstone
            // over it either.
            await expectInert(() => call({
                path: '/v1/managed/control/grants/revoke', op: 'grant-revoke',
                body: { scope: scope({ accountId: otherAccountId }), reason: 'x' },
            }), 403);
        });

        it('rejects an unknown field rather than ignoring it', async () => {
            await expectInert(() => call({
                path: '/v1/managed/control/grants/mint', op: 'grant-mint',
                body: { ...mintBody(), somethingElse: true },
            }), 400);
        });
    });
});
