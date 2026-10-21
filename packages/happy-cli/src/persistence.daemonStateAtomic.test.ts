import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from './configuration';
import { writeDaemonState, type DaemonLocallyPersistedState } from './persistence';

vi.mock('node:fs', async (original) => {
    const actual = await original<typeof import('node:fs')>();
    return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

describe('daemon state is replaced, never rewritten in place', () => {
    const originalDaemonStateFile = configuration.daemonStateFile;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let directory: string;
    let stateFile: string;

    beforeEach(() => {
        directory = fs.mkdtempSync(join(tmpdir(), 'happy-daemon-state-atomic-'));
        stateFile = join(directory, 'daemon.state.json');
        Object.defineProperty(configuration, 'daemonStateFile', { configurable: true, value: stateFile });
    });

    afterEach(() => {
        Object.defineProperty(configuration, 'daemonStateFile', { configurable: true, value: originalDaemonStateFile });
        Object.defineProperty(process, 'platform', platform);
        vi.mocked(fs.renameSync).mockReset();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    function state(pid: number): DaemonLocallyPersistedState {
        return {
            pid,
            httpPort: 33417,
            startTime: '8/17/2026, 12:05:29 PM',
            startedWithCliVersion: '1.1.10',
            daemonLogPath: join(directory, 'daemon.log'),
            state: 'running',
            trackedSessions: [],
        };
    }

    const others = () => fs.readdirSync(directory).filter((name) => name !== 'daemon.state.json');
    const pidOnDisk = () => JSON.parse(fs.readFileSync(stateFile, 'utf-8')).pid as number;

    it.skipIf(process.platform === 'win32')('swaps in a new owner-only file so a concurrent reader sees the old or the new state, never a partial one', () => {
        writeDaemonState(state(111));
        const before = fs.statSync(stateFile).ino;

        writeDaemonState(state(222));

        // A new inode means the file was renamed over the old one, not truncated and rewritten.
        expect(fs.statSync(stateFile).ino).not.toBe(before);
        expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
        expect(pidOnDisk()).toBe(222);
        expect(others()).toEqual([]);
    });

    it('keeps the previous state and leaves no temporary file when the swap fails', () => {
        writeDaemonState(state(111));
        vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('swap failed'), { code: 'EXDEV' }); });

        expect(() => writeDaemonState(state(222))).toThrow('swap failed');
        expect(pidOnDisk()).toBe(111);
        expect(others()).toEqual([]);
    });

    it.each(['EPERM', 'EACCES', 'EBUSY'])('falls back to an in-place write on Windows when another program holds the file (%s)', (code) => {
        writeDaemonState(state(111));
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('locked'), { code }); });

        writeDaemonState(state(222));

        expect(pidOnDisk()).toBe(222);
        expect(others()).toEqual([]);
    });
});
