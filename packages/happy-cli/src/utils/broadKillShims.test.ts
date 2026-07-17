import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installBroadKillShims } from './broadKillShims';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('installBroadKillShims', () => {
    let homeDir: string;

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), 'happy-shims-test-'));
    });

    afterEach(() => {
        rmSync(homeDir, { recursive: true, force: true });
    });

    it('creates executable killall and pkill shims and prepends PATH', () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
        const shimDir = installBroadKillShims(env, homeDir);

        expect(shimDir).toBe(join(homeDir, 'shims'));
        for (const binary of ['killall', 'pkill']) {
            const shimPath = join(shimDir!, binary);
            expect(existsSync(shimPath)).toBe(true);
            expect(statSync(shimPath).mode & 0o111).toBeTruthy();
            expect(readFileSync(shimPath, 'utf8')).toContain('happy-guard');
        }
        expect(env.PATH).toBe(`${shimDir}:/usr/bin:/bin`);
    });

    it('does not duplicate the shim dir in PATH on repeat installs', () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
        const shimDir = installBroadKillShims(env, homeDir);
        installBroadKillShims(env, homeDir);
        expect(env.PATH!.split(':').filter(p => p === shimDir)).toHaveLength(1);
    });

    it.each([
        ['killall', ['node']],
        ['killall', ['-9', 'node']],
        ['killall', ['Electron']],
        ['killall', ['happy']],
        ['pkill', ['node']],
        ['pkill', ['-f', 'node']],
        ['pkill', ['-9', '-f', 'node']],
        ['pkill', ['-f', '^node$']],
        ['pkill', ['caffeinate']],
    ])('shim blocks: %s %j', (binary, args) => {
        const shimDir = installBroadKillShims({ PATH: '/usr/bin:/bin' }, homeDir)!;
        const result = spawnSync(join(shimDir, binary), args, { encoding: 'utf8' });
        expect(result.status).toBe(87);
        expect(result.stderr).toContain('happy-guard');
    });

    it('shim delegates non-protected targets to the real binary', () => {
        const shimDir = installBroadKillShims({ PATH: '/usr/bin:/bin' }, homeDir)!;
        // A process name that certainly is not running: real killall exits
        // non-zero with its own message, NOT our guard exit code 87.
        const result = spawnSync(join(shimDir, 'killall'), ['happy-shim-test-no-such-proc'], { encoding: 'utf8' });
        expect(result.status).not.toBe(87);
        expect(result.stderr).not.toContain('happy-guard: blocked');
    });
});
