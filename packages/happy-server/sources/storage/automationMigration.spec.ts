import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDir = join(process.cwd(), 'prisma/migrations/20260810173000_add_server_backed_automations');
const runNowMigrationDir = join(process.cwd(), 'prisma/migrations/20260818120000_add_automation_run_now_queue_depth');
const queueProgressMigrationDir = join(process.cwd(), 'prisma/migrations/20260818133000_add_automation_queue_progress');

function readSql(name: string): string {
    return readFileSync(join(migrationDir, name), 'utf8');
}

function readRunNowSql(name: string): string {
    return readFileSync(join(runNowMigrationDir, name), 'utf8');
}

function readQueueProgressSql(name: string): string {
    return readFileSync(join(queueProgressMigrationDir, name), 'utf8');
}

describe('server-backed automation migration', () => {
    it('creates the control-plane records and both execution uniqueness fences', () => {
        const sql = readSql('migration.sql');

        expect(sql).toContain('CREATE TABLE "Automation"');
        expect(sql).toContain('CREATE TABLE "AutomationChange"');
        expect(sql).toContain('CREATE TABLE "AutomationRun"');
        expect(sql).toContain('"AutomationRun_automationId_generation_scheduledFor_key"');
        expect(sql).toContain('"AutomationRun_one_active_run_per_automation"');
        expect(sql).toContain("WHERE \"status\" IN ('CLAIMED', 'RUNNING')");
        expect(sql).toContain('ON DELETE SET NULL ON UPDATE CASCADE');
    });

    it('applies and rolls back against PostgreSQL without removing prerequisite tables', async () => {
        const migration = readSql('migration.sql');
        const rollback = readSql('rollback.sql');

        expect(rollback.indexOf('DROP TABLE "AutomationRun"')).toBeLessThan(rollback.indexOf('DROP TABLE "Automation"'));
        expect(rollback.indexOf('DROP TABLE "AutomationChange"')).toBeLessThan(rollback.indexOf('DROP TABLE "Automation"'));

        const pg = new PGlite();
        try {
            await pg.exec(`
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Project" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL);
                CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");
            `);
            await pg.exec(migration);
            await pg.exec(rollback);

            const remaining = await pg.query<{ table_name: string }>(`
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' ORDER BY table_name
            `);
            expect(remaining.rows.map((row) => row.table_name)).toEqual(['Account', 'Machine', 'Project']);
            const columns = await pg.query<{ column_name: string }>(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name IN ('Machine', 'Project') AND column_name LIKE 'automation%'
            `);
            expect(columns.rows).toEqual([]);
        } finally {
            await pg.close();
        }
    });

    it('enforces one active run and one claim per scheduled generation in PostgreSQL', async () => {
        const pg = new PGlite();
        try {
            await pg.exec(`
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Project" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL);
                CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");
            `);
            await pg.exec(readSql('migration.sql'));
            await pg.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "Project" ("id") VALUES ('project-1');
                INSERT INTO "Machine" ("id", "accountId") VALUES ('machine-1', 'account-1');
                INSERT INTO "Automation" (
                    "id", "projectId", "ownerAccountId", "machineAccountId", "machineId",
                    "payloadCiphertext", "viewerKeyId", "viewerKeyVersion", "viewerKeyEnvelope",
                    "machineKeyVersion", "machineKeyEnvelope", "updatedAt"
                ) VALUES (
                    'automation-1', 'project-1', 'account-1', 'account-1', 'machine-1',
                    '\\x01', 'viewer-key', 1, '\\x02', 1, '\\x03', CURRENT_TIMESTAMP
                );
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "generation", "scheduledFor", "machineAccountId", "machineId",
                    "status", "claimTokenHash", "claimExpiresAt", "updatedAt"
                ) VALUES (
                    'run-1', 'automation-1', 1, '2026-08-10T08:00:00Z', 'account-1', 'machine-1',
                    'CLAIMED', '\\x11', '2026-08-10T08:02:00Z', CURRENT_TIMESTAMP
                );
            `);

            await expect(pg.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "generation", "scheduledFor", "machineAccountId", "machineId",
                    "status", "claimTokenHash", "claimExpiresAt", "updatedAt"
                ) VALUES (
                    'run-2', 'automation-1', 1, '2026-08-10T08:01:00Z', 'account-1', 'machine-1',
                    'RUNNING', '\\x12', '2026-08-10T08:03:00Z', CURRENT_TIMESTAMP
                );
            `)).rejects.toThrow(/AutomationRun_one_active_run_per_automation/);

            await pg.exec(`UPDATE "AutomationRun" SET "status" = 'COMPLETED' WHERE "id" = 'run-1'`);
            await expect(pg.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "generation", "scheduledFor", "machineAccountId", "machineId",
                    "status", "claimTokenHash", "claimExpiresAt", "updatedAt"
                ) VALUES (
                    'run-3', 'automation-1', 1, '2026-08-10T08:00:00Z', 'account-1', 'machine-1',
                    'CLAIMED', '\\x13', '2026-08-10T08:02:00Z', CURRENT_TIMESTAMP
                );
            `)).rejects.toThrow(/AutomationRun_automationId_generation_scheduledFor_key/);
        } finally {
            await pg.close();
        }
    });

    it('adds and rolls back run-now capability, durable requests, and GitHub queue progress', async () => {
        const pg = new PGlite();
        try {
            await pg.exec(`
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Project" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL);
                CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");
            `);
            await pg.exec(readSql('migration.sql'));
            await pg.exec(readRunNowSql('migration.sql'));
            await pg.exec(readQueueProgressSql('migration.sql'));
            const added = await pg.query<{ table_name: string; column_name: string }>(`
                SELECT table_name, column_name FROM information_schema.columns
                WHERE (table_name = 'Machine' AND column_name = 'automationProtocolVersion')
                   OR (table_name = 'Automation' AND column_name = 'runRequestedAt')
                   OR (table_name = 'AutomationRun' AND column_name = 'queueDepth')
                   OR (table_name = 'AutomationRun' AND column_name IN ('queuePosition', 'queueTotal', 'queueEstimatedAt'))
                ORDER BY table_name, column_name
            `);
            expect(added.rows).toEqual([
                { table_name: 'Automation', column_name: 'runRequestedAt' },
                { table_name: 'AutomationRun', column_name: 'queueDepth' },
                { table_name: 'AutomationRun', column_name: 'queueEstimatedAt' },
                { table_name: 'AutomationRun', column_name: 'queuePosition' },
                { table_name: 'AutomationRun', column_name: 'queueTotal' },
                { table_name: 'Machine', column_name: 'automationProtocolVersion' },
            ]);

            await pg.exec(readQueueProgressSql('rollback.sql'));
            await pg.exec(readRunNowSql('rollback.sql'));
            const remaining = await pg.query<{ column_name: string }>(`
                SELECT column_name FROM information_schema.columns
                WHERE column_name IN (
                    'automationProtocolVersion', 'runRequestedAt', 'queueDepth',
                    'queuePosition', 'queueTotal', 'queueEstimatedAt'
                )
            `);
            expect(remaining.rows).toEqual([]);
        } finally {
            await pg.close();
        }
    });
});
