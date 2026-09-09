import { describe, expect, it } from 'vitest';

import { MANAGED_TOOL_BROKER_NAME, assertToolExecutorEnv, buildClaudeToolPolicy } from './claudeToolPolicy';

const BASE = { brokerUrl: 'http://127.0.0.1:8731', brokerToken: 'run-grant-token', env: { PATH: '/usr/bin' } };

describe('claude tool policy', () => {
    it('turns every built-in tool off and leaves only the trusted broker', () => {
        const policy = buildClaudeToolPolicy(BASE);
        expect(policy.tools).toEqual([]);
        expect(Object.keys(policy.mcpServers)).toEqual([MANAGED_TOOL_BROKER_NAME]);
        expect(policy.mcpServers[MANAGED_TOOL_BROKER_NAME]).toEqual({
            type: 'http',
            url: 'http://127.0.0.1:8731',
            headers: { authorization: 'Bearer run-grant-token' },
        });
    });

    it('does not use a permission prompt as the boundary', () => {
        // 경계는 UID 다. 프롬프트는 같은 프로세스 안의 정책일 뿐이다.
        expect(buildClaudeToolPolicy(BASE).permissionMode).toBe('default');
    });

    it('the broker must be reachable only over loopback', () => {
        for (const brokerUrl of [
            'https://example.com', 'http://10.0.0.5:8731', 'http://user:pw@127.0.0.1:8731',
            'http://127.0.0.1:8731?x=1', 'not-a-url',
        ]) {
            expect(() => buildClaudeToolPolicy({ ...BASE, brokerUrl })).toThrow();
        }
        expect(() => buildClaudeToolPolicy({ ...BASE, brokerUrl: 'http://localhost:1' })).not.toThrow();
    });

    it('keeps the approved gateway credential — that is how the provider is paid for', () => {
        // `applyManagedGatewayEnvironment` 가 이 run 의 capability 를 여기에 싣는다.
        // 이름만 보고 막으면 SDK 의 gateway 경로가 끊긴다.
        const env = {
            PATH: '/usr/bin',
            ANTHROPIC_BASE_URL: 'https://happy.example/api/cloud/gateway/anthropic',
            ANTHROPIC_AUTH_TOKEN: 'capability-for-this-run',
        };
        expect(buildClaudeToolPolicy({ ...BASE, env }).env).toMatchObject({
            ANTHROPIC_AUTH_TOKEN: 'capability-for-this-run',
        });
    });

    it('refuses credentials that were not minted for this run', () => {
        for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'HAPPY_HOME_DIR']) {
            expect(() => buildClaudeToolPolicy({ ...BASE, env: { ...BASE.env, [key]: 'x' } }))
                .toThrow(/provider env must not carry/);
        }
        expect(() => buildClaudeToolPolicy({
            ...BASE, env: { ...BASE.env, HAPPY_MANAGED_RUNTIME: '1' },
        })).toThrow(/provider env must not carry/);
    });

    it('the tool executor gets no provider credential at all — not even this run\'s', () => {
        for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) {
            expect(() => assertToolExecutorEnv({ PATH: '/usr/bin', [key]: 'x' }))
                .toThrow(/tool executor env must not carry/);
        }
        expect(() => assertToolExecutorEnv({ PATH: '/usr/bin', HOME: '/home/tool' })).not.toThrow();
    });

    it('copies the env instead of aliasing the caller object', () => {
        const env = { PATH: '/usr/bin' };
        const policy = buildClaudeToolPolicy({ ...BASE, env });
        env.PATH = '/mutated';
        expect(policy.env.PATH).toBe('/usr/bin');
    });
});

describe('broker credential', () => {
    it('carries the run bearer so the broker can authenticate the SDK', () => {
        const policy = buildClaudeToolPolicy({
            brokerUrl: 'http://127.0.0.1:8731/',
            brokerToken: 'run-grant-token',
            env: { PATH: '/usr/bin' },
        });
        // broker 는 loopback 이라고 인증을 생략하지 않는다. 정책이 자격을
        // 싣지 않으면 제품 조합은 `tools/list` 부터 거부당한다.
        expect(policy.mcpServers['saycode-broker']).toEqual({
            type: 'http',
            url: 'http://127.0.0.1:8731/',
            headers: { authorization: 'Bearer run-grant-token' },
        });
    });

    it('refuses to build a policy without a broker token', () => {
        for (const brokerToken of ['', '   ']) {
            expect(() => buildClaudeToolPolicy({
                brokerUrl: 'http://127.0.0.1:8731/', brokerToken, env: {},
            })).toThrow(/broker token/);
        }
    });
});

describe('permission and settings contract', () => {
    it('pre-authorizes exactly this run’s broker tools and nothing else', () => {
        const policy = buildClaudeToolPolicy({ ...BASE, brokerTools: ['read_file', 'list_dir'] });
        // 경계는 UID 다. 그래도 SDK 는 도구마다 허가를 요구하므로, 이 run 이
        // 쓸 수 있는 broker 도구만 이름으로 미리 허가한다. bypass 는 쓰지 않는다.
        expect(policy.allowedTools).toEqual([
            'mcp__saycode-broker__read_file',
            'mcp__saycode-broker__list_dir',
        ]);
        expect(policy.permissionMode).toBe('default');
    });

    it('loads no filesystem settings', () => {
        // `settingSources` 를 생략하면 CLI 기본대로 사용자/프로젝트 설정과
        // CLAUDE.md 까지 읽는다. 관리 런타임에서 그것은 신뢰하지 않는 입력이다.
        expect(buildClaudeToolPolicy(BASE).settingSources).toEqual([]);
    });
});
