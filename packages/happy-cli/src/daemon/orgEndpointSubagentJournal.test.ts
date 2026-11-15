import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrgSubagentJournal } from './orgEndpointSubagentJournal';
import type { OrgSubagentRecord } from './orgEndpointSubagent';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'org-subagent-')); dirs.push(home);
    const request = { operationId: 'operation', spawnId: 'spawn', sourceSessionId: 'parent', directory: '/project', agent: 'claude' as const, initialPrompt: 'work' };
    const record: OrgSubagentRecord = { version: 1, operationId: request.operationId, sourceSessionId: request.sourceSessionId,
        digest: createHash('sha256').update(JSON.stringify(request)).digest('hex'), request, phase: 'reserved', createdAt: Date.now() };
    return { home, record, journal: createOrgSubagentJournal(home) };
}
describe('private org subagent journal', () => {
    it('reserves once and durably retains unknown submissions across journal instances', async () => {
        const { home, journal, record } = await fixture();
        expect((await journal.reserve(record)).owner).toBe(true);
        expect((await createOrgSubagentJournal(home).reserve(record)).owner).toBe(false);
        await journal.write({ ...record, phase: 'unknown', sessionId: 'created' });
        expect(await createOrgSubagentJournal(home).read('operation')).toMatchObject({ phase: 'unknown', sessionId: 'created' });
        const directory = join(home, 'org-llm-subagent-operations');
        const file = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!);
        if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ digest: record.digest });
    });
    it('admits only one concurrent owner', async () => {
        const { journal, record } = await fixture();
        const reservations = await Promise.all(Array.from({ length: 8 }, () => journal.reserve(record)));
        expect(reservations.filter(value => value.owner)).toHaveLength(1);
    });
    it('refuses corrupted records and symlink targets without replacing either', async () => {
        const { home, journal, record } = await fixture(); await journal.reserve(record);
        const directory = join(home, 'org-llm-subagent-operations');
        const file = join(directory, (await readdir(directory)).find(name => name.endsWith('.json'))!);
        await writeFile(file, 'corrupt', { mode: 0o600 });
        await expect(journal.reserve(record)).rejects.toThrow();
        expect(await readFile(file, 'utf8')).toBe('corrupt');
        await rm(file);
        const target = join(home, 'target'); await writeFile(target, 'must-remain');
        await symlink(target, file);
        await expect(journal.reserve(record)).rejects.toThrow();
        expect(await readFile(target, 'utf8')).toBe('must-remain');
    });
});
