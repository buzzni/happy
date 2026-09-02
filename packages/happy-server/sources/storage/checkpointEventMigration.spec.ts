import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationSql = readFileSync(join(
    process.cwd(),
    'prisma/migrations/20260902130000_add_checkpoint_event_metadata/migration.sql',
), 'utf8');

describe('checkpoint event migration', () => {
    it('preserves legacy rows and deduplicates only populated session-local keys', async () => {
        const pg = new PGlite();
        try {
            await pg.exec(`
                CREATE TABLE "SessionEvent" (
                    "id" TEXT PRIMARY KEY,
                    "sessionId" TEXT NOT NULL,
                    "eventType" TEXT NOT NULL,
                    "seq" INTEGER NOT NULL,
                    "content" JSONB NOT NULL,
                    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" TIMESTAMP NOT NULL
                );
                INSERT INTO "SessionEvent" (
                    "id", "sessionId", "eventType", "seq", "content", "updatedAt"
                ) VALUES (
                    'legacy-1', 'session-1', 'session-end', 1, '{}', CURRENT_TIMESTAMP
                );
            `);
            await pg.exec(migrationSql);
            await pg.exec(`
                INSERT INTO "SessionEvent" (
                    "id", "sessionId", "eventType", "seq", "content", "updatedAt"
                ) VALUES (
                    'legacy-2', 'session-1', 'session-end', 2, '{}', CURRENT_TIMESTAMP
                );
                INSERT INTO "SessionEvent" (
                    "id", "sessionId", "eventType", "seq", "content",
                    "checkpoint", "idempotencyKey", "updatedAt"
                ) VALUES (
                    'checkpoint-1', 'session-1', 'checkpoint-snapshot', 3, '{}',
                    '{"schemaVersion":1}', 'checkpoint-snapshot:operation-1:created', CURRENT_TIMESTAMP
                );
            `);

            await expect(pg.exec(`
                INSERT INTO "SessionEvent" (
                    "id", "sessionId", "eventType", "seq", "content",
                    "checkpoint", "idempotencyKey", "updatedAt"
                ) VALUES (
                    'checkpoint-duplicate', 'session-1', 'checkpoint-snapshot', 4, '{}',
                    '{"schemaVersion":1}', 'checkpoint-snapshot:operation-1:created', CURRENT_TIMESTAMP
                );
            `)).rejects.toThrow(/SessionEvent_sessionId_idempotencyKey_key/);

            await expect(pg.exec(`
                INSERT INTO "SessionEvent" (
                    "id", "sessionId", "eventType", "seq", "content",
                    "checkpoint", "idempotencyKey", "updatedAt"
                ) VALUES (
                    'checkpoint-other-session', 'session-2', 'checkpoint-snapshot', 1, '{}',
                    '{"schemaVersion":1}', 'checkpoint-snapshot:operation-1:created', CURRENT_TIMESTAMP
                );
            `)).resolves.toEqual([expect.objectContaining({ affectedRows: 1 })]);

            const rows = await pg.query<{ id: string; checkpoint: unknown }>(`
                SELECT "id", "checkpoint" FROM "SessionEvent" ORDER BY "id"
            `);
            expect(rows.rows).toEqual([
                { id: 'checkpoint-1', checkpoint: { schemaVersion: 1 } },
                { id: 'checkpoint-other-session', checkpoint: { schemaVersion: 1 } },
                { id: 'legacy-1', checkpoint: null },
                { id: 'legacy-2', checkpoint: null },
            ]);
        } finally {
            await pg.close();
        }
    });
});
