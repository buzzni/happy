import { expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
it('migrates legacy sessions and rejects mode changes or inconsistent protection', async () => {
    const db = new PGlite();
    try {
        await db.exec('CREATE TABLE "Session" (id TEXT PRIMARY KEY); INSERT INTO "Session" VALUES (\'ordinary\');');
        const migration = (name: string) => readFile('prisma/migrations/' + name + '/migration.sql', 'utf8');
        await db.exec(await migration('20261030110000_session_pii_protection'));
        await db.exec(`INSERT INTO "Session" (id,"piiProtection") VALUES ('legacy',true)`);
        await db.exec(await migration('20261105130000_session_pii_mode'));
        expect((await db.query('SELECT id,"piiMode" FROM "Session" ORDER BY id')).rows).toEqual([{ id: 'legacy', piiMode: 'isolated' }, { id: 'ordinary', piiMode: 'none' }]);
        await db.exec(`INSERT INTO "Session" (id,"piiProtection","piiMode") VALUES ('host',true,'host-masking')`);
        for (const mode of ['isolated', 'none']) await expect(db.exec(`UPDATE "Session" SET "piiMode"='${mode}' WHERE id='host'`)).rejects.toThrow('pii-mode-immutable');
        await expect(db.exec(`INSERT INTO "Session" (id,"piiMode") VALUES ('bad','host-masking')`)).rejects.toThrow();
        await expect(db.exec(`INSERT INTO "Session" (id,"piiProtection","piiMode") VALUES ('bad',true,'future')`)).rejects.toThrow();
        await db.exec(`INSERT INTO "Session" (id,"piiProtection") VALUES ('old-client',true)`);
        expect((await db.query(`SELECT "piiMode" FROM "Session" WHERE id='old-client'`)).rows).toEqual([{ piiMode: 'isolated' }]);
    } finally { await db.close(); }
});
