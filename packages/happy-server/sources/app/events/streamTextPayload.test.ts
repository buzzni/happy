import { describe, expect, it } from 'vitest';
import { parseStreamTextPayload } from './streamTextPayload';

const valid = { sid: 'session-1', turnId: 'turn-1', blockIndex: 0, content: 'ciphertext-b64' };

describe('parseStreamTextPayload', () => {
    it('accepts a well-formed payload', () => {
        expect(parseStreamTextPayload(valid)).toEqual({
            sid: 'session-1',
            turnId: 'turn-1',
            blockIndex: 0,
            content: 'ciphertext-b64',
        });
    });

    it('rejects a payload missing any required field', () => {
        for (const key of Object.keys(valid)) {
            const { [key as keyof typeof valid]: _omit, ...rest } = valid;
            expect(parseStreamTextPayload(rest), `missing ${key}`).toBeNull();
        }
    });

    it('rejects wrong-typed fields instead of coercing them', () => {
        expect(parseStreamTextPayload({ ...valid, sid: 42 })).toBeNull();
        expect(parseStreamTextPayload({ ...valid, blockIndex: '0' })).toBeNull();
        expect(parseStreamTextPayload({ ...valid, content: 123 })).toBeNull();
    });

    it('rejects a negative or non-integer blockIndex', () => {
        expect(parseStreamTextPayload({ ...valid, blockIndex: -1 })).toBeNull();
        expect(parseStreamTextPayload({ ...valid, blockIndex: 1.5 })).toBeNull();
    });

    it('rejects an empty sid, turnId, or content', () => {
        expect(parseStreamTextPayload({ ...valid, sid: '' })).toBeNull();
        expect(parseStreamTextPayload({ ...valid, turnId: '' })).toBeNull();
        expect(parseStreamTextPayload({ ...valid, content: '' })).toBeNull();
    });

    it('rejects null, undefined, and non-object input', () => {
        for (const raw of [null, undefined, 'string', 7, []]) {
            expect(parseStreamTextPayload(raw)).toBeNull();
        }
    });
});
