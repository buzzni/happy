import { describe, it, expect } from 'vitest';
import { appendTitleInstruction, TITLE_INSTRUCTION } from '@/utils/titlePrompt';

describe('appendTitleInstruction', () => {
    it('appends the change_title instruction after the user text', () => {
        const out = appendTitleInstruction('로그인 버튼이 안 눌려');

        expect(out.startsWith('로그인 버튼이 안 눌려')).toBe(true);
        expect(out.endsWith(TITLE_INSTRUCTION)).toBe(true);
        expect(out).toContain('mcp__happy__change_title');
        expect(out).toContain('branchSlug');
    });

    it('separates the user text and the instruction with a blank line', () => {
        const out = appendTitleInstruction('fix the parser');

        expect(out).toBe(`fix the parser\n\n${TITLE_INSTRUCTION}`);
    });

    it('leaves empty or whitespace-only text untouched (nothing to title from)', () => {
        expect(appendTitleInstruction('')).toBe('');
        expect(appendTitleInstruction('   \n  ')).toBe('   \n  ');
    });
});
