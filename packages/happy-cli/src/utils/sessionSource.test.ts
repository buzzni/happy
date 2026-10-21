import { describe, expect, it } from 'vitest';

import { normalizeSessionSource, sessionSourceSpawnEnv } from './sessionSource';

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

    it('hands a spawn-supplied source to the runner through the lineage-scrubbed env', () => {
        expect(sessionSourceSpawnEnv('review')).toEqual({ HAPPY_CREATED_BY_SOURCE: 'review' });
        expect(sessionSourceSpawnEnv('Not A Tag')).toEqual({});
        expect(sessionSourceSpawnEnv(undefined)).toEqual({});
    });
});
