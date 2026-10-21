import { describe, expect, it } from 'vitest';
import { buildHookSettings } from './generateHookSettings';
import { resolveMachineLockdownPolicy } from '@/daemon/machineLockdownPolicy';

const base = { hookCommand: 'node fwd 1234', broadKillGuardCommand: 'node guard', homeDir: '/home/trial' };

describe('buildHookSettings', () => {
    it('keeps only the broad-kill guard on an unrestricted machine', () => {
        const settings = buildHookSettings({ ...base, policy: resolveMachineLockdownPolicy({}) }) as {
            permissions: { deny: string[] };
            hooks: Record<string, unknown>;
        };
        expect(settings.permissions.deny).toEqual(['Bash(killall:*)']);
        expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'PreToolUse']);
    });

    it('adds credential-path and environment-dump deny rules under the trial lockdown', () => {
        const settings = buildHookSettings({
            ...base,
            policy: resolveMachineLockdownPolicy({ HAPPY_RPC_ALLOWED_ROOT: 'workspace' }),
        }) as { permissions: { deny: string[] } };
        expect(settings.permissions.deny).toContain('Bash(killall:*)');
        expect(settings.permissions.deny).toContain('Read(~/.happy/**)');
        expect(settings.permissions.deny).toContain('Read(///home/trial/.happy/**)');
        expect(settings.permissions.deny).toContain('Bash(env)');
    });

    it('adds the tool policy hooks only when the policy is on', () => {
        type Settings = { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> } };
        const off = buildHookSettings({ ...base, policy: resolveMachineLockdownPolicy({}) }) as Settings;
        expect(off.hooks.PreToolUse.map((entry) => entry.matcher)).toEqual(['Bash']);

        const on = buildHookSettings({
            ...base,
            policy: resolveMachineLockdownPolicy({}),
            toolPolicy: { forwarderCommand: 'node policy 1234 /s', fileGuardCommand: 'node guard-file /p' },
        }) as Settings;
        const [kill, policy, fileGuard] = on.hooks.PreToolUse;
        expect(kill.matcher).toBe('Bash');
        expect(policy.hooks[0]).toMatchObject({ command: 'node policy 1234 /s', timeout: 1900, onFailure: 'block' });
        expect(fileGuard).toMatchObject({ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ command: 'node guard-file /p' }] });

        const matcher = new RegExp(policy.matcher);
        expect(matcher.test('mcp__cua-driver__click')).toBe(true);
        expect(matcher.test('mcp__notion__notion-update-page')).toBe(true);
        expect(matcher.test('mcp__happy__change_title')).toBe(false);
        expect(matcher.test('mcp__saycode__x')).toBe(false);
        expect(matcher.test('mcp__happy-extra__x')).toBe(true);
        expect(matcher.test('Bash')).toBe(false);
    });
});
