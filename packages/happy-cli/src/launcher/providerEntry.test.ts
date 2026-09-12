import { describe, expect, it } from 'vitest';

import {
    applyManagedProviderPlan,
    assertProviderExecArguments,
    sanitizeProviderFailure,
} from './providerEntry';
import { planProviderLaunch } from './providerLaunch';

const PLAN = planProviderLaunch({
    agent: 'claude',
    model: 'claude-sonnet-5',
    brokerUrl: 'http://127.0.0.1:8731/',
    brokerToken: 'run-grant-token',
    brokerTools: ['read_file'],
    providerEnv: { PATH: '/usr/bin' },
});

describe('binding the plan into the existing claude run options', () => {
    it('replaces the boundary-bearing options and leaves the rest alone', () => {
        const existing = {
            mcpServers: { aplus: { type: 'http', url: 'https://elsewhere' } },
            allowedTools: ['Bash'],
            permissionMode: 'bypassPermissions',
            disallowedTools: ['Write'],
            hookSettingsPath: '/tmp/hooks.json',
        };
        const bound = applyManagedProviderPlan(existing, PLAN.env);
        // 경계를 정하는 것들은 계획이 이긴다.
        expect(bound.mcpServers).toEqual(PLAN.sdkOptions!.mcpServers);
        expect(bound.allowedTools).toEqual(PLAN.sdkOptions!.allowedTools);
        expect(bound.permissionMode).toBe('default');
        expect(bound.settingSources).toEqual([]);
        expect(bound.tools).toEqual([]);
        expect(bound.model).toBe('claude-sonnet-5');
        // 경계와 무관한 것은 그대로 둔다 — 기존 경로를 재설계하지 않는다.
        expect(bound.hookSettingsPath).toBe('/tmp/hooks.json');
        expect(bound.disallowedTools).toEqual(['Write']);
    });

    it('refuses to bind when the environment carries no plan', () => {
        expect(() => applyManagedProviderPlan({}, {})).toThrow(/no sdk options/);
    });
});

describe('provider failures carry no credentials', () => {
    it('redacts before the message leaves the process', () => {
        const detail = sanitizeProviderFailure(
            new Error('request failed: authorization: Bearer sk-live-abcdefghijklmnop token=hunter2'),
        );
        expect(detail).not.toContain('sk-live-abcdefghijklmnop');
        expect(detail).not.toContain('hunter2');
        expect(detail).toContain('[REDACTED]');
    });
});

describe('assertProviderExecArguments', () => {
    it('shouldAcceptAnEmptyExecLineForTheClaudeShape', () => {
        // Claude's plan carries no arguments: its options ride in the env.
        expect(() => assertProviderExecArguments([], {})).not.toThrow();
    });

    it('shouldRefuseArgumentsWhenThePlanBindsNone', () => {
        /*
         * An entry that ignored `argv` would let the generation script say one
         * thing while the provider ran with another, and neither side would
         * report it.
         */
        expect(() => assertProviderExecArguments(['-c', 'model_provider="other"'], {}))
            .toThrow(/do not match this run's plan/);
    });

    it('shouldAcceptAnExecLineThatMatchesTheCodexPlanExactly', () => {
        // A real plan, so the canonical check the product performs is the one
        // being satisfied rather than a shape invented here.
        const codex = planProviderLaunch({
            agent: 'codex',
            model: 'gpt-5',
            brokerUrl: 'http://127.0.0.1:8731/',
            brokerToken: 'run-grant-token',
            brokerTools: ['read_file'],
            providerEnv: { PATH: '/usr/bin' },
            codexHome: '/workspace/.codex',
        });
        expect(() => assertProviderExecArguments(codex.args, codex.env)).not.toThrow();
        expect(codex.args.length).toBeGreaterThan(0);
    });

    it('shouldRefuseAnExecLineThatDiffersFromThePlanTheEnvironmentBinds', () => {
        const codex = planProviderLaunch({
            agent: 'codex',
            model: 'gpt-5',
            brokerUrl: 'http://127.0.0.1:8731/',
            brokerToken: 'run-grant-token',
            brokerTools: ['read_file'],
            providerEnv: { PATH: '/usr/bin' },
            codexHome: '/workspace/.codex',
        });
        // A trailing `-c` wins in codex, so an appended one reverses the plan.
        expect(() => assertProviderExecArguments(
            [...codex.args, '-c', 'features.hooks=true'], codex.env,
        )).toThrow(/do not match this run's plan/);
    });

    it('shouldRefuseAnUnreadableCodexPlanRatherThanTreatItAsNoArguments', () => {
        /*
         * Falling back to the claude shape here would accept an empty exec
         * line for a run whose plan cannot be read at all.
         */
        expect(() => assertProviderExecArguments([], { SAYCODE_PROVIDER_CODEX_ARGS: 'not json' }))
            .toThrow();
    });
});
