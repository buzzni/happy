import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { claimAutomationRun, recordMissedAutomationRuns } from './automationExecutionService';

// aplus-dev-studio specs/scheduled-missed-run-policy R5 — the real slot fence, not a mock, absorbs a
// re-reported gap; the additive migration runs on a table that already holds run history.

let schema: string, migration: string, pg: PGlite, client: PrismaClient;
const now = new Date('2026-11-07T09:00:00.000Z');
const firstMissedAt = new Date('2026-11-07T01:00:00.000Z');

beforeAll(async () => {
    const require = createRequire(resolve('package.json'));
    schema = (await promisify(execFile)(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
        { env: { ...process.env, XDG_CACHE_HOME: '/tmp/happy-missed-run-prisma-cache', DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused' }, maxBuffer: 1024 * 1024 })).stdout;
    migration = await readFile('prisma/migrations/20261107000000_add_automation_run_missed_count/migration.sql', 'utf8');
}, 60_000);

beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(schema);
    await pg.exec('ALTER TABLE "AutomationRun" DROP COLUMN "missedCount";');
    // Adapter 0.7.2 returns Uint8Array bytea cells; Prisma's bridge expects JSON arrays.
    const adapter = new PrismaPGlite(pg), connect = adapter.connect.bind(adapter);
    adapter.connect = async () => {
        const driver = await connect();
        const normalize = (queryable: any) => {
            const queryRaw = queryable.queryRaw.bind(queryable);
            queryable.queryRaw = async (...args: unknown[]) => {
                const result = await queryRaw(...args);
                result.rows = result.rows.map((row: unknown[]) => row.map(cell => cell instanceof Uint8Array ? Array.from(cell) : cell));
                return result;
            };
            if (queryable.startTransaction) {
                const start = queryable.startTransaction.bind(queryable);
                queryable.startTransaction = async (...args: unknown[]) => normalize(await start(...args));
            }
            return queryable;
        };
        return normalize(driver);
    };
    client = new PrismaClient({ adapter });
    await client.account.create({ data: { id: 'account-1', publicKey: 'account-1' } });
    await client.machine.create({ data: { id: 'machine-1', accountId: 'account-1', metadata: 'machine', automationKeyVersion: 4 } });
    await client.project.create({ data: { id: 'project-1', accountId: 'account-1', name: 'project', automationViewerKeyVersion: 5 } as never });
    await client.automation.create({ data: {
        id: 'automation-1', projectId: 'project-1', ownerAccountId: 'account-1', machineAccountId: 'account-1', machineId: 'machine-1',
        generation: 3, payloadCiphertext: new Uint8Array([1]), viewerKeyId: 'viewer', viewerKeyVersion: 5,
        viewerKeyEnvelope: new Uint8Array([2]), machineKeyVersion: 4, machineKeyEnvelope: new Uint8Array([3]),
        enabledAt: new Date(0),
    } });
    // History written before the column existed must survive the migration as ordinary rows.
    await pg.exec(`INSERT INTO "AutomationRun" ("id", "automationId", "generation", "scheduledFor", "machineAccountId", "machineId", "status", "claimTokenHash", "claimExpiresAt", "updatedAt")
        VALUES ('run-before', 'automation-1', 3, '2026-11-06T09:00:00Z', 'account-1', 'machine-1', 'EXPIRED', '\\x01', '2026-11-06T09:02:00Z', now());`);
    await pg.exec(migration);
});

afterEach(async () => {
    await client.$disconnect();
    await pg.close();
});

const gap = (missedCount: number) => ({
    automationId: 'automation-1', generation: 3, firstMissedAt, missedCount, failureCode: 'MISSED_OFFLINE' as const,
});

it('keeps old history as ordinary rows and records a re-reported gap only once', async () => {
    const first = await client.$transaction((tx) => recordMissedAutomationRuns(tx, 'account-1', 'machine-1', gap(8), now));
    expect(first).toMatchObject({ ok: true, value: { idempotent: false } });
    const replay = await client.$transaction((tx) => recordMissedAutomationRuns(tx, 'account-1', 'machine-1', gap(8), now));
    expect(replay).toEqual({ ok: true, value: { runId: (first as any).value.runId, idempotent: true, projectId: 'project-1' } });
    const longer = await client.$transaction((tx) => recordMissedAutomationRuns(tx, 'account-1', 'machine-1', gap(11), now));
    expect(longer).toMatchObject({ ok: true, value: { idempotent: true } });

    const runs = await client.automationRun.findMany({ orderBy: { scheduledFor: 'asc' }, select: { id: true, status: true, failureCode: true, missedCount: true, scheduledFor: true, startedAt: true, sessionId: true } });
    expect(runs).toEqual([
        { id: 'run-before', status: 'EXPIRED', failureCode: null, missedCount: null, scheduledFor: new Date('2026-11-06T09:00:00Z'), startedAt: null, sessionId: null },
        { id: (first as any).value.runId, status: 'EXPIRED', failureCode: 'MISSED_OFFLINE', missedCount: 11, scheduledFor: firstMissedAt, startedAt: null, sessionId: null },
    ]);
});

it('does not hold the one-active-run fence, so the next slot can still be claimed', async () => {
    await client.$transaction((tx) => recordMissedAutomationRuns(tx, 'account-1', 'machine-1', gap(3), now));
    const claim = await client.$transaction((tx) => claimAutomationRun(tx, 'account-1', 'machine-1', {
        automationId: 'automation-1', generation: 3, scheduledFor: now,
    }, now));
    expect(claim).toMatchObject({ ok: true });
});
