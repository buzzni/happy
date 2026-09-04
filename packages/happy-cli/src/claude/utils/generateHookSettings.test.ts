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
        expect(settings.permissions.deny).toContain('Read(/home/trial/.happy/**)');
        expect(settings.permissions.deny).toContain('Bash(env)');
    });
});
