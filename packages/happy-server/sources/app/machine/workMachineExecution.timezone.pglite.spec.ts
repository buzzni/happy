import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { withSessionPiiModeMigration } from '@/testing/pgliteSessionModeFixture';
import { permitWorkMachineExecution, redeemWorkMachineRenewal } from './workMachineExecution';

/*
 * Timestamp columns are `timestamp(3)` without a time zone and hold UTC, as
 * Prisma writes them. A database whose session time zone is not UTC (dev runs
 * Asia/Seoul) must not shift what raw SQL stores or compares.
 *
 * Production's query engine binds a raw-query Date as `timestamptz`; the
 * PGlite adapter binds it untyped, which would hide the shift. While
 * `rawDatesTyped` is on, Date parameters are bound as `timestamptz` the way
 * production binds them. Rows the fixtures write through Prisma stay untyped,
 * which stores UTC exactly as production's Prisma writes do.
 */
const TIMESTAMPTZ_OID = 1184;
const BOUND_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
let rawDatesTyped = false;

type Queryable = { query: (sql: string, params?: unknown[], options?: Record<string, unknown>) => Promise<unknown> };
function bindDatesLikeProduction<T extends Queryable>(client: T): T {
    return new Proxy(client, {
        get(target, prop) {
            if (prop === 'query') {
                return (sql: string, params: unknown[] = [], options: Record<string, unknown> = {}) => target.query(sql, params, rawDatesTyped ? {
                    ...options,
                    paramTypes: params.map(value => typeof value === 'string' && BOUND_DATE.test(value) ? TIMESTAMPTZ_OID : 0),
                } : options);
            }
            if (prop === 'transaction') {
                return (work: (tx: Queryable) => Promise<unknown>) => (target as unknown as {
                    transaction: (cb: (tx: Queryable) => Promise<unknown>) => Promise<unknown>;
                }).transaction(tx => work(bindDatesLikeProduction(tx)));
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

async function asProductionBindsRawDates<T>(work: () => Promise<T>): Promise<T> {
    rawDatesTyped = true;
    try { return await work(); } finally { rawDatesTyped = false; }
}

const accountId = 'tz-owner';
const machineId = 'tz-machine';
const grant = { accountId, machineId, deviceId: 'tz-device', generation: 1 };
let pg: PGlite;
let db: PrismaClient;

beforeAll(async () => {
    const require = createRequire(resolve('package.json'));
    const { stdout } = await promisify(execFile)(process.execPath, [
        require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty',
        '--to-schema-datamodel', 'prisma/schema.prisma', '--script',
    ], { env: { ...process.env, DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' } });
    pg = new PGlite();
    await pg.exec(await withSessionPiiModeMigration(stdout));
    await pg.exec(`SET TIME ZONE 'Asia/Seoul'`);
    db = new PrismaClient({ adapter: new PrismaPGlite(bindDatesLikeProduction(pg)) });
    await db.account.create({ data: { id: accountId, publicKey: accountId } });
    await db.machine.create({ data: { id: machineId, accountId, metadata: 'encrypted' } });
    await db.workMachineExecution.create({ data: { ...grant } });
}, 20_000);

beforeEach(async () => {
    await db.workMachineRenewalProof.deleteMany({});
    await db.workMachineExecution.update({ where: { machineId }, data: { firstExecutionAt: null } });
});

afterAll(async () => {
    await db?.$disconnect();
    await pg?.close();
});

describe('work machine execution timestamps under a non-UTC database session', () => {
    it('records the first execution at the permitted instant', async () => {
        const permittedAt = new Date('2026-11-22T00:00:00.000Z');

        expect(await asProductionBindsRawDates(() => permitWorkMachineExecution(db, grant, permittedAt))).toBe(true);

        const row = await db.workMachineExecution.findUniqueOrThrow({ where: { machineId } });
        expect(row.firstExecutionAt?.toISOString()).toBe(permittedAt.toISOString());
    });

    it('stores a renewal proof until its own expiry and refuses its replay', async () => {
        const proof = { nonce: 'renewal-1', expiresAt: new Date(Date.now() + 5 * 60_000) };

        expect(await asProductionBindsRawDates(() => redeemWorkMachineRenewal(db, grant, proof))).toBe(true);
        expect(await asProductionBindsRawDates(() => redeemWorkMachineRenewal(db, grant, proof))).toBe(false);

        const stored = await db.workMachineRenewalProof.findUniqueOrThrow({ where: { machineId_nonce: { machineId, nonce: proof.nonce } } });
        expect(stored.expiresAt.toISOString()).toBe(proof.expiresAt.toISOString());
    });

    it('keeps unexpired proofs and purges expired ones when another renewal is redeemed', async () => {
        const now = Date.now();
        await db.workMachineRenewalProof.createMany({
            data: [
                { machineId, nonce: 'still-valid', expiresAt: new Date(now + 5 * 60_000) },
                { machineId, nonce: 'expired', expiresAt: new Date(now - 60_000) },
            ],
        });

        expect(await asProductionBindsRawDates(() => redeemWorkMachineRenewal(db, grant, {
            nonce: 'renewal-2', expiresAt: new Date(now + 5 * 60_000),
        }))).toBe(true);

        const nonces = (await db.workMachineRenewalProof.findMany({ where: { machineId } })).map(row => row.nonce).sort();
        expect(nonces).toEqual(['renewal-2', 'still-valid']);
    });

    it('refuses a renewal proof that has already expired', async () => {
        expect(await asProductionBindsRawDates(() => redeemWorkMachineRenewal(db, grant, {
            nonce: 'late', expiresAt: new Date(Date.now() - 1_000),
        }))).toBe(false);
    });
});
