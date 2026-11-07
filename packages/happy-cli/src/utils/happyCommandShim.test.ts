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

    // Sessions of different CLI versions share one home: a newer session starting must not
    // redirect an older session's `happy` to its own CLI.
    it('shouldKeepEachSessionsHappyOnItsOwnCliWhenAnotherSessionStartsLater', () => {
        const olderEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
        const newerEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };

        installHappyCommandShim(olderEnv, homeDir, { runtime: '/bin/echo', args: ['older'] });
        installHappyCommandShim(newerEnv, homeDir, { runtime: '/bin/echo', args: ['newer'] });

        expect(spawnSync('happy', [], { env: olderEnv, encoding: 'utf8' }).stdout).toBe('older\n');
        expect(spawnSync('happy', [], { env: newerEnv, encoding: 'utf8' }).stdout).toBe('newer\n');
    });

    // A source-mode (tsx) CLI resolves its `@/` imports only with its tsconfig, as spawnHappyCLI sets it.
    it('shouldGiveASourceModeCliItsTsconfigUnlessTheCallerSetsOne', () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
        const command = { runtime: '/bin/sh', args: ['-c', 'echo "$TSX_TSCONFIG_PATH"', 'sh'], tsconfigPath: '/cli/tsconfig.json' };

        installHappyCommandShim(env, homeDir, command);

        expect(spawnSync('happy', [], { env, encoding: 'utf8' }).stdout).toBe('/cli/tsconfig.json\n');
        expect(spawnSync('happy', [], { env: { ...env, TSX_TSCONFIG_PATH: '/own.json' }, encoding: 'utf8' }).stdout).toBe('/own.json\n');
    });

    it('shouldInstallAnExecutableShimFirstOnPathOnlyOnce', () => {
        const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
        const command = { runtime: '/bin/echo', args: [] };

        const shimDir = installHappyCommandShim(env, homeDir, command);
        installHappyCommandShim(env, homeDir, command);

        expect(shimDir!.startsWith(join(homeDir, 'happy-shims'))).toBe(true);
        expect(statSync(join(shimDir!, 'happy')).mode & 0o111).toBeTruthy();
        expect(env.PATH).toBe(`${shimDir}:/usr/bin`);
    });
});
