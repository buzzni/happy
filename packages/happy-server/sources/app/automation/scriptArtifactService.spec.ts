import { afterEach, beforeEach, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createScriptArtifactService } from './scriptArtifactService';
import type { ScriptQueueDatabase } from './scriptInvocationService';

let db: PGlite;
let artifacts: ReturnType<typeof createScriptArtifactService>;
const value = { id: 'code-1', projectId: 'p1', digest: 'a'.repeat(64), encrypted: { version: 2 as const, ciphertext: 'Ag==', machineKeyEnvelope: 'Ag==', viewerKeyEnvelope: 'Ag==' } };
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE "Project" (id TEXT PRIMARY KEY); INSERT INTO "Project" VALUES ('p1'),('p2');
    CREATE TABLE "Automation" (id TEXT PRIMARY KEY,"projectId" TEXT,revision INTEGER,generation INTEGER,paused BOOLEAN,"deletedAt" TIMESTAMPTZ);
    INSERT INTO "Automation" VALUES ('a1','p1',1,1,false,NULL);`);
  await db.exec(await readFile('prisma/migrations/20260908233000_script_invocations/migration.sql', 'utf8'));
  const database: ScriptQueueDatabase = { transaction: (action) => db.transaction((tx) => action({ query: async <T>(sql: string, values: unknown[] = []) => (await tx.query<T>(sql, values)).rows })) };
  artifacts = createScriptArtifactService(database);
});
afterEach(async () => { await db?.close(); });

it('stores only ciphertext and makes retries immutable and project scoped', async () => {
  expect(await artifacts.put(value)).toMatchObject(value);
  expect(await artifacts.put(value)).toMatchObject(value);
  await expect(artifacts.put({ ...value, digest: 'b'.repeat(64) })).rejects.toThrow('ARTIFACT_IMMUTABLE');
  await expect(artifacts.get('p2', 'code-1')).rejects.toThrow('ARTIFACT_NOT_FOUND');
});
it('binds the revision to an artifact in the same project and retains it while referenced', async () => {
  await artifacts.put(value);
  await artifacts.attachRevision({ automationId: 'a1', projectId: 'p1', revision: 1, artifactId: value.id,
    digest: value.digest, payloadCiphertext: 'encrypted-configuration', admission: { externalEnabled: false } });
  const row = (await db.query<{ ready: boolean }>('SELECT ready FROM "ScriptAutomationRevision"')).rows[0];
  expect(row.ready).toBe(false);
  await expect(artifacts.removeUnreferenced('p1', value.id)).rejects.toThrow('ARTIFACT_IN_USE');
  await expect(artifacts.removeUnreferenced('p2', value.id)).rejects.toThrow('ARTIFACT_NOT_FOUND');
  await artifacts.put({ ...value, id: 'code-2', projectId: 'p2' });
  await expect(artifacts.attachRevision({ automationId: 'a1', projectId: 'p1', revision: 1, artifactId: 'code-2',
    digest: value.digest, payloadCiphertext: 'encrypted', admission: {} })).rejects.toThrow('ARTIFACT_NOT_FOUND');
});
