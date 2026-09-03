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
