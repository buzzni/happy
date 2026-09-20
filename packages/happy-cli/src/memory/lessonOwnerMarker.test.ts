import { describe, expect, it, vi } from 'vitest';

import {
    LESSON_OWNER_ENV,
    applyLessonOwner,
    decideLessonOwner,
    readLessonOwner,
    supportsNativeOwnerMarker,
} from './lessonOwnerMarker';
import { prepareMcpChildEnvironment } from '@/daemon/mcpCallerGrantEnvelope';
import type { CmlLessonHostLoad } from './cmlLessonHost';

function loaded(capabilities?: unknown): CmlLessonHostLoad {
    return {
        ok: true,
        modules: {
            ...(capabilities === undefined ? {} : { LESSON_HOST_CAPABILITIES: capabilities }),
        } as never,
    };
}

const current = { version: 1, nativeLessonOwnerMarker: true };

describe('supportsNativeOwnerMarker', () => {
    it('accepts the exact capability the contract names', () => {
        expect(supportsNativeOwnerMarker(loaded(current))).toBe(true);
    });

    it('refuses a build that states nothing', () => {
        // Every CML before the guard. It injects regardless of the marker, so
        // claiming ownership against it produces double injection.
        expect(supportsNativeOwnerMarker(loaded())).toBe(false);
    });

    it('refuses a different version or a falsy flag rather than assuming', () => {
        expect(supportsNativeOwnerMarker(loaded({ version: 2, nativeLessonOwnerMarker: true }))).toBe(false);
        expect(supportsNativeOwnerMarker(loaded({ version: 1, nativeLessonOwnerMarker: false }))).toBe(false);
        expect(supportsNativeOwnerMarker(loaded({ version: 1, nativeLessonOwnerMarker: 'true' }))).toBe(false);
        expect(supportsNativeOwnerMarker(loaded(null))).toBe(false);
    });

    it('refuses when the package did not load at all', () => {
        expect(supportsNativeOwnerMarker({ ok: false, reason: 'unsupported', detail: 'not-installed' }))
            .toBe(false);
    });
});

describe('decideLessonOwner', () => {
    const load = async () => loaded(current);

    it('claims only when the store, the capability and a real host all hold', async () => {
        const hostIsReady = vi.fn(async () => true);
        expect(await decideLessonOwner({ eligible: true, hostIsReady, load }))
            .toEqual({ owner: 'host', reason: 'claimed' });
    });

    it('leaves the native hook in charge when no host could be opened', async () => {
        /*
         * The decisive case. The preconditions all looked right and the store
         * honours the marker — but the studio refused, or the key is missing,
         * or the store would not open. Claiming here would silence the native
         * hook for a session that then has no lessons at all.
         */
        expect(await decideLessonOwner({ eligible: true, hostIsReady: async () => false, load }))
            .toEqual({ owner: 'native', reason: 'host-not-ready' });
    });

    it('treats a thrown readiness check as not ready', async () => {
        expect(await decideLessonOwner({
            eligible: true,
            hostIsReady: async () => { throw new Error('studio unreachable'); },
            load,
        })).toEqual({ owner: 'native', reason: 'host-not-ready' });
    });

    it('does not even ask about readiness when the build cannot stand down', async () => {
        const hostIsReady = vi.fn(async () => true);
        expect(await decideLessonOwner({
            eligible: true, hostIsReady, load: async () => loaded(),
        })).toEqual({ owner: 'native', reason: 'capability-missing' });
        // No point opening a store for a decision already made.
        expect(hostIsReady).not.toHaveBeenCalled();
    });

    it('stays native for an ineligible launch without touching the package', async () => {
        const probe = vi.fn(async () => loaded(current));
        const hostIsReady = vi.fn(async () => true);
        expect(await decideLessonOwner({ eligible: false, hostIsReady, load: probe }))
            .toEqual({ owner: 'native', reason: 'host-unavailable' });
        expect(probe).not.toHaveBeenCalled();
        expect(hostIsReady).not.toHaveBeenCalled();
    });

    it('stays native when the package is absent', async () => {
        expect(await decideLessonOwner({
            eligible: true,
            hostIsReady: async () => true,
            load: async () => ({ ok: false, reason: 'unsupported', detail: 'not-installed' }),
        })).toEqual({ owner: 'native', reason: 'store-unavailable' });
    });
});

describe('decision deadline', () => {
    it('falls back to native rather than holding an ordinary session open', async () => {
        // A memory store that never answers must not delay starting a session.
        const started = Date.now();
        expect(await decideLessonOwner({
            eligible: true,
            hostIsReady: async () => true,
            load: () => new Promise(() => {}) as never,
            budgetMs: 40,
        })).toEqual({ owner: 'native', reason: 'host-not-ready' });
        expect(Date.now() - started).toBeLessThan(500);
    });

    it('does not reopen the decision when readiness answers late', async () => {
        let resolveReady!: (value: boolean) => void;
        const decision = await decideLessonOwner({
            eligible: true,
            hostIsReady: () => new Promise((resolve) => { resolveReady = resolve; }),
            load: async () => loaded(current),
            budgetMs: 30,
        });
        expect(decision.owner).toBe('native');
        // The child has already been launched with this answer; a late yes
        // would leave the two sides disagreeing about who injects.
        resolveReady(true);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(decision).toEqual({ owner: 'native', reason: 'host-not-ready' });
    });
});

describe('applyLessonOwner', () => {
    it('marks a host launch', () => {
        expect(applyLessonOwner({ A: '1' }, { owner: 'host', reason: 'claimed' }))
            .toEqual({ A: '1', [LESSON_OWNER_ENV]: 'host' });
    });

    it('writes native explicitly, because deleting the key is not enough', () => {
        /*
         * The spawn merges `{ ...process.env, ...extraEnv }`, so a value on the
         * daemon's own environment comes back through inheritance. Stating the
         * decision is what overrides it.
         */
        expect(applyLessonOwner({ A: '1' }, { owner: 'native', reason: 'host-not-ready' }))
            .toEqual({ A: '1', [LESSON_OWNER_ENV]: 'native' });
        expect(readLessonOwner(
            applyLessonOwner({}, { owner: 'native', reason: 'capability-missing' }) as NodeJS.ProcessEnv,
        )).toBe('native');
    });

    it('overrides an inherited claim rather than honouring it', () => {
        expect(applyLessonOwner(
            { [LESSON_OWNER_ENV]: 'host', A: '1' },
            { owner: 'native', reason: 'capability-missing' },
        )).toEqual({ A: '1', [LESSON_OWNER_ENV]: 'native' });
    });
});

describe('readLessonOwner', () => {
    it('reads host only for the exact marker', () => {
        expect(readLessonOwner({ [LESSON_OWNER_ENV]: 'host' } as NodeJS.ProcessEnv)).toBe('host');
        expect(readLessonOwner({ [LESSON_OWNER_ENV]: 'HOST' } as NodeJS.ProcessEnv)).toBe('native');
        expect(readLessonOwner({} as NodeJS.ProcessEnv)).toBe('native');
    });
});

describe('caller-supplied environment', () => {
    const consumer = { consume: () => ({ ok: true as const, grant: 'g' }) };

    it('cannot set the owner marker, the state root or the package path', () => {
        /*
         * The spawn RPC caller controls `environmentVariables`. Each of these
         * would subvert a different guarantee:
         *
         *  - the marker silences CML's native hook while no host is running;
         *  - the state root points a session at a settings file with recall on
         *    and a ledger with no spending history;
         *  - the package path names where a lesson store is loaded from.
         */
        const prepared = prepareMcpChildEnvironment({
            environmentVariables: {
                CLAUDE_MEMORY_LESSON_OWNER: 'host',
                CLAUDE_MEMORY_LESSON_HOST_ROOT: '/tmp/attacker-cml',
                HAPPY_LESSON_DAEMON_HOME: '/tmp/attacker-home',
                KEEP_ME: '1',
            },
        }, consumer);
        expect(prepared.ok).toBe(true);
        const env = prepared.ok ? prepared.environmentVariables : {};
        expect(env).not.toHaveProperty('CLAUDE_MEMORY_LESSON_OWNER');
        expect(env).not.toHaveProperty('CLAUDE_MEMORY_LESSON_HOST_ROOT');
        expect(env).not.toHaveProperty('HAPPY_LESSON_DAEMON_HOME');
        // Ordinary variables still pass through.
        expect(env.KEEP_ME).toBe('1');
    });

    it('strips every CLAUDE_MEMORY_ setting, not only the ones named today', () => {
        const prepared = prepareMcpChildEnvironment({
            environmentVariables: { CLAUDE_MEMORY_LESSON_MODE: 'off', CLAUDE_MEMORY_SEARCH: 'false' },
        }, consumer);
        const env = prepared.ok ? prepared.environmentVariables : {};
        expect(Object.keys(env).filter((key) => key.startsWith('CLAUDE_MEMORY_'))).toEqual([]);
    });
});
