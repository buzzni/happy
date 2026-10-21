import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    CODEX_CONFIG_UNREADABLE,
    claudeCuaShadowEntry,
    codexCuaShadowConfig,
    readClaudeCuaUpstream,
} from './cuaShadow';

const POLICY_ENV = { HAPPY_TOOL_POLICY_PORT: '4000', HAPPY_TOOL_POLICY_SECRET_FILE: '/h/secret', HAPPY_TOOL_POLICY_SERVER: 'cua-driver' };

function claudeConfig(value: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'cua-shadow-'));
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(value));
    return dir;
}

describe('reading the cua-driver command Claude would run', () => {
    const user = { type: 'stdio', command: '/Users/me/.local/bin/cua-driver', args: ['mcp'], env: { CUA_TOKEN: 't' } };

    it('reads the user-scope entry, keeping only its command, args and string env', () => {
        const dir = claudeConfig({ mcpServers: { 'cua-driver': { ...user, env: { CUA_TOKEN: 't', BAD: 3 } }, notion: { command: 'x', env: { SECRET: 's' } } } });
        expect(readClaudeCuaUpstream({ configDir: dir, cwd: '/w/p' })).toEqual({ command: user.command, args: ['mcp'], env: { CUA_TOKEN: 't' } });
    });

    it('prefers the local-scope entry for the working directory, as Claude does (measured 2026-10-22)', () => {
        const dir = claudeConfig({ mcpServers: { 'cua-driver': user }, projects: { '/w/p': { mcpServers: { 'cua-driver': { command: 'cua-local', args: [] } } } } });
        expect(readClaudeCuaUpstream({ configDir: dir, cwd: '/w/p' })?.command).toBe('cua-local');
        expect(readClaudeCuaUpstream({ configDir: dir, cwd: '/w/other' })?.command).toBe(user.command);
    });

    it('finds nothing when the user does not run cua-driver, disabled it, or registered a non-stdio server', () => {
        expect(readClaudeCuaUpstream({ configDir: claudeConfig({ mcpServers: {} }), cwd: '/w/p' })).toBeNull();
        expect(readClaudeCuaUpstream({ configDir: mkdtempSync(join(tmpdir(), 'cua-shadow-')), cwd: '/w/p' })).toBeNull();
        expect(readClaudeCuaUpstream({ configDir: claudeConfig({ mcpServers: { 'cua-driver': user }, projects: { '/w/p': { disabledMcpServers: ['cua-driver'] } } }), cwd: '/w/p' })).toBeNull();
        expect(readClaudeCuaUpstream({ configDir: claudeConfig({ mcpServers: { 'cua-driver': { type: 'http', url: 'http://x' } } }), cwd: '/w/p' })).toBeNull();
        expect(readClaudeCuaUpstream({ configDir: claudeConfig('not json'), cwd: '/w/p' })).toBeNull();
    });

    it('follows the setting sources the session loads', () => {
        const dir = claudeConfig({ mcpServers: { 'cua-driver': user }, projects: { '/w/p': { mcpServers: { 'cua-driver': { command: 'cua-local' } } } } });
        expect(readClaudeCuaUpstream({ configDir: dir, cwd: '/w/p', settingSources: ['user'] })?.command).toBe(user.command);
        expect(readClaudeCuaUpstream({ configDir: dir, cwd: '/w/p', settingSources: ['project'] })).toBeNull();
        expect(readClaudeCuaUpstream({ configDir: dir, cwd: '/w/p', settingSources: [] })).toBeNull();
    });
});

describe('the shadow entries', () => {
    it('Claude: starts the proxy with the user command after --, and the user env plus the policy env', () => {
        expect(claudeCuaShadowEntry({ execPath: '/n/node', bridgeEntrypoint: '/h/bin/happy-mcp.mjs', upstream: { command: '/c/cua-driver', args: ['mcp'], env: { CUA_TOKEN: 't' } }, policyEnv: POLICY_ENV })).toEqual({
            type: 'stdio',
            command: '/n/node',
            args: ['--no-warnings', '--no-deprecation', '/h/bin/happy-mcp.mjs', '--cua-proxy', '--', '/c/cua-driver', 'mcp'],
            env: { CUA_TOKEN: 't', ...POLICY_ENV },
        });
    });

    it('Codex: replaces the command of the native entry and waits past the approval window', () => {
        const native = { 'cua-driver': { command: 'cua-driver', args: ['mcp'], env: { CUA_TOKEN: 't' } }, notion: { url: 'x' } };
        expect(codexCuaShadowConfig(native, { execPath: '/n/node', bridgeEntrypoint: '/h/bin/happy-mcp.mjs', policyEnv: POLICY_ENV })).toEqual({
            command: '/n/node',
            args: ['--no-warnings', '--no-deprecation', '/h/bin/happy-mcp.mjs', '--cua-proxy', '--', 'cua-driver', 'mcp'],
            env: { CUA_TOKEN: 't', ...POLICY_ENV },
            tool_timeout_sec: 1900,
        });
    });

    it('Codex: adds nothing when the user runs no cua-driver or has disabled it', () => {
        const opts = { execPath: '/n/node', bridgeEntrypoint: '/b', policyEnv: POLICY_ENV };
        expect(codexCuaShadowConfig({ notion: { url: 'x' } }, opts)).toBeNull();
        expect(codexCuaShadowConfig({ 'cua-driver': { command: 'cua-driver', enabled: false } }, opts)).toBeNull();
        expect(codexCuaShadowConfig(null, opts)).toBeNull();
    });

    it('Codex: turns off a cua-driver it cannot proxy, or one it could not read, instead of leaving it unguarded', () => {
        const opts = { execPath: '/n/node', bridgeEntrypoint: '/b', policyEnv: POLICY_ENV };
        const disabled = { command: '/n/node', args: ['/b', '--cua-proxy'], enabled: false };
        expect(codexCuaShadowConfig({ 'cua-driver': { url: 'http://127.0.0.1:9/mcp' } }, opts)).toEqual(disabled);
        expect(codexCuaShadowConfig(CODEX_CONFIG_UNREADABLE, opts)).toEqual(disabled);
    });
});
