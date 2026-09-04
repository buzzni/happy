import { describe, expect, it } from 'vitest';
import {
    REMOTE_TERMINAL_DISABLED_ERROR,
    managedCredentialDenyRules,
    resolveMachineLockdownPolicy,
} from './machineLockdownPolicy';

describe('resolveMachineLockdownPolicy', () => {
    it('keeps every capability open when no lockdown env is set', () => {
        expect(resolveMachineLockdownPolicy({})).toEqual({
            remoteTerminalDisabled: false,
            rpcAllowedRootMode: 'home',
            protectManagedCredentials: false,
        });
    });

    it('disables the remote terminal only for the explicit disabled policy', () => {
        expect(resolveMachineLockdownPolicy({ HAPPY_REMOTE_TERMINAL_POLICY: 'disabled' }).remoteTerminalDisabled).toBe(true);
        expect(resolveMachineLockdownPolicy({ HAPPY_REMOTE_TERMINAL_POLICY: ' Disabled ' }).remoteTerminalDisabled).toBe(true);
        expect(resolveMachineLockdownPolicy({ HAPPY_REMOTE_TERMINAL_POLICY: 'enabled' }).remoteTerminalDisabled).toBe(false);
        expect(resolveMachineLockdownPolicy({ HAPPY_REMOTE_TERMINAL_POLICY: '1' }).remoteTerminalDisabled).toBe(false);
    });

    it('confines file RPCs and protects credentials together under the workspace root mode', () => {
        expect(resolveMachineLockdownPolicy({ HAPPY_RPC_ALLOWED_ROOT: 'workspace' })).toEqual({
            remoteTerminalDisabled: false,
            rpcAllowedRootMode: 'workspace',
            protectManagedCredentials: true,
        });
        expect(resolveMachineLockdownPolicy({ HAPPY_RPC_ALLOWED_ROOT: 'home' }).rpcAllowedRootMode).toBe('home');
    });

    it('denies credential directories, /proc and environment dumps for the agent', () => {
        const rules = managedCredentialDenyRules('/home/trial/');
        expect(rules).toContain('Read(/home/trial/.happy/**)');
        expect(rules).toContain('Read(/home/trial/.claude/**)');
        expect(rules).toContain('Read(/home/trial/.claude-swap/**)');
        expect(rules).toContain('Read(/home/trial/.codex/**)');
        expect(rules).toContain('Bash(cat /home/trial/.happy/*)');
        expect(rules).toContain('Read(/proc/**)');
        expect(rules).toContain('Bash(env)');
        expect(rules).toContain('Bash(printenv:*)');
        expect(REMOTE_TERMINAL_DISABLED_ERROR).toBe('TERMINAL_DISABLED');
    });
});
