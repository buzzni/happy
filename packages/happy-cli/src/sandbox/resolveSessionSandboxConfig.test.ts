import { describe, expect, it } from 'vitest';

import { resolveSessionSandboxConfig } from './resolveSessionSandboxConfig';

// 2026-08-28 프로덕션 — agent=codex 로 도는 pr_review.v1 워커가 lifecycle 콜백을
// 전부 놓쳤다(curl: (6) Could not resolve host). daemon 은 스폰할 때
// HAPPY_PROJECT_SANDBOX_CONFIG 로 networkMode:'allowed' 를 넘겼는데, Codex 경로는
// 그 env 를 읽지 않고 로컬 settings.sandboxConfig 만 봤다. 그 머신엔 값이 없어
// 샌드박스가 아예 초기화되지 않았고, sandboxManagedByHappy=false 가 되면서
// --permission-mode read-only 가 Codex 네이티브 readOnly 정책(네트워크 없음)으로
// 떨어졌다. 배선 누락이지 인프라 문제가 아니었다.
const PROJECT_ENV = JSON.stringify({
    enabled: true,
    sessionIsolation: 'custom',
    customWritePaths: [],
    denyReadPaths: ['~/.ssh'],
    extraWritePaths: ['/tmp'],
    denyWritePaths: ['.env'],
    networkMode: 'allowed',
    allowedDomains: [],
    deniedDomains: [],
    allowLocalBinding: false,
});

describe('resolveSessionSandboxConfig', () => {
    it('preserves a project Git config grant through schema parsing', () => {
        const resolved = resolveSessionSandboxConfig({
            noSandbox: false,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({ enabled: true, allowGitConfig: true }) },
            settings: undefined,
        });
        expect(resolved?.allowGitConfig).toBe(true);
    });

    it('keeps an explicit project disable ahead of enabled machine settings', () => {
        const resolved = resolveSessionSandboxConfig({
            noSandbox: false,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({ enabled: false }) },
            settings: { sandboxConfig: { enabled: true } as never },
        });
        expect(resolved?.enabled).toBe(false);
    });

    it('takes the daemon-injected project config over local settings', () => {
        const resolved = resolveSessionSandboxConfig({
            noSandbox: false,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: PROJECT_ENV },
            settings: { sandboxConfig: { enabled: true, networkMode: 'blocked' } as never },
        });

        expect(resolved?.networkMode).toBe('allowed');
        expect(resolved?.enabled).toBe(true);
    });

    it('resolves the daemon config even when the machine has no local settings', () => {
        // 사고 당시 이 머신의 상태 그대로다.
        const resolved = resolveSessionSandboxConfig({
            noSandbox: false,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: PROJECT_ENV },
            settings: undefined,
        });

        expect(resolved?.networkMode).toBe('allowed');
    });

    it('falls back to local settings when the daemon injected nothing', () => {
        const local = { enabled: true, networkMode: 'blocked' } as never;

        expect(resolveSessionSandboxConfig({ noSandbox: false, env: {}, settings: { sandboxConfig: local } }))
            .toBe(local);
    });

    it('honours --no-sandbox over both sources', () => {
        expect(resolveSessionSandboxConfig({
            noSandbox: true,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: PROJECT_ENV },
            settings: { sandboxConfig: { enabled: true } as never },
        })).toBeUndefined();
    });

    it('falls back to local settings rather than crashing on a malformed injection', () => {
        // 깨진 env 때문에 세션 자체가 죽으면 안 된다.
        const local = { enabled: true, networkMode: 'blocked' } as never;

        expect(resolveSessionSandboxConfig({
            noSandbox: false,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: '{not json' },
            settings: { sandboxConfig: local },
        })).toBe(local);
    });

    it('fails closed when an explicit checkpoint block is malformed', () => {
        expect(() => resolveSessionSandboxConfig({
            noSandbox: false,
            env: {
                HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({
                    checkpointProtection: { secretPatterns: ['.env*'] },
                }),
            },
            settings: { sandboxConfig: { enabled: true, networkMode: 'blocked' } as never },
        })).toThrow();
    });

    it('returns undefined when neither source has anything', () => {
        expect(resolveSessionSandboxConfig({ noSandbox: false, env: {}, settings: undefined }))
            .toBeUndefined();
    });
});

// 공유(비신뢰) 실행 머신의 계약. 개인 머신(owner-choice)의 위 동작은 그대로 두고,
// mandatory 머신에서만 "격리 없이 진행"을 없앤다 — 조용히 물러나는 대신 던진다.
describe('resolveSessionSandboxConfig on a mandatory machine', () => {
    const mandatory = { policyMode: 'mandatory' } as const;

    it('refuses --no-sandbox instead of dropping isolation', () => {
        expect(() => resolveSessionSandboxConfig({
            ...mandatory,
            noSandbox: true,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: PROJECT_ENV },
            settings: { sandboxConfig: { enabled: true } as never },
        })).toThrow(/no-sandbox-flag/);
    });

    it('refuses an injected disable', () => {
        expect(() => resolveSessionSandboxConfig({
            ...mandatory,
            noSandbox: false,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({ enabled: false }) },
            settings: { sandboxConfig: { enabled: true } as never },
        })).toThrow(/disabled-config/);
    });

    it('refuses a locally disabled machine config', () => {
        expect(() => resolveSessionSandboxConfig({
            ...mandatory,
            noSandbox: false,
            env: {},
            settings: { sandboxConfig: { enabled: false } as never },
        })).toThrow(/disabled-config/);
    });

    it('does not fall back to local settings when the injection is malformed', () => {
        expect(() => resolveSessionSandboxConfig({
            ...mandatory,
            noSandbox: false,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: '{not json' },
            settings: { sandboxConfig: { enabled: true, networkMode: 'blocked' } as never },
        })).toThrow(/malformed-injection/);
    });

    it('does not fall back to local settings when the injection fails validation', () => {
        expect(() => resolveSessionSandboxConfig({
            ...mandatory,
            noSandbox: false,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: JSON.stringify({ networkMode: 'sideways' }) },
            settings: { sandboxConfig: { enabled: true } as never },
        })).toThrow(/malformed-injection/);
    });

    it('refuses a session that has no sandbox config at all', () => {
        expect(() => resolveSessionSandboxConfig({
            ...mandatory,
            noSandbox: false,
            env: {},
            settings: undefined,
        })).toThrow(/missing-config/);
    });

    it('returns the injected config unchanged when isolation is intact', () => {
        const resolved = resolveSessionSandboxConfig({
            ...mandatory,
            noSandbox: false,
            env: { HAPPY_PROJECT_SANDBOX_CONFIG: PROJECT_ENV },
            settings: undefined,
        });
        expect(resolved?.enabled).toBe(true);
        expect(resolved?.networkMode).toBe('allowed');
    });
});
