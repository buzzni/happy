import { describe, expect, it } from 'vitest';
import { composeDenyMessage, USER_REASON_MAX_LENGTH } from './permissionDenyMessage';

const DEFAULT = 'The tool use was rejected. STOP and wait.';

describe('composeDenyMessage', () => {
    it('keeps the default message and appends the person\'s own reason after it', () => {
        expect(composeDenyMessage(DEFAULT, { userReason: '비용이 커요' })).toBe(`${DEFAULT}\n\nUser's reason: 비용이 커요`);
    });

    it('sends a legacy `reason` verbatim, because current clients already put the default in front', () => {
        const assembled = `${DEFAULT}\n\nUser's reason: use staging`;
        expect(composeDenyMessage(DEFAULT, { reason: assembled })).toBe(assembled);
    });

    it('prefers `userReason` when both are sent', () => {
        expect(composeDenyMessage(DEFAULT, { reason: 'legacy text', userReason: 'new text' })).toBe(`${DEFAULT}\n\nUser's reason: new text`);
    });

    it('falls back to the default message when neither is sent', () => {
        expect(composeDenyMessage(DEFAULT, {})).toBe(DEFAULT);
    });

    it('reads a blank reason as no reason', () => {
        expect(composeDenyMessage(DEFAULT, { userReason: ' \n\t ' })).toBe(DEFAULT);
        expect(composeDenyMessage(DEFAULT, { reason: '   ' })).toBe(DEFAULT);
        expect(composeDenyMessage(DEFAULT, { reason: 'legacy', userReason: '  ' })).toBe('legacy');
    });

    it('trims the person\'s reason', () => {
        expect(composeDenyMessage(DEFAULT, { userReason: '  use staging  ' })).toBe(`${DEFAULT}\n\nUser's reason: use staging`);
    });

    it('drops control characters but keeps line breaks and tabs', () => {
        expect(composeDenyMessage(DEFAULT, { userReason: 'a\u0000b\u001b[31mc\r\nd\te\u007f\u0085f' }))
            .toBe(`${DEFAULT}\n\nUser's reason: ab[31mc\nd\tef`);
    });

    it('keeps a reason at the Desktop input limit whole and cuts a longer one with an ellipsis', () => {
        const atLimit = '가'.repeat(USER_REASON_MAX_LENGTH);
        expect(composeDenyMessage(DEFAULT, { userReason: atLimit })).toBe(`${DEFAULT}\n\nUser's reason: ${atLimit}`);
        expect(composeDenyMessage(DEFAULT, { userReason: `${atLimit}나다` })).toBe(`${DEFAULT}\n\nUser's reason: ${atLimit}…`);
    });

    it('does not split a surrogate pair when cutting', () => {
        const reason = '😀'.repeat(USER_REASON_MAX_LENGTH + 1);
        const message = composeDenyMessage(DEFAULT, { userReason: reason });
        expect(message).toBe(`${DEFAULT}\n\nUser's reason: ${'😀'.repeat(USER_REASON_MAX_LENGTH)}…`);
    });

    it('ignores a non-string value an untyped RPC payload may carry', () => {
        expect(composeDenyMessage(DEFAULT, { userReason: 42 as unknown as string, reason: 'legacy' })).toBe('legacy');
    });
});
