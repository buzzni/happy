import { describe, expect, it } from 'vitest';
import { orgEndpointRoutingSettingsEnv } from './orgEndpointEnvKeys';
import { buildHookSettings, toolPolicyHookCommands } from './generateHookSettings';
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

    // codexcli-org-requirements R10.10 (measured T11 ⑤, Claude 2.1.305: the TUI then cannot cycle into bypass).
    it('locks bypass mode out only under an organization ceiling, and is unchanged otherwise', () => {
        const plain = buildHookSettings({ ...base, policy: resolveMachineLockdownPolicy({}) });
        expect(buildHookSettings({ ...base, policy: resolveMachineLockdownPolicy({}), disableBypassPermissions: false })).toEqual(plain);
        const locked = buildHookSettings({ ...base, policy: resolveMachineLockdownPolicy({}), disableBypassPermissions: true }) as { permissions: Record<string, unknown> };
        expect(locked.permissions).toEqual({ deny: ['Bash(killall:*)'], disableBypassPermissionsMode: 'disable' });
    });

    it('passes protected directories and the skill lock file beside the policy file to the file guard', () => {
        const input = { execPath: '/n', scriptsDir: '/s', port: 1, secretFile: '/sec', policyFile: '/h/tool-policy.json' };
        const skillLocks = ' --skill-locks "/h/skill-locks.json" --hook 1 "/sec"';
        expect(toolPolicyHookCommands(input).fileGuardCommand).toBe(`"/n" "/s/tool_policy_file_guard.cjs" "/h/tool-policy.json"${skillLocks}`);
        expect(toolPolicyHookCommands({ ...input, protectedDirs: ['/h/org-requirements'] }).fileGuardCommand)
            .toBe(`"/n" "/s/tool_policy_file_guard.cjs" "/h/tool-policy.json" --dir "/h/org-requirements"${skillLocks}`);
    });

    // aplus specs/org-llm-endpoints r2 — the terminal's Claude reads settings files the daemon cannot pin live.
    it('puts an endpoint session routing above the settings files, without its token, and adds nothing otherwise', () => {
        const plain = buildHookSettings({ ...base, policy: resolveMachineLockdownPolicy({}) });
        expect(plain).not.toHaveProperty('env');
        const env = orgEndpointRoutingSettingsEnv({
            HAPPY_AI_AUTH_SOURCE: 'org-endpoint', ANTHROPIC_BASE_URL: 'https://llm.corp.example', ANTHROPIC_AUTH_TOKEN: 'corp-secret-token',
            ANTHROPIC_MODEL: 'corp-model', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', ANTHROPIC_API_KEY: '', UNRELATED: 'x',
        });
        expect(env).toEqual({ ANTHROPIC_BASE_URL: 'https://llm.corp.example', ANTHROPIC_MODEL: 'corp-model', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', ANTHROPIC_API_KEY: '' });
        const settings = buildHookSettings({ ...base, policy: resolveMachineLockdownPolicy({}), env });
        expect(settings).toMatchObject({ env, hooks: plain.hooks, permissions: plain.permissions });
        expect(JSON.stringify(settings)).not.toContain('corp-secret-token');
        expect(orgEndpointRoutingSettingsEnv({ HAPPY_AI_AUTH_SOURCE: 'org-bundle', ANTHROPIC_BASE_URL: 'https://x' })).toBeUndefined();
        expect(orgEndpointRoutingSettingsEnv({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' })).toBeUndefined();
    });
});
