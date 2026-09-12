import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationDir = join(process.cwd(), 'prisma/migrations/20260901090000_add_session_followups');
const readSql = (name: string) => readFileSync(join(migrationDir, name), 'utf8');

describe('session follow-up migration', () => {
    it('owns durable state, tombstones, encrypted history detail, and claim fences', () => {
        const sql = readSql('migration.sql');
        expect(sql).toContain('CREATE TABLE "SessionFollowup"');
        expect(sql).toContain('CREATE TABLE "SessionFollowupChange"');
        expect(sql).toContain('CREATE TABLE "SessionFollowupHistory"');
        expect(sql).toContain('"detailCiphertext" BYTEA');
        expect(sql).toContain('"SessionFollowup_claimTokenHash_key"');
        expect(sql).toContain('"SessionFollowup_one_active_per_session"');
        expect(sql).toContain("'PERMISSION_REVOKED'");
        expect(sql).toContain('"SessionFollowup_rounds_check"');
        expect(sql).not.toContain('reviewBody');
        expect(sql).not.toContain('reviewText');
    });

    it('applies and rolls back while preserving prerequisite tables', async () => {
        const pg = new PGlite();
        try {
            await pg.exec(`
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Project" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL, "accountId" TEXT NOT NULL);
                CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");
            `);
            await pg.exec(readSql('migration.sql'));
            await pg.exec(readSql('rollback.sql'));
            const remaining = await pg.query<{ table_name: string }>(`
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' ORDER BY table_name
            `);
            expect(remaining.rows.map((row) => row.table_name)).toEqual(['Account', 'Machine', 'Project']);
        } finally {
            await pg.close();
        }
    });

    it('rejects an out-of-range total or current round in PostgreSQL', async () => {
        const pg = new PGlite();
        try {
            await pg.exec(`
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Project" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL, "accountId" TEXT NOT NULL);
                CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");
            `);
            await pg.exec(readSql('migration.sql'));
            await pg.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "Project" ("id") VALUES ('project-1');
                INSERT INTO "Machine" ("id", "accountId") VALUES ('machine-1', 'account-1');
            `);
            const insert = (totalRounds: number, currentRound: number) => pg.exec(`
                INSERT INTO "SessionFollowup" (
                    "id", "projectId", "ownerAccountId", "machineAccountId", "machineId", "sessionId",
                    "payloadCiphertext", "viewerKeyId", "viewerKeyVersion", "viewerKeyEnvelope",
                    "machineKeyVersion", "machineKeyEnvelope", "totalRounds", "currentRound",
                    "responseBoundarySeq", "lastObservedSeq", "updatedAt"
                ) VALUES (
                    'followup-${totalRounds}-${currentRound}', 'project-1', 'account-1', 'account-1', 'machine-1', 'session-1',
                    '\\x01', 'viewer', 1, '\\x02', 1, '\\x03', ${totalRounds}, ${currentRound}, 1, 1, CURRENT_TIMESTAMP
                );
            `);
            await expect(insert(8, 1)).rejects.toThrow(/SessionFollowup_rounds_check/);
            await expect(insert(3, 4)).rejects.toThrow(/SessionFollowup_rounds_check/);
        } finally {
            await pg.close();
        }
    });

    it('allows only one active loop per session across projects', async () => {
        const pg = new PGlite();
        try {
            await pg.exec(`
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Project" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL, "accountId" TEXT NOT NULL);
                CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");
            `);
            await pg.exec(readSql('migration.sql'));
            await pg.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "Project" ("id") VALUES ('project-1'), ('project-2');
                INSERT INTO "Machine" ("id", "accountId") VALUES ('machine-1', 'account-1');
            `);
            const insert = (id: string, projectId = 'project-1') => pg.exec(`
                INSERT INTO "SessionFollowup" (
                    "id", "projectId", "ownerAccountId", "machineAccountId", "machineId", "sessionId",
                    "payloadCiphertext", "viewerKeyId", "viewerKeyVersion", "viewerKeyEnvelope",
                    "machineKeyVersion", "machineKeyEnvelope", "totalRounds", "currentRound",
                    "responseBoundarySeq", "lastObservedSeq", "updatedAt"
                ) VALUES (
                    '${id}', '${projectId}', 'account-1', 'account-1', 'machine-1', 'session-1',
                    '\\x01', 'viewer', 1, '\\x02', 1, '\\x03', 4, 1, 1, 1, CURRENT_TIMESTAMP
                );
            `);
            await insert('followup-1');
            await expect(insert('followup-2', 'project-2')).rejects.toThrow(/SessionFollowup_one_active_per_session/);
            await pg.exec(`UPDATE "SessionFollowup" SET "status" = 'COMPLETED' WHERE "id" = 'followup-1'`);
            await expect(insert('followup-3')).resolves.toEqual([
                expect.objectContaining({ affectedRows: 1 }),
            ]);
        } finally {
            await pg.close();
        }
    });

    it('preserves follow-up history without blocking machine deletion', async () => {
        const pg = new PGlite();
        try {
            await pg.exec(`
                CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Project" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL, "accountId" TEXT NOT NULL);
                CREATE UNIQUE INDEX "Machine_accountId_id_key" ON "Machine"("accountId", "id");
            `);
            await pg.exec(readSql('migration.sql'));
            await pg.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "Project" ("id") VALUES ('project-1');
                INSERT INTO "Machine" ("id", "accountId") VALUES ('machine-1', 'account-1');
                INSERT INTO "SessionFollowup" (
                    "id", "projectId", "ownerAccountId", "machineAccountId", "machineId", "sessionId",
                    "payloadCiphertext", "viewerKeyId", "viewerKeyVersion", "viewerKeyEnvelope",
                    "machineKeyVersion", "machineKeyEnvelope", "totalRounds", "currentRound",
                    "responseBoundarySeq", "lastObservedSeq", "updatedAt"
                ) VALUES (
                    'followup-1', 'project-1', 'account-1', 'account-1', 'machine-1', 'session-1',
                    '\\x01', 'viewer', 1, '\\x02', 1, '\\x03', 4, 1, 1, 1, CURRENT_TIMESTAMP
                );
                DELETE FROM "Machine" WHERE "id" = 'machine-1';
            `);
            const rows = await pg.query<{ id: string; machineId: string }>(
                'SELECT "id", "machineId" FROM "SessionFollowup"',
            );
            expect(rows.rows).toEqual([{ id: 'followup-1', machineId: 'machine-1' }]);
        } finally {
            await pg.close();
        }
    });
});
