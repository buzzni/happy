import { describe, expect, it } from 'vitest';

import { normalizeSessionSource, takeSessionSourceFromEnv } from './sessionSource';

describe('normalizeSessionSource', () => {
    it('keeps known and not-yet-known well-formed tags', () => {
        expect(normalizeSessionSource('schedule')).toBe('schedule');
        expect(normalizeSessionSource('github-trigger')).toBe('github-trigger');
        expect(normalizeSessionSource('some-future-source')).toBe('some-future-source');
    });

    it('drops anything that is not a short lowercase tag instead of guessing', () => {
        for (const value of [undefined, null, 42, '', 'User', ' user', 'a'.repeat(33), '__proto__', 'x y']) {
            expect(normalizeSessionSource(value)).toBeUndefined();
        }
    });

    it('takes the spawn-supplied source out of the environment, well-formed or not', () => {
        const env: NodeJS.ProcessEnv = { HAPPY_CREATED_BY_SOURCE: 'review', PATH: '/bin' };
        expect(takeSessionSourceFromEnv(env)).toBe('review');
        expect(env).toEqual({ PATH: '/bin' });

        const malformed: NodeJS.ProcessEnv = { HAPPY_CREATED_BY_SOURCE: 'Not A Tag' };
        expect(takeSessionSourceFromEnv(malformed)).toBeUndefined();
        expect(malformed).toEqual({});
        expect(takeSessionSourceFromEnv({})).toBeUndefined();
    });
});
