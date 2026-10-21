import { createHash, randomBytes } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * aplus specs/shared-machine-server-signing S6a (contract §20.5) — whether this machine was registered as an
 * organization's shared or dedicated PC, recorded locally once. Studio's database also names the type, but a PC must
 * not pin an organization key automatically because a database row says it is shared: only this record, written from
 * the registration claim, the PC's own "use as shared PC" or an administrator's customer-key request, allows that.
 * One file per machine id, created exclusively and never rewritten.
 */
export type MachineType = 'shared' | 'dedicated';
const recordSchema = z.object({ version: z.literal(1), machineId: z.string(), machineType: z.enum(['shared', 'dedicated']) }).strict();

export function createMachineTypeMarker(deps: { home: string; machineId: string }) {
    const file = join(deps.home, 'machine-type-' + createHash('sha256').update(deps.machineId).digest('hex').slice(0, 16) + '.json');
    return {
        async read(): Promise<MachineType | null> {
            let content: string;
            try { content = await readFile(file, 'utf8'); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
            try {
                const record = recordSchema.parse(JSON.parse(content));
                return record.machineId === deps.machineId ? record.machineType : null;
            } catch { return null; }
        },
        async record(machineType: MachineType): Promise<'recorded' | 'exists'> {
            // Written in full under a temporary name and published by link, which refuses an existing record: a crash
            // can leave a stray temporary file but never a half-written record that could not be replaced.
            const temporary = file + '.' + randomBytes(4).toString('hex') + '.tmp';
            const handle = await open(temporary, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify({ version: 1, machineId: deps.machineId, machineType }) + '\n'); await handle.sync(); }
            finally { await handle.close(); }
            try { await link(temporary, file); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
                throw error;
            } finally { await unlink(temporary).catch(() => undefined); }
            return 'recorded';
        },
    };
}
