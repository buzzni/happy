import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APPROVED_FOLDERS_FILE, readApprovedFolders } from './approvedFolders';

const directories: string[] = [];

async function happyHome() {
    const directory = await mkdtemp(join(tmpdir(), 'happy-approved-folders-'));
    directories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('readApprovedFolders', () => {
    it('has no approved folders until the machine owner approves one', async () => {
        expect(readApprovedFolders(await happyHome())).toEqual([]);
    });

    it('reads every approved folder on each call, so an approval applies without restarting the daemon', async () => {
        const home = await happyHome();
        await writeFile(join(home, APPROVED_FOLDERS_FILE), JSON.stringify({ version: 1, folders: [resolve('/srv/workspace')] }));
        expect(readApprovedFolders(home)).toEqual([resolve('/srv/workspace')]);

        await writeFile(join(home, APPROVED_FOLDERS_FILE), JSON.stringify({ version: 1, folders: [] }));
        expect(readApprovedFolders(home)).toEqual([]);
    });

    it('never widens to a drive or filesystem root, a relative path or an unknown file version', async () => {
        const home = await happyHome();
        const root = parse(resolve('/')).root;
        await writeFile(join(home, APPROVED_FOLDERS_FILE), JSON.stringify({
            version: 1,
            folders: [root, 'workspace', 7, resolve('/srv/ok')],
        }));
        expect(readApprovedFolders(home)).toEqual([resolve('/srv/ok')]);

        await writeFile(join(home, APPROVED_FOLDERS_FILE), JSON.stringify({ version: 2, folders: [resolve('/srv/ok')] }));
        expect(readApprovedFolders(home)).toEqual([]);

        await writeFile(join(home, APPROVED_FOLDERS_FILE), '{not json');
        expect(readApprovedFolders(home)).toEqual([]);
    });
});
