import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = join(process.cwd(), 'prisma/migrations');
const read = (dir: string, file: string) => readFileSync(join(migrations, dir, file), 'utf8');

describe('automation adoption state migration', () => {
    it('adds recoverable staging state and rolls it back without dropping automations', async () => {
        const pg = new PGlite();
        try {
            await pg.exec(`
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Project" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL);
                CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");
            `);
            await pg.exec(read('20260810173000_add_server_backed_automations', 'migration.sql'));
            await pg.exec(read('20260810193000_add_automation_adoption_state', 'migration.sql'));
            const columns = await pg.query<{ column_name: string }>(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'Automation' AND column_name LIKE 'legacy%'
                ORDER BY column_name
            `);
            expect(columns.rows.map((row) => row.column_name)).toEqual([
                'legacyAutomationId', 'legacyDesiredPaused', 'legacyMachineId', 'legacyMigrationPending',
            ]);

            await pg.exec(read('20260810193000_add_automation_adoption_state', 'rollback.sql'));
            const remaining = await pg.query<{ table_name: string }>(`
                SELECT table_name FROM information_schema.tables WHERE table_name = 'Automation'
            `);
            expect(remaining.rows).toHaveLength(1);
        } finally {
            await pg.close();
        }
    });
});
