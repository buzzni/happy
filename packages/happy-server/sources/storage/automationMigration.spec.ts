import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDir = join(process.cwd(), 'prisma/migrations/20260810173000_add_server_backed_automations');

function readSql(name: string): string {
    return readFileSync(join(migrationDir, name), 'utf8');
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
});
