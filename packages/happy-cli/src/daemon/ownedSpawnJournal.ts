/** Private durable creation records. Never exported to provider environment or RPC replies. */
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { protectStandaloneObservationDirectory } from './standaloneLaunchJournal';
import { ownedSpawnRecordSchema, type OwnedSpawnRecord } from './ownedSpawn';

/** One journal file: its record, or why it could not be read and the session it claims, if any is legible. */
export type OwnedSpawnJournalEntry = { record: OwnedSpawnRecord } | { error: unknown; sessionId: string | null };
export interface OwnedSpawnJournal {
    list(): Promise<OwnedSpawnRecord[]>;
    entries(): Promise<OwnedSpawnJournalEntry[]>;
    read(id: string): Promise<OwnedSpawnRecord | null>;
    write(record: OwnedSpawnRecord): Promise<void>;
}
/** The created session an unreadable file still names legibly; null when nothing can be told. */
function claimedSession(text: string | undefined): string | null {
    try {
        const sessionId = (JSON.parse(text ?? '') as { created?: { sessionId?: unknown } } | null)?.created?.sessionId;
        return typeof sessionId === 'string' ? sessionId : null;
    } catch { return null; }
}
export function createOwnedSpawnJournal(home: string): OwnedSpawnJournal {
    const directory = join(home, 'owned-spawns');
    const path = (id: string) => join(directory, createHash('sha256').update(id).digest('hex') + '.json');
    async function prepare() {
        await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
        await protectStandaloneObservationDirectory(directory);
    }
    async function syncDirectory() {
        if (process.platform === 'win32') return;
        const handle = await open(directory, constants.O_RDONLY);
        try { await handle.sync(); } finally { await handle.close(); }
        const parent = await open(home, constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
    }
    const journal: OwnedSpawnJournal = {
        async list() {
            const result: OwnedSpawnRecord[] = [];
            for (const entry of await journal.entries()) {
                if ('error' in entry) throw entry.error;
                result.push(entry.record);
            }
            return result;
        },
        async entries() {
            await prepare();
            const result: OwnedSpawnJournalEntry[] = [];
            for (const name of await readdir(directory)) {
                if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
                let text: string | undefined;
                try {
                    const h = await open(join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
                    let id: string;
                    try {
                        const stat = await h.stat();
                        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('owned-spawn-journal-invalid');
                        text = await h.readFile('utf8');
                        id = ownedSpawnRecordSchema.parse(JSON.parse(text)).intent.creationRequestId;
                    } finally { await h.close(); }
                    if (path(id) !== join(directory, name)) throw new Error('owned-spawn-journal-invalid');
                    const record = await journal.read(id); if (record) result.push({ record });
                } catch (error) { result.push({ error, sessionId: claimedSession(text) }); }
            }
            return result;
        },
        async read(id) {
            await prepare();
            let handle;
            try { handle = await open(path(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('owned-spawn-journal-unavailable'); }
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024
                    || process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)) throw new Error();
                const record = ownedSpawnRecordSchema.parse(JSON.parse(await handle.readFile('utf8')));
                if (record.intent.creationRequestId !== id) throw new Error();
                await handle.sync(); await syncDirectory();
                return record;
            } catch { throw new Error('owned-spawn-journal-invalid'); } finally { await handle.close(); }
        },
        async write(record) {
            const value = ownedSpawnRecordSchema.parse(record);
            const encoded = JSON.stringify(value); if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('owned-spawn-journal-too-large');
            await prepare();
            const file = path(value.intent.creationRequestId), temporary = file + '.' + randomUUID() + '.tmp';
            const handle = await open(temporary, 'wx', 0o600);
            try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
            try { await rename(temporary, file); await syncDirectory(); }
            finally { await unlink(temporary).catch(() => undefined); }
        },
    };
    return journal;
}
