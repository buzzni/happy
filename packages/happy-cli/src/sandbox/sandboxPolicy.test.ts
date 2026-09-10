import { describe, expect, it } from 'vitest';

import {
    MACHINE_SANDBOX_POLICY_FILE,
    MandatorySandboxError,
    readMachineSandboxPolicyMode,
    resolveEffectiveSandboxPolicyMode,
    resolveSandboxInitFailureAction,
    sandboxTrustFloorPaths,
} from './sandboxPolicy';

function reader(files: Record<string, string | Error>) {
    return (path: string): string => {
        const value = files[path];
        if (value === undefined) {
            const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        }
        if (value instanceof Error) throw value;
        return value;
    };
}

describe('readMachineSandboxPolicyMode', () => {
    // 개인 머신에는 이 파일이 없다. 정책의 부재가 owner-choice 다.
    it('treats an absent policy file as owner-choice', () => {
        expect(readMachineSandboxPolicyMode({ readFile: reader({}) })).toBe('owner-choice');
    });

    it('reads an explicit mandatory policy', () => {
        expect(readMachineSandboxPolicyMode({
            readFile: reader({ [MACHINE_SANDBOX_POLICY_FILE]: '{"mode":"mandatory"}' }),
        })).toBe('mandatory');
    });

    it('reads an explicit owner-choice policy', () => {
        expect(readMachineSandboxPolicyMode({
            readFile: reader({ [MACHINE_SANDBOX_POLICY_FILE]: '{"mode":"owner-choice"}' }),
        })).toBe('owner-choice');
    });

    // 파일을 깨뜨리거나 읽기를 막는 것이 격리 해제 수단이 되면 안 된다.
    // ENOENT 만 "정책 없음"이고, 그 밖의 실패는 전부 닫는다.
    it('fails closed when the policy file exists but cannot be understood', () => {
        expect(readMachineSandboxPolicyMode({
            readFile: reader({ [MACHINE_SANDBOX_POLICY_FILE]: '{not json' }),
        })).toBe('mandatory');
        expect(readMachineSandboxPolicyMode({
            readFile: reader({ [MACHINE_SANDBOX_POLICY_FILE]: '{"mode":"whatever"}' }),
        })).toBe('mandatory');
    });

    it('fails closed when the policy file cannot be read for any other reason', () => {
        const denied = new Error('EACCES') as NodeJS.ErrnoException;
        denied.code = 'EACCES';
        expect(readMachineSandboxPolicyMode({
            readFile: reader({ [MACHINE_SANDBOX_POLICY_FILE]: denied }),
        })).toBe('mandatory');
    });
});

describe('resolveEffectiveSandboxPolicyMode', () => {
    // env 는 신뢰 소스가 아니다 — 올리는 방향으로만 반영한다.
    it('lets any source raise the requirement to mandatory', () => {
        expect(resolveEffectiveSandboxPolicyMode({ machineMode: 'owner-choice', envValue: 'mandatory' }))
            .toBe('mandatory');
        expect(resolveEffectiveSandboxPolicyMode({ machineMode: 'mandatory', envValue: undefined }))
            .toBe('mandatory');
    });

    it('never lets env lower a mandatory machine', () => {
        expect(resolveEffectiveSandboxPolicyMode({ machineMode: 'mandatory', envValue: 'owner-choice' }))
            .toBe('mandatory');
        expect(resolveEffectiveSandboxPolicyMode({ machineMode: 'mandatory', envValue: 'garbage' }))
            .toBe('mandatory');
    });

    it('stays owner-choice when nothing requires isolation', () => {
        expect(resolveEffectiveSandboxPolicyMode({ machineMode: 'owner-choice', envValue: undefined }))
            .toBe('owner-choice');
    });
});

describe('sandboxTrustFloorPaths', () => {
    // 데몬은 --home 으로 .happy_remote / .happy-dev 를 쓴다. ~/.happy 하나만
    // 막으면 실제 데몬 홈이 그대로 읽힌다.
    it('covers every happy home that exists in the home directory', () => {
        const paths = sandboxTrustFloorPaths({
            homeDir: '/home/dev',
            listHomeEntries: () => ['.happy', '.happy_remote', '.happy-dev', '.ssh', 'workspace'],
        });

        expect(paths).toContain('/home/dev/.happy');
        expect(paths).toContain('/home/dev/.happy_remote');
        expect(paths).toContain('/home/dev/.happy-dev');
        expect(paths).not.toContain('/home/dev/.ssh');
        expect(paths).not.toContain('/home/dev/workspace');
    });

    it('adds this process happy home even when it is outside the home directory', () => {
        const paths = sandboxTrustFloorPaths({
            homeDir: '/home/dev',
            listHomeEntries: () => [],
            daemonHappyHomeDir: '/srv/agent/.happy_remote',
        });

        expect(paths).toContain('/srv/agent/.happy_remote');
    });

    it('does not fail when the home directory cannot be listed', () => {
        expect(sandboxTrustFloorPaths({
            homeDir: '/home/dev',
            listHomeEntries: () => { throw new Error('EACCES'); },
            daemonHappyHomeDir: '/home/dev/.happy',
        })).toEqual(['/home/dev/.happy']);
    });
});

describe('resolveSandboxInitFailureAction', () => {
    it('lets an owner-choice machine keep running without the sandbox', () => {
        expect(resolveSandboxInitFailureAction('owner-choice')).toBe('continue');
    });

    it('refuses to start an unsandboxed child on a mandatory machine', () => {
        expect(resolveSandboxInitFailureAction('mandatory')).toBe('abort');
    });
});

describe('MandatorySandboxError', () => {
    it('carries the reason so the session can report why it refused', () => {
        const error = new MandatorySandboxError('no-sandbox-flag');
        expect(error).toBeInstanceOf(Error);
        expect(error.reason).toBe('no-sandbox-flag');
        expect(error.message).toContain('no-sandbox-flag');
    });
});
