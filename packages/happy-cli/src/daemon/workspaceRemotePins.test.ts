import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceRemotePins } from './workspaceRemotePins';

let home: string;
let file: string;

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'happy-pins-'));
    file = join(home, 'workspace-remotes.json');
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('workspaceRemotePins', () => {
    it('remembers the first repository of each folder and kind', async () => {
        const pins = workspaceRemotePins(file);
        expect(await pins.pinned('/ws/a', 'workspace')).toBeNull();
        await pins.pin('/ws/a', 'workspace', 'github.com/acme/app');
        await pins.pin('/ws/a', 'deploy', 'github.com/acme/app-deploy');
        expect(await pins.pinned('/ws/a', 'workspace')).toBe('github.com/acme/app');
        expect(await pins.pinned('/ws/a', 'deploy')).toBe('github.com/acme/app-deploy');
        expect(await pins.pinned('/ws/b', 'workspace')).toBeNull();
    });

    it('survives a daemon restart, in a file only the daemon user reads', async () => {
        await workspaceRemotePins(file).pin('/ws/a', 'workspace', 'github.com/acme/app');
        expect(await workspaceRemotePins(file).pinned('/ws/a', 'workspace')).toBe('github.com/acme/app');
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, workspaces: { '/ws/a': { workspace: 'github.com/acme/app' } } });
    });

    it('starts empty from an unreadable record instead of failing every operation', async () => {
        writeFileSync(file, '{not json');
        const pins = workspaceRemotePins(file);
        expect(await pins.pinned('/ws/a', 'workspace')).toBeNull();
        await pins.pin('/ws/a', 'workspace', 'github.com/acme/app');
        expect(await pins.pinned('/ws/a', 'workspace')).toBe('github.com/acme/app');
    });

    it('keeps both of two pins written at once', async () => {
        const pins = workspaceRemotePins(file);
        await Promise.all([pins.pin('/ws/a', 'workspace', 'github.com/acme/a'), pins.pin('/ws/b', 'workspace', 'github.com/acme/b')]);
        const reread = workspaceRemotePins(file);
        expect(await reread.pinned('/ws/a', 'workspace')).toBe('github.com/acme/a');
        expect(await reread.pinned('/ws/b', 'workspace')).toBe('github.com/acme/b');
    });
});
