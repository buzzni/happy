import { expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

it.each([false, true])('reads NO_CHANGE after migrating a database with the historical enum value present=%s', async (hasHistoricalValue) => {
    const pg = new PGlite();
    const client = new PrismaClient({ adapter: new PrismaPGlite(pg) });
    try {
        // Cover both a fresh deployment and one already upgraded by the removed feature.
        await pg.exec(`CREATE TYPE "AutomationRunOutcome" AS ENUM ('WOKE', 'SILENT', 'SKIPPED_GATE', 'ERROR'${hasHistoricalValue ? ", 'NO_CHANGE'" : ''});`);
        const migration = readFileSync('prisma/migrations/20261104000000_retain_legacy_automation_outcome/migration.sql', 'utf8');
        await pg.exec(migration);
        await pg.exec(migration);
        await pg.exec(`
            CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY, "outcome" "AutomationRunOutcome");
            INSERT INTO "AutomationRun" VALUES ('historical-run', 'NO_CHANGE');
        `);
        await expect(client.automationRun.findMany({ select: { outcome: true } })).resolves.toEqual([{ outcome: 'NO_CHANGE' }]);
    } finally {
        await client.$disconnect();
        await pg.close();
    }
});
