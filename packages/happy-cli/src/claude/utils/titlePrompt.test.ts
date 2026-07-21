import { describe, it, expect } from 'vitest';
import { appendClaudeTitleInstruction, CLAUDE_TITLE_INSTRUCTION } from './titlePrompt';

describe('appendClaudeTitleInstruction', () => {
    it('appends the change_title instruction after the user text', () => {
        const out = appendClaudeTitleInstruction('로그인 버튼이 안 눌려');

        expect(out.startsWith('로그인 버튼이 안 눌려')).toBe(true);
        expect(out.endsWith(CLAUDE_TITLE_INSTRUCTION)).toBe(true);
        expect(out).toContain('mcp__happy__change_title');
    });

    it('separates the user text and the instruction with a blank line', () => {
        const out = appendClaudeTitleInstruction('fix the parser');

        expect(out).toBe(`fix the parser\n\n${CLAUDE_TITLE_INSTRUCTION}`);
    });

    it('leaves empty or whitespace-only text untouched (nothing to title from)', () => {
        expect(appendClaudeTitleInstruction('')).toBe('');
        expect(appendClaudeTitleInstruction('   \n  ')).toBe('   \n  ');
    });
});
