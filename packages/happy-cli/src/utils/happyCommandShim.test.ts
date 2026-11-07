import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installHappyCommandShim } from './happyCommandShim';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';

describe.skipIf(isWindows)('installHappyCommandShim', () => {
    let homeDir: string;

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), 'happy command shim-'));
    });

    afterEach(() => {
        rmSync(homeDir, { recursive: true, force: true });
    });

    // The session prompt tells the agent to run `happy agent …`; a daemon launched without the CLI's
    // bin on PATH (or an absent global install) made that `command not found`.
    it('shouldRunTheSessionsOwnCliWhenTheSessionTypesHappy', () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
        const command = { runtime: '/bin/echo', args: ["it's", 'the session cli'] };

        installHappyCommandShim(env, homeDir, command);

        const result = spawnSync('happy', ['agent', 'whoami'], { env, encoding: 'utf8' });
        expect(result.stdout).toBe("it's the session cli agent whoami\n");
    });

    it('shouldInstallAnExecutableShimFirstOnPathOnlyOnce', () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
        const command = { runtime: '/bin/echo', args: [] };

        const shimDir = installHappyCommandShim(env, homeDir, command);
        installHappyCommandShim(env, homeDir, command);

        expect(shimDir).toBe(join(homeDir, 'shims'));
        expect(statSync(join(shimDir!, 'happy')).mode & 0o111).toBeTruthy();
        expect(env.PATH).toBe(`${shimDir}:/usr/bin`);
    });
});
