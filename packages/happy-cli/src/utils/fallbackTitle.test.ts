import { describe, expect, it } from 'vitest';
import { buildFallbackTitle } from './fallbackTitle';

describe('buildFallbackTitle', () => {
    it('collapses internal whitespace and newlines', () => {
        expect(buildFallbackTitle('음... 그러니까\n이거 좀   고쳐줘')).toBe('음... 그러니까 이거 좀 고쳐줘');
    });

    it('trims leading and trailing whitespace', () => {
        expect(buildFallbackTitle('  hello world  ')).toBe('hello world');
    });

    it('truncates long text with an ellipsis', () => {
        const long = 'a'.repeat(80);
        const result = buildFallbackTitle(long);
        expect(result).toBe('a'.repeat(50) + '…');
    });

    it('does not split an emoji surrogate pair when truncating', () => {
        // 49 plain chars + one emoji (surrogate pair) as the 50th code point.
        const text = 'a'.repeat(49) + '😀' + 'b'.repeat(30);
        const result = buildFallbackTitle(text);
        expect(result).toBe('a'.repeat(49) + '😀' + '…');
        // The emoji must survive intact (not a lone half-surrogate).
        expect(Array.from(result!)).toContain('😀');
    });

    it('returns null for empty or whitespace-only text', () => {
        expect(buildFallbackTitle('')).toBeNull();
        expect(buildFallbackTitle('   \n\t  ')).toBeNull();
    });

    it('returns null for slash commands, which are control input not a task description', () => {
        expect(buildFallbackTitle('/clear')).toBeNull();
        expect(buildFallbackTitle('  /compact  ')).toBeNull();
        expect(buildFallbackTitle('/model opus')).toBeNull();
    });

    it('keeps text that merely contains a slash', () => {
        expect(buildFallbackTitle('fix src/api/apiSession.ts')).toBe('fix src/api/apiSession.ts');
    });
});
