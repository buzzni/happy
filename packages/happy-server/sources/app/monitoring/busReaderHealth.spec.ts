import { describe, expect, it } from 'vitest';
import { countHealthyPeerReaders, staleReaderFields } from './busReaderHealth';

describe('countHealthyPeerReaders', () => {
    const now = 1_000_000;
    it('counts other replicas whose last successful read is fresh and ignores this replica', () => {
        const entries = { self: String(now), a: String(now - 2_000), b: String(now - 14_000), c: String(now - 16_000) };
        expect(countHealthyPeerReaders(entries, 'self', now)).toBe(2);
    });
    it('treats unparsable or never-read entries as unhealthy', () => {
        expect(countHealthyPeerReaders({ a: '0', b: 'x', c: '' }, 'self', now)).toBe(0);
    });
});

describe('staleReaderFields', () => {
    it('returns entries of replicas gone for over an hour so the hash does not grow forever', () => {
        const now = 10_000_000;
        expect(staleReaderFields({ a: String(now - 3_600_001), b: String(now - 10), c: '0', self: String(now - 3_700_000) }, 'self', now))
            .toEqual(['a', 'c']);
    });
});
