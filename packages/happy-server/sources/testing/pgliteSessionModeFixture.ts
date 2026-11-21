import { readFile } from 'node:fs/promises';

/** Prisma's schema diff omits the trigger that supplies a mode for legacy writers. */
export async function withSessionPiiModeMigration(schema: string): Promise<string> {
    const migration = await readFile('prisma/migrations/20261105130000_session_pii_mode/migration.sql', 'utf8');
    return schema + '\nALTER TABLE "Session" DROP COLUMN "piiMode";\n' + migration;
}
