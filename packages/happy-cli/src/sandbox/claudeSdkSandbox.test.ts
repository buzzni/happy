import { describe, expect, it } from 'vitest';

import { configuration } from '@/configuration';
import type { SandboxConfig } from '@/persistence';
import { buildClaudeRemoteSandboxSettings, resolveClaudeRemoteSandbox } from './claudeSdkSandbox';

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        enabled: true,
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: [],
        extraWritePaths: ['/tmp'],
        denyWritePaths: [],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    };
}

describe('buildClaudeRemoteSandboxSettings', () => {
    // remote 는 daemon 이 띄우는 기본 모드다. 여기에 SDK sandbox 를 채우지 않으면
    // sandboxConfig.enabled 는 격리를 주지 않고 bypassPermissions 만 켜는 값이 된다.
    it('builds SDK sandbox settings for a mandatory remote session', () => {
        const settings = buildClaudeRemoteSandboxSettings({
            sandboxConfig: config(),
            sessionPath: '/tmp/session-a',
            policyMode: 'mandatory',
        });

        expect(settings?.enabled).toBe(true);
        expect(settings?.filesystem?.allowWrite).toContain('/tmp/session-a');
    });

    it('fails closed on a mandatory machine — no unsandboxed commands, no silent downgrade', () => {
        const settings = buildClaudeRemoteSandboxSettings({
            sandboxConfig: config(),
            sessionPath: '/tmp/session-a',
            policyMode: 'mandatory',
        });

        expect(settings?.failIfUnavailable).toBe(true);
        expect(settings?.allowUnsandboxedCommands).toBe(false);
        // 세션이 비운 denyRead 위에 신뢰 floor 가 얹혀야 한다.
        expect(settings?.filesystem?.denyRead).toContain(configuration.daemonHappyHomeDir);
    });

    // 개인 머신의 remote 는 지금까지 checkpoint 세션에서만 SDK 샌드박스를 켰다.
    // 여기서 일반 세션까지 켜면 개인 사용자의 기존 동작이 바뀐다 — mandatory 에서만
    // 새 경계를 건다.
    it('leaves an owner-choice remote session exactly as before', () => {
        expect(buildClaudeRemoteSandboxSettings({
            sandboxConfig: config(),
            sessionPath: '/tmp/session-a',
            policyMode: 'owner-choice',
        })).toBeUndefined();
    });

    it('returns nothing on a personal machine regardless of the session config', () => {
        for (const sandboxConfig of [undefined, config({ enabled: false }), config()]) {
            expect(buildClaudeRemoteSandboxSettings({
                sandboxConfig,
                sessionPath: '/tmp/session-a',
                policyMode: 'owner-choice',
            })).toBeUndefined();
        }
    });

    // mandatory 인데 sandbox 가 없는 조합은 resolver 가 이미 거절한다. 그래도
    // 이 경계에서 조용히 undefined 를 내보내면 remote 가 무경계로 뜬다.
    it('refuses to produce an unsandboxed remote session on a mandatory machine', () => {
        expect(() => buildClaudeRemoteSandboxSettings({
            sandboxConfig: undefined,
            sessionPath: '/tmp/session-a',
            policyMode: 'mandatory',
        })).toThrow(/missing-config/);
        expect(() => buildClaudeRemoteSandboxSettings({
            sandboxConfig: config({ enabled: false }),
            sessionPath: '/tmp/session-a',
            policyMode: 'mandatory',
        })).toThrow(/disabled-config/);
    });
});

describe('resolveClaudeRemoteSandbox', () => {
    // checkpoint 보호 세션은 자기 workspace 경로로 이미 만들어 둔 설정이 있다.
    it('keeps a checkpoint-built sandbox as is', () => {
        const checkpointSandbox = { enabled: true, failIfUnavailable: true } as const;

        expect(resolveClaudeRemoteSandbox({
            checkpointSandbox,
            sandboxConfig: config(),
            sessionPath: '/tmp/session-a',
            policyMode: 'mandatory',
        })).toBe(checkpointSandbox);
    });

    // 이 계약이 핵심이다: mandatory 머신에서 enabled 인 세션이 경계 없이 remote 로
    // 뜨면 bypassPermissions 만 켜진 세션이 된다.
    it('never returns an empty sandbox for an enabled session on a mandatory machine', () => {
        const settings = resolveClaudeRemoteSandbox({
            checkpointSandbox: undefined,
            sandboxConfig: config(),
            sessionPath: '/tmp/session-a',
            policyMode: 'mandatory',
        });

        expect(settings?.enabled).toBe(true);
        expect(settings?.failIfUnavailable).toBe(true);
        expect(settings?.allowUnsandboxedCommands).toBe(false);
    });

    it('keeps a personal machine remote session unchanged', () => {
        expect(resolveClaudeRemoteSandbox({
            checkpointSandbox: undefined,
            sandboxConfig: config(),
            sessionPath: '/tmp/session-a',
            policyMode: 'owner-choice',
        })).toBeUndefined();
    });

    it('leaves a session without sandbox config alone on a personal machine', () => {
        expect(resolveClaudeRemoteSandbox({
            checkpointSandbox: undefined,
            sandboxConfig: undefined,
            sessionPath: '/tmp/session-a',
            policyMode: 'owner-choice',
        })).toBeUndefined();
    });

    it('refuses a boundary-less remote session on a mandatory machine', () => {
        expect(() => resolveClaudeRemoteSandbox({
            checkpointSandbox: undefined,
            sandboxConfig: undefined,
            sessionPath: '/tmp/session-a',
            policyMode: 'mandatory',
        })).toThrow(/missing-config/);
    });
});
