import { isDeepStrictEqual } from 'node:util';
import { scriptEncryptedValueSchema, type ScriptEncryptedValue } from '@slopus/happy-wire';
import type { ScriptQueueDatabase } from './scriptInvocationService';

export type ScriptArtifact = { id: string; projectId: string; digest: string; encrypted: ScriptEncryptedValue };
export type ScriptRevisionInput = {
  automationId: string; projectId: string; revision: number; artifactId: string;
  digest: string; payloadCiphertext: string; admission: Record<string, unknown>;
};

/** Internal repository: callers must establish project read/write authorization. */
export function createScriptArtifactService(database: ScriptQueueDatabase) {
  return {
    put(input: ScriptArtifact): Promise<ScriptArtifact> {
      const encrypted = scriptEncryptedValueSchema.parse(input.encrypted);
      if (!/^[a-f0-9]{64}$/.test(input.digest)) throw new Error('ARTIFACT_DIGEST_INVALID');
      return database.transaction(async (tx) => {
        await tx.query('INSERT INTO "ScriptArtifact" (id,"projectId",digest,encrypted) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO NOTHING',
          [input.id, input.projectId, input.digest, JSON.stringify(encrypted)]);
        const [row] = await tx.query<ScriptArtifact>('SELECT * FROM "ScriptArtifact" WHERE id=$1 AND "projectId"=$2 FOR UPDATE', [input.id, input.projectId]);
        if (!row) throw new Error('ARTIFACT_NOT_FOUND');
        if (row.digest !== input.digest || !isDeepStrictEqual(row.encrypted, encrypted)) throw new Error('ARTIFACT_IMMUTABLE');
        return row;
      });
    },
    get(projectId: string, artifactId: string): Promise<ScriptArtifact> {
      return database.transaction(async (tx) => {
        const [row] = await tx.query<ScriptArtifact>('SELECT * FROM "ScriptArtifact" WHERE id=$1 AND "projectId"=$2', [artifactId, projectId]);
        if (!row) throw new Error('ARTIFACT_NOT_FOUND');
        return row;
      });
    },
    attachRevision(input: ScriptRevisionInput): Promise<void> {
      return database.transaction(async (tx) => {
        const [automation] = await tx.query<{ revision: number }>('SELECT revision FROM "Automation" WHERE id=$1 AND "projectId"=$2 AND "deletedAt" IS NULL FOR UPDATE', [input.automationId, input.projectId]);
        if (!automation || automation.revision !== input.revision) throw new Error('REVISION_CONFLICT');
        const [artifact] = await tx.query<ScriptArtifact>('SELECT * FROM "ScriptArtifact" WHERE id=$1 AND "projectId"=$2 FOR SHARE', [input.artifactId, input.projectId]);
        if (!artifact) throw new Error('ARTIFACT_NOT_FOUND');
        if (artifact.digest !== input.digest) throw new Error('ARTIFACT_DIGEST_MISMATCH');
        await tx.query(`INSERT INTO "ScriptAutomationRevision" ("automationId",revision,"artifactId",digest,"payloadCiphertext",admission)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT ("automationId",revision) DO NOTHING`,
          [input.automationId, input.revision, input.artifactId, input.digest, input.payloadCiphertext, JSON.stringify(input.admission)]);
        const [existing] = await tx.query<ScriptRevisionInput>('SELECT * FROM "ScriptAutomationRevision" WHERE "automationId"=$1 AND revision=$2', [input.automationId, input.revision]);
        if (existing.artifactId !== input.artifactId || existing.digest !== input.digest
          || existing.payloadCiphertext !== input.payloadCiphertext || !isDeepStrictEqual(existing.admission, input.admission)) throw new Error('REVISION_IMMUTABLE');
      });
    },
    removeUnreferenced(projectId: string, artifactId: string): Promise<void> {
      return database.transaction(async (tx) => {
        const [artifact] = await tx.query('SELECT id FROM "ScriptArtifact" WHERE id=$1 AND "projectId"=$2 FOR UPDATE', [artifactId, projectId]);
        if (!artifact) throw new Error('ARTIFACT_NOT_FOUND');
        if ((await tx.query('SELECT "automationId" FROM "ScriptAutomationRevision" WHERE "artifactId"=$1 LIMIT 1', [artifactId])).length) throw new Error('ARTIFACT_IN_USE');
        await tx.query('DELETE FROM "ScriptArtifact" WHERE id=$1 AND "projectId"=$2', [artifactId, projectId]);
      });
    },
  };
}
