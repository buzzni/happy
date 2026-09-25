import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectPath } from '@/projectPath';
import { MandatorySandboxError } from './sandboxPolicy';
import {
    assertMandatoryDependencies, buildProcessSandboxConfig, createArgvFile,
    filterClaudeProcessEnv, prepareClaudeProcessSandbox, parseRuntimeCommand, seedClaudeState, parseClaudeSandboxDomains,
} from './claudeProcessSandbox';

const roots: string[] = [];
const privateDir = () => { const dir = mkdtempSync(join(tmpdir(), 'sandbox-test-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const config = {
    enabled: true, sessionIsolation: 'strict' as const, customWritePaths: [], extraWritePaths: ['/'],
    denyReadPaths: ['/synthetic-secret'], denyWritePaths: [], networkMode: 'allowed' as const,
    allowedDomains: [], deniedDomains: [], allowLocalBinding: true,
};

describe('mandatory whole-process boundary', () => {
    it('seeds only Claude credentials and keeps refreshed session credentials', () => {
        const source = privateDir(); const target = privateDir();
        writeFileSync(join(source, '.credentials.json'), 'synthetic-old');
        writeFileSync(join(source, 'settings.json'), 'must-not-copy');
        seedClaudeState(source, target);
        expect(readFileSync(join(target, '.credentials.json'), 'utf8')).toBe('synthetic-old');
        expect(existsSync(join(target, 'settings.json'))).toBe(false);
        writeFileSync(join(target, '.credentials.json'), 'synthetic-refreshed');
        seedClaudeState(source, target);
        expect(readFileSync(join(target, '.credentials.json'), 'utf8')).toBe('synthetic-refreshed');
    });
    it('does not follow a credential symlink out of the Claude auth directory', () => {
        const source = privateDir(); const target = privateDir();
        writeFileSync(join(source, 'happy-access.key'), 'synthetic-happy-secret');
        symlinkSync(join(source, 'happy-access.key'), join(source, '.credentials.json'));
        expect(() => seedClaudeState(source, target)).toThrow();
        expect(existsSync(join(target, '.credentials.json'))).toBe(false);
    });
    it('accepts exact installation domains and rejects wildcards, IPs and malformed policy', () => {
        expect(parseClaudeSandboxDomains('{"allowedDomains":["api.example.com"]}')).toEqual(['api.example.com']);
        for (const raw of ['{}', '{"allowedDomains":["*"]}', '{"allowedDomains":["127.0.0.1"]}', 'broken']) {
            expect(() => parseClaudeSandboxDomains(raw)).toThrow(MandatorySandboxError);
        }
    });
    it('treats escaped proxy globs as literal argv and rejects shell operators', () => {
        expect(parseRuntimeCommand('bwrap --setenv NO_PROXY \\*.local')).toEqual(['bwrap', '--setenv', 'NO_PROXY', '*.local']);
        expect(() => parseRuntimeCommand('bwrap ; evil')).toThrow(MandatorySandboxError);
    });
    it('uses a true env allowlist and preserves only Claude authentication', () => {
        expect(filterClaudeProcessEnv({ PATH: '/usr/bin', HOME: '/home/agent', ANTHROPIC_API_KEY: 'synthetic',
            HAPPY_BROWSER_TASK_SESSION_SECRET: 'synthetic', HAPPY_MASTER_SECRET: 'synthetic',
            HAPPY_HOME_DIR: '/secret', NODE_OPTIONS: '--require /evil', BASH_ENV: '/evil',
            UNKNOWN_TOKEN: 'synthetic', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0' })).toEqual({
            PATH: '/usr/bin', HOME: '/home/agent', ANTHROPIC_API_KEY: 'synthetic',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', TMPDIR: '/tmp',
        });
    });
    it('restricts writes and adds staged credentials, stack paths, and immutable install prefix', () => {
        const result = buildProcessSandboxConfig(config, '/work', '/opt/happy', ['/tmp/happy-session-synthetic']);
        expect(result.filesystem.allowWrite).toEqual(['/work']);
        expect(result.filesystem.denyRead).toEqual(expect.arrayContaining([
            '/synthetic-secret', '/tmp/happy-session-synthetic', '/run/abp', '/etc/abp', '/var/lib/abp', '/var/run/docker.sock',
        ]));
        expect(result.filesystem.denyWrite).toContain('/opt/happy');
        expect(result.network.allowedDomains).toEqual(['api.anthropic.com', 'claude.ai', 'platform.claude.com']);
        expect(result.network.allowAllUnixSockets).toBe(false);
    });
    it.each(['hasBwrap', 'hasSocat', 'hasSeccompBpf', 'hasSeccompApply'] as const)('refuses missing %s', (key) => {
        expect(() => assertMandatoryDependencies({ hasBwrap: true, hasSocat: true, hasSeccompBpf: true, hasSeccompApply: true, [key]: false }, true)).toThrow(MandatorySandboxError);
    });
    it('refuses missing ripgrep and runtime warnings', () => {
        const status = { hasBwrap: true, hasSocat: true, hasSeccompBpf: true, hasSeccompApply: true };
        expect(() => assertMandatoryDependencies(status, false)).toThrow(MandatorySandboxError);
        expect(() => assertMandatoryDependencies(status, true, { errors: [], warnings: ['seccomp unavailable'] })).toThrow(MandatorySandboxError);
    });
    it('refuses disabled config and unsupported platforms before initialization', async () => {
        await expect(prepareClaudeProcessSandbox({ sandboxConfig: { ...config, enabled: false }, sessionPath: '/work' })).rejects.toBeInstanceOf(MandatorySandboxError);
        if (process.platform !== 'linux') {
            await expect(prepareClaudeProcessSandbox({ sandboxConfig: config, sessionPath: '/work' })).rejects.toBeInstanceOf(MandatorySandboxError);
        }
    });
});

describe('per-spawn argv transport', () => {
    it('preserves arbitrary argv without shell evaluation and consumes the file', () => {
        const dir = privateDir();
        const argv = ['', 'spaces and\nnewlines', "'quote'", '$(touch should-not-exist)', '*'];
        const file = createArgvFile(dir, [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...argv]);
        expect(lstatSync(file).mode & 0o777).toBe(0o600);
        expect(readFileSync(file).at(-1)).toBe(0);
        const output = execFileSync('/bin/bash', [join(projectPath(), 'bin/claude-sandbox-launcher.sh'), file], { encoding: 'utf8' });
        expect(JSON.parse(output)).toEqual(argv);
        expect(existsSync(file)).toBe(false);
    });
    it('refuses collisions, symlinks, non-private dirs and NUL injection', () => {
        const dir = privateDir();
        createArgvFile(dir, ['original'], 'same');
        expect(() => createArgvFile(dir, ['replace'], 'same')).toThrow();
        symlinkSync(join(dir, 'same'), join(dir, 'link'));
        expect(() => createArgvFile(dir, ['replace'], 'link')).toThrow();
        expect(() => createArgvFile(dir, ['bad\0arg'])).toThrow();
        chmodSync(dir, 0o777);
        expect(() => createArgvFile(dir, ['command'])).toThrow(MandatorySandboxError);
    });
    it('rejects permission changes and symlink swaps before launch', () => {
        const dir = privateDir();
        const file = createArgvFile(dir, ['printf', 'should-not-run']);
        chmodSync(file, 0o666);
        expect(() => execFileSync('/bin/bash', [join(projectPath(), 'bin/claude-sandbox-launcher.sh'), file], { stdio: 'pipe' })).toThrow();
        rmSync(file);
        const other = createArgvFile(dir, ['printf', 'should-not-run']);
        symlinkSync(other, file);
        expect(() => execFileSync('/bin/bash', [join(projectPath(), 'bin/claude-sandbox-launcher.sh'), file], { stdio: 'pipe' })).toThrow();
    });
    it('isolates concurrent launcher invocations', async () => {
        const dir = privateDir();
        const files = await Promise.all(Array.from({ length: 30 }, (_, i) => Promise.resolve(createArgvFile(dir, ['printf', '%s', String(i)]))));
        expect(new Set(files).size).toBe(30);
        expect(files.map(file => execFileSync('/bin/bash', [join(projectPath(), 'bin/claude-sandbox-launcher.sh'), file], { encoding: 'utf8' }))).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
    });
});
