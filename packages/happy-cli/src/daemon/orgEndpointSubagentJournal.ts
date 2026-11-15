/** One private durable reservation per operation. A partial or unreadable record never becomes a new launch. */
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { protectStandaloneObservationDirectory } from './standaloneLaunchJournal';
import { orgSubagentRecordSchema } from './orgEndpointSubagent';

export function createOrgSubagentJournal(home: string) {
    return createOrgSubagentFiles(home, 'operations', raw => orgSubagentRecordSchema.parse(raw));
}

/** Shared only by this feature's child operations and user-authorized root preparations. */
export function createOrgSubagentFiles<T extends { operationId: string }>(home: string, namespace: 'operations' | 'roots' | 'root-claims', parse: (raw: unknown) => T) {
    const directory = join(home, 'org-llm-subagent-' + namespace);
    const fileOf = (id: string) => {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('org-subagent-journal-invalid-id');
        return join(directory, createHash('sha256').update(id).digest('hex') + '.json');
    };
    async function prepare() {
        let created = false;
        try { await mkdir(directory, { mode: 0o700 }); created = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await protectStandaloneObservationDirectory(directory, created);
    }
    async function syncDirectory() {
        if (process.platform === 'win32') return;
        const handle = await open(directory, constants.O_RDONLY);
        try { await handle.sync(); } finally { await handle.close(); }
    }
    async function read(id: string): Promise<T | null> {
        await prepare();
        let handle;
        try { handle = await open(fileOf(id), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('org-subagent-journal-unavailable'); }
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024 || process.platform !== 'win32'
                && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)) throw new Error();
            const record = parse(JSON.parse(await handle.readFile('utf8')));
            if (record.operationId !== id) throw new Error();
            return record;
        } catch { throw new Error('org-subagent-journal-invalid'); } finally { await handle.close(); }
    }
    function encode(record: T) {
        const text = JSON.stringify(parse(record));
        if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('org-subagent-journal-too-large');
        return text;
    }
    async function write(record: T) {
        const encoded = encode(record); await prepare();
        const file = fileOf(record.operationId), temp = file + '.' + randomUUID() + '.tmp';
        const handle = await open(temp, 'wx', 0o600);
        try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
        try { await rename(temp, file); await syncDirectory(); }
        finally { await unlink(temp).catch(() => undefined); }
    }
    const flights = new Map<string, Promise<unknown>>();
    async function reserve(record: T): Promise<{ owner: boolean; record: T }> {
        const previous = flights.get(record.operationId) ?? Promise.resolve();
        const flight = previous.catch(() => undefined).then(async () => {
            const encoded = encode(record); await prepare();
            let handle;
            try { handle = await open(fileOf(record.operationId), 'wx', 0o600); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('org-subagent-journal-unavailable');
                const existing = await read(record.operationId); if (!existing) throw new Error('org-subagent-journal-unavailable');
                return { owner: false, record: existing };
            }
            // A crash during this first write leaves an exclusive partial claim: it refuses recovery rather than replaying creation.
            try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
            await syncDirectory();
            return { owner: true, record };
        });
        flights.set(record.operationId, flight);
        try { return await flight; } finally { if (flights.get(record.operationId) === flight) flights.delete(record.operationId); }
    }
    return { reserve, read, write };
}
