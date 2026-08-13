import { describe, it, expect } from 'vitest';
import { decideResumeCredentials, extractTokenSubject, tokensShareIdentity } from './resumeCredentials';

// 2026-07-23 운영 사고: resume 된 child 가 preflight 와 다른 계정의
// 자격증명을 읽어 세션 sync 가 404 로 종료됨. 두 가지 경로가 있었다:
//  (a) user-credential 세션 — spawn 시 HAPPY_HOME_DIR 로 스테이징된
//      자격증명이 child 종료 시 삭제되고, resume 시 복원되지 않아 child 가
//      데몬 기본 자격증명으로 떠버림.
//  (b) 데몬 자격증명 교체 — 데몬은 시작 시점의 토큰을 메모리에 들고
//      preflight 하는데, 그 사이 `happy auth login` 이 디스크 access.key 를
//      다른 계정으로 바꿔 child 가 다른 계정 토큰을 읽음.
// resume 전에 "child 가 실제로 읽을 자격증명"을 결정/검증하고, 계정이
// 달라졌으면 child 를 띄우지 않는다.

function fakeJwt(payload: Record<string, unknown>): string {
    const encode = (obj: Record<string, unknown>) =>
        Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

describe('extractTokenSubject', () => {
    it('extracts the account subject from a JWT-shaped token', () => {
        expect(extractTokenSubject(fakeJwt({ sub: 'account-a' }))).toBe('account-a');
        expect(extractTokenSubject(fakeJwt({ userId: 'account-b' }))).toBe('account-b');
        expect(extractTokenSubject(fakeJwt({ uid: 'account-c' }))).toBe('account-c');
    });

    it('returns null for opaque or malformed tokens', () => {
        expect(extractTokenSubject('opaque-token')).toBeNull();
        expect(extractTokenSubject('a.not-base64-json!!.c')).toBeNull();
        expect(extractTokenSubject(null)).toBeNull();
        expect(extractTokenSubject(undefined)).toBeNull();
    });
});

describe('tokensShareIdentity', () => {
    it('accepts refreshed JWTs for the same account and rejects another account', () => {
        expect(tokensShareIdentity(
            fakeJwt({ sub: 'account-a', iat: 1 }),
            fakeJwt({ sub: 'account-a', iat: 2 }),
        )).toBe(true);
        expect(tokensShareIdentity(
            fakeJwt({ sub: 'account-a' }),
            fakeJwt({ sub: 'account-b' }),
        )).toBe(false);
    });

    it('requires exact equality for opaque tokens', () => {
        expect(tokensShareIdentity('opaque-1', 'opaque-1')).toBe(true);
        expect(tokensShareIdentity('opaque-1', 'opaque-2')).toBe(false);
    });
});

describe('decideResumeCredentials', () => {
    it('restages user credentials when the staged access.key is still readable (경로 a 수정)', () => {
        const decision = decideResumeCredentials({
            trackedUserHomeDir: '/tmp/happy-session-x',
            stagedToken: 'user-token',
            daemonToken: 'daemon-token',
            diskToken: 'daemon-token',
        });
        expect(decision).toEqual({
            kind: 'user-staged',
            homeDir: '/tmp/happy-session-x',
            token: 'user-token',
        });
    });

    it('refuses to resume a user-credential session whose staged credentials are gone', () => {
        const decision = decideResumeCredentials({
            trackedUserHomeDir: '/tmp/happy-session-x',
            stagedToken: null,
            daemonToken: 'daemon-token',
            diskToken: 'daemon-token',
        });
        expect(decision.kind).toBe('refuse');
    });

    it('uses the on-disk daemon credentials when they still belong to the same account', () => {
        // 같은 계정의 새 토큰(재로그인)은 유효 — subject 가 같으면 진행.
        const diskToken = fakeJwt({ sub: 'account-a', iat: 2 });
        const decision = decideResumeCredentials({
            daemonToken: fakeJwt({ sub: 'account-a', iat: 1 }),
            diskToken,
        });
        // preflight 는 child 가 실제로 읽을 디스크 토큰으로 해야 한다.
        expect(decision).toMatchObject({ kind: 'daemon', token: diskToken });
    });

    it('refuses when the on-disk credentials switched to a different account (경로 b 수정)', () => {
        const decision = decideResumeCredentials({
            daemonToken: fakeJwt({ sub: 'account-a' }),
            diskToken: fakeJwt({ sub: 'account-b' }),
        });
        expect(decision).toMatchObject({
            kind: 'refuse',
            reason: expect.stringMatching(/account/i),
        });
    });

    it('falls back to exact token equality when subjects are not decodable', () => {
        expect(decideResumeCredentials({
            daemonToken: 'opaque-1',
            diskToken: 'opaque-1',
        }).kind).toBe('daemon');
        expect(decideResumeCredentials({
            daemonToken: 'opaque-1',
            diskToken: 'opaque-2',
        }).kind).toBe('refuse');
    });

    it('refuses when the disk credentials are unreadable', () => {
        const decision = decideResumeCredentials({
            daemonToken: 'daemon-token',
            diskToken: null,
        });
        expect(decision.kind).toBe('refuse');
    });
});
