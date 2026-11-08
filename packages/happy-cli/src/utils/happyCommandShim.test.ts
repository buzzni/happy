import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installHappyCommandShim } from './happyCommandShim';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
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

    // POSIX names are case-sensitive: a lowercase `path` is some other variable.
    it('shouldLeaveALowercasePathVariableAloneOnPosix', () => {
        const env: NodeJS.ProcessEnv = { path: 'not a search path', PATH: '/usr/bin' };

        const shimDir = installHappyCommandShim(env, homeDir, { runtime: '/bin/echo', args: [] });

        expect(env).toEqual({ path: 'not a search path', PATH: `${shimDir}:/usr/bin` });
    });
});

describe('installHappyCommandShim on Windows', () => {
    let homeDir: string;

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), 'happy command shim-'));
    });

    afterEach(() => {
        rmSync(homeDir, { recursive: true, force: true });
    });

    // A Windows environment copy keeps the variable as `Path`; adding `PATH` beside it would leave
    // which one a child sees up to the runtime.
    it('shouldPrependTheShimToTheExistingWindowsPathVariable', () => {
        const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows' };

        const shimDir = installHappyCommandShim(env, homeDir, { runtime: 'node.exe', args: [] }, 'win32');

        expect(env.Path).toBe(`${shimDir};C:\\Windows`);
        expect(env).not.toHaveProperty('PATH');
    });

    describe.runIf(isWindows)('running the shim', () => {
        // Codex runs commands through PowerShell/cmd, which find `happy.cmd` through PATHEXT. cmd reads
        // a batch file in the console code page, so a non-ASCII profile path must not pass through it.
        const printArgs = { runtime: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'C:\\사용자 100%'] };
        const sessionEnv = (): NodeJS.ProcessEnv => ({ ...process.env });
        const cmd = (env: NodeJS.ProcessEnv, line: string) => spawnSync('cmd.exe', ['/d', '/s', '/c', line], { env, encoding: 'utf8' });

        it('shouldRunTheSessionsOwnCliFromCmd', () => {
            const env = sessionEnv();
            installHappyCommandShim(env, homeDir, printArgs);

            expect(JSON.parse(cmd(env, 'happy agent whoami').stdout)).toEqual(['C:\\사용자 100%', 'agent', 'whoami']);
        });

        // PowerShell runs `happy.cmd` through cmd, so `%VAR%` and embedded `"` in arguments are cmd's to
        // reparse; plain arguments, spaces included, must arrive intact.
        // A cold Windows PowerShell start alone takes 3 s on a CI runner and 8 s on a busy one.
        it('shouldRunTheSessionsOwnCliFromPowerShell', () => {
            const env = sessionEnv();
            installHappyCommandShim(env, homeDir, { runtime: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))'] });

            const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "happy agent 'two words'"], { env, encoding: 'utf8' });
            expect(JSON.parse(result.stdout)).toEqual(['agent', 'two words']);
        }, 30_000);

        it('shouldReturnTheCliExitCodeThroughCmd', () => {
            const env = sessionEnv();
            installHappyCommandShim(env, homeDir, { runtime: process.execPath, args: ['-e', 'process.exit(3)'] });

            expect(cmd(env, 'happy').status).toBe(3);
        });

        it('shouldGiveASourceModeCliItsTsconfigFromCmd', () => {
            const env = sessionEnv();
            delete env.TSX_TSCONFIG_PATH;
            installHappyCommandShim(env, homeDir, { runtime: process.execPath, args: ['-e', 'console.log(process.env.TSX_TSCONFIG_PATH)'], tsconfigPath: 'C:\\사용자\\100% tsconfig.json' });

            expect(cmd(env, 'happy').stdout.trim()).toBe('C:\\사용자\\100% tsconfig.json');
        });

        // Claude Code runs commands through Git Bash, which runs the extensionless sh shim.
        const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
        it.runIf(existsSync(gitBash))('shouldRunTheSessionsOwnCliFromGitBash', () => {
            const env = sessionEnv();
            installHappyCommandShim(env, homeDir, printArgs);

            const result = spawnSync(gitBash, ['-c', 'happy agent whoami'], { env, encoding: 'utf8' });
            expect(JSON.parse(result.stdout)).toEqual(['C:\\사용자 100%', 'agent', 'whoami']);
        });
    });
});
