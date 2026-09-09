import { describe, expect, it } from 'vitest';

import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';

import { planProviderLaunch, readProviderSdkOptions } from './providerLaunch';

const BROKER = 'http://127.0.0.1:8731';

describe('provider launch plan (the API B3 consumes)', () => {
    it('always starts in the runtime project root — the caller cannot pick it', () => {
        for (const agent of ['claude', 'codex'] as const) {
            const plan = planProviderLaunch({
                brokerToken: 'run-grant-token',
                agent, brokerUrl: BROKER, providerEnv: { PATH: '/usr/bin' },
                codexHome: '/run/saycode/codex',
            });
            expect(plan.cwd).toBe(MANAGED_PROJECT_ROOT);
            expect(plan.cwd).toBe('/workspace/project');
        }
    });

    it('claude gets no built-in tools and exactly one trusted broker', () => {
        const plan = planProviderLaunch({
            brokerToken: 'run-grant-token',
            agent: 'claude', brokerUrl: BROKER, providerEnv: { PATH: '/usr/bin' },
        });
        expect(plan.sdkOptions?.tools).toEqual([]);
        expect(Object.values(plan.sdkOptions?.mcpServers ?? {})).toEqual([{
            type: 'http',
            url: BROKER,
            // 자격 없이 넘기면 broker 가 `tools/list` 부터 거부한다.
            headers: { authorization: 'Bearer run-grant-token' },
        }]);
        expect(plan.args).toEqual([]);
    });

    it('carries this run\'s gateway capability into the provider', () => {
        const plan = planProviderLaunch({
            brokerToken: 'run-grant-token',
            agent: 'claude', brokerUrl: BROKER,
            providerEnv: {
                PATH: '/usr/bin',
                ANTHROPIC_BASE_URL: 'https://happy.example/api/cloud/gateway/anthropic',
                ANTHROPIC_AUTH_TOKEN: 'capability-for-this-run',
            },
        });
        expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe('capability-for-this-run');
    });

    it('refuses credentials that were not minted for this run', () => {
        expect(() => planProviderLaunch({
            brokerToken: 'run-grant-token',
            agent: 'claude', brokerUrl: BROKER,
            providerEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'someone-elses' },
        })).toThrow(/must not carry/);
    });

    it('codex gets a run-private CODEX_HOME and a read-only environments file', () => {
        const plan = planProviderLaunch({
            brokerToken: 'run-grant-token',
            agent: 'codex', brokerUrl: BROKER,
            providerEnv: { PATH: '/usr/bin', OPENAI_API_KEY: 'capability-for-this-run' },
            codexHome: '/run/saycode/codex',
        });
        expect(plan.env.CODEX_HOME).toBe('/run/saycode/codex');
        expect(plan.env.OPENAI_API_KEY).toBe('capability-for-this-run');
        expect(plan.files).toHaveLength(1);
        expect(plan.files[0]!.path).toBe('/run/saycode/codex/environments.toml');
        expect(plan.files[0]!.contents).toContain('environments = []');
        // provider 가 자기 정책을 다시 쓸 수 있으면 정책이 아니다.
        expect(plan.files[0]!.mode).toBe(0o444);
    });

    it('codex without a run-private home is refused', () => {
        expect(() => planProviderLaunch({
            brokerToken: 'run-grant-token',
            agent: 'codex', brokerUrl: BROKER, providerEnv: { PATH: '/usr/bin' },
        })).toThrow(/run-private codexHome/);
    });

    it('the broker must be on loopback for either agent', () => {
        for (const agent of ['claude', 'codex'] as const) {
            expect(() => planProviderLaunch({
                brokerToken: 'run-grant-token',
                agent, brokerUrl: 'https://example.com',
                providerEnv: { PATH: '/usr/bin' }, codexHome: '/run/saycode/codex',
            })).toThrow();
        }
    });
});

describe('the plan carries its own SDK options', () => {
    it('binds the claude sdk options into the provider environment', () => {
        const plan = planProviderLaunch({
            agent: 'claude', brokerUrl: BROKER, brokerToken: 'run-grant-token',
            brokerTools: ['read_file'], providerEnv: { PATH: '/usr/bin' },
        });
        // 실행 경계에서 계획과 옵션이 갈라지면 안 된다. 옵션은 계획의 env 에
        // 실려 그 프로세스에만 간다 — 바깥에서 채워 넣을 자리를 남기지 않는다.
        expect(JSON.parse(plan.env.SAYCODE_PROVIDER_SDK_OPTIONS)).toEqual(plan.sdkOptions);
    });

    it('does not put SDK options into a codex environment', () => {
        const plan = planProviderLaunch({
            agent: 'codex', brokerUrl: BROKER, brokerToken: 'run-grant-token',
            providerEnv: { PATH: '/usr/bin' }, codexHome: '/run/codex',
        });
        expect(plan.sdkOptions).toBeNull();
        expect(plan.env.SAYCODE_PROVIDER_SDK_OPTIONS).toBeUndefined();
    });
});

describe('reading the plan’s sdk options back', () => {
    it('returns exactly what the plan put there', () => {
        const plan = planProviderLaunch({
            agent: 'claude', brokerUrl: BROKER, brokerToken: 'run-grant-token',
            brokerTools: ['read_file'], providerEnv: { PATH: '/usr/bin' },
        });
        expect(readProviderSdkOptions(plan.env)).toEqual(plan.sdkOptions);
    });

    it('refuses an environment that carries no options or a broken one', () => {
        expect(() => readProviderSdkOptions({})).toThrow(/no sdk options/);
        expect(() => readProviderSdkOptions({ SAYCODE_PROVIDER_SDK_OPTIONS: 'not json' }))
            .toThrow(/unreadable/);
    });

    it('refuses options that lost the boundary', () => {
        const plan = planProviderLaunch({
            agent: 'claude', brokerUrl: BROKER, brokerToken: 'run-grant-token',
            brokerTools: ['read_file'], providerEnv: { PATH: '/usr/bin' },
        });
        for (const broken of [
            { ...plan.sdkOptions, tools: ['Bash'] },
            { ...plan.sdkOptions, permissionMode: 'bypassPermissions' },
            { ...plan.sdkOptions, settingSources: ['user'] },
            { ...plan.sdkOptions, mcpServers: {} },
            { ...plan.sdkOptions, allowedTools: [] },
        ]) {
            expect(() => readProviderSdkOptions({
                SAYCODE_PROVIDER_SDK_OPTIONS: JSON.stringify(broken),
            })).toThrow();
        }
    });
});
