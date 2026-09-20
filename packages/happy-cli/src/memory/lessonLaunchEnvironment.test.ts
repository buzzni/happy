import { describe, expect, it, vi } from 'vitest';

import { applyLessonLaunchEnvironment, lessonCallerSharesIdentity } from './lessonLaunchEnvironment';
import { LESSON_OWNER_ENV, LESSON_HOST_DISABLED_ENV } from './lessonOwnerMarker';
import { LESSON_DAEMON_HOME_ENV } from './lessonSessionHost';
import { prepareMcpChildEnvironment } from '@/daemon/mcpCallerGrantEnvelope';

function jwt(payload: Record<string, unknown>): string {
    const encode = (value: Record<string, unknown>) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none' })}.${encode(payload)}.sig`;
}

/** An installed package that states the capability the marker needs. */
const load = async () => ({
    ok: true as const,
    modules: { LESSON_HOST_CAPABILITIES: { version: 1, nativeLessonOwnerMarker: true } } as never,
});

const base = {
    load,
    daemonToken: jwt({ sub: 'account-a' }),
    daemonHomeDir: '/daemon/home',
    projectId: 'p1',
    eligible: true,
};

describe('lessonCallerSharesIdentity', () => {
    it('is the same account through a re-issued token, and a relocated home is not a new account', () => {
        expect(lessonCallerSharesIdentity(jwt({ sub: 'account-a', iat: 2 }), base.daemonToken)).toBe(true);
        expect(lessonCallerSharesIdentity(undefined, base.daemonToken)).toBe(true);
    });

    it('is a different account for a collaborator credential', () => {
        expect(lessonCallerSharesIdentity(jwt({ sub: 'account-b' }), base.daemonToken)).toBe(false);
    });
});

describe('applyLessonLaunchEnvironment', () => {
    it('claims for a launch whose child asks as the account the proof was taken with', async () => {
        const { environment, decision } = await applyLessonLaunchEnvironment({
            ...base,
            environment: { KEEP: '1', [LESSON_HOST_DISABLED_ENV]: 'unsupported-caller' },
            callerToken: jwt({ sub: 'account-a', iat: 9 }),
            hostIsReady: async () => true,
        });
        expect(decision.owner).toBe('host');
        expect(environment).toEqual({
            KEEP: '1',
            [LESSON_DAEMON_HOME_ENV]: '/daemon/home',
            [LESSON_OWNER_ENV]: 'host',
            [LESSON_HOST_DISABLED_ENV]: '',
        });
    });

    it('disables both injectors for an unsupported collaborator', async () => {
        const hostIsReady = vi.fn(async () => true);
        const { environment, decision } = await applyLessonLaunchEnvironment({
            ...base,
            environment: {},
            callerToken: jwt({ sub: 'account-b' }),
            hostIsReady,
        });
        expect(decision).toEqual({ owner: 'disabled', reason: 'unsupported-caller' });
        expect(environment[LESSON_OWNER_ENV]).toBe('host');
        expect(environment[LESSON_HOST_DISABLED_ENV]).toBe('unsupported-caller');
        // Not even asked: the answer would not be about this child.
        expect(hostIsReady).not.toHaveBeenCalled();
    });

    it('overrides a host marker inherited from the daemon\'s own environment', async () => {
        const { environment } = await applyLessonLaunchEnvironment({
            ...base,
            environment: { [LESSON_OWNER_ENV]: 'host' },
            callerToken: jwt({ sub: 'account-b' }),
            hostIsReady: async () => true,
        });
        expect(environment[LESSON_OWNER_ENV]).toBe('host');
        expect(environment[LESSON_HOST_DISABLED_ENV]).toBe('unsupported-caller');
    });

    it('stays native without a trusted project binding', async () => {
        const hostIsReady = vi.fn(async () => true);
        const { decision } = await applyLessonLaunchEnvironment({
            ...base,
            projectId: null,
            environment: {},
            callerToken: null,
            hostIsReady,
        });
        expect(decision.owner).toBe('native');
        expect(hostIsReady).not.toHaveBeenCalled();
    });

    it('restores what the caller sanitizer had to strip', async () => {
        /*
         * The resume path's defect in one test. The sanitizer removes every
         * `HAPPY_LESSON_`/`CLAUDE_MEMORY_` key so a caller cannot forge them,
         * which also removes the daemon's own — and a resumed session that
         * went to the provider like that had no state root and no stated
         * owner.
         */
        const prepared = prepareMcpChildEnvironment({
            environmentVariables: {
                [LESSON_DAEMON_HOME_ENV]: '/attacker/home',
                [LESSON_OWNER_ENV]: 'host',
                KEEP: '1',
            },
        }, { consume: () => ({ ok: true as const, grant: 'g' }) });
        const sanitized = prepared.ok ? prepared.environmentVariables : {};
        expect(sanitized[LESSON_DAEMON_HOME_ENV]).toBeUndefined();

        const { environment } = await applyLessonLaunchEnvironment({
            ...base,
            environment: sanitized as Record<string, string>,
            callerToken: base.daemonToken,
            hostIsReady: async () => true,
        });
        expect(environment[LESSON_DAEMON_HOME_ENV]).toBe('/daemon/home');
        expect(environment[LESSON_OWNER_ENV]).toBe('host');
        expect(environment.KEEP).toBe('1');
    });
});
