import { describe, expect, it } from 'vitest';

import {
    MandatorySandboxError,
    resolveSandboxInitFailureAction,
    resolveSandboxPolicyMode,
} from './sandboxPolicy';

describe('resolveSandboxPolicyMode', () => {
    it('treats a machine without policy as owner-choice', () => {
        expect(resolveSandboxPolicyMode(undefined)).toBe('owner-choice');
        expect(resolveSandboxPolicyMode({})).toBe('owner-choice');
    });

    it('reads an explicit mandatory policy', () => {
        expect(resolveSandboxPolicyMode({ sandboxPolicy: { mode: 'mandatory' } })).toBe('mandatory');
    });

    it('reads an explicit owner-choice policy', () => {
        expect(resolveSandboxPolicyMode({ sandboxPolicy: { mode: 'owner-choice' } })).toBe('owner-choice');
    });

    // 같은 UID 에서 정책 파일은 공유 머신 운영자의 선언이다. 값이 깨졌을 때
    // owner-choice 로 읽으면 파일 한 글자를 망치는 것이 격리 해제 수단이 된다.
    it('fails closed to mandatory when a present policy cannot be understood', () => {
        expect(resolveSandboxPolicyMode({ sandboxPolicy: { mode: 'whatever' } })).toBe('mandatory');
        expect(resolveSandboxPolicyMode({ sandboxPolicy: {} })).toBe('mandatory');
        expect(resolveSandboxPolicyMode({ sandboxPolicy: null as never })).toBe('mandatory');
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
