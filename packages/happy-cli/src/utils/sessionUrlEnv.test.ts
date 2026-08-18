import { describe, it, expect } from 'vitest';
import { buildSessionWebUrl, applySessionUrlEnv } from './sessionUrlEnv';

describe('buildSessionWebUrl', () => {
    it('joins webapp origin and session path', () => {
        expect(buildSessionWebUrl('abc123', 'https://saycode.ai'))
            .toBe('https://saycode.ai/session/abc123');
    });

    it('ignores a path on the webapp url (URL base semantics)', () => {
        expect(buildSessionWebUrl('abc123', 'https://example.com/some/base'))
            .toBe('https://example.com/session/abc123');
    });

    it('works with localhost self-host urls with ports', () => {
        expect(buildSessionWebUrl('s1', 'http://localhost:3005'))
            .toBe('http://localhost:3005/session/s1');
    });
});

describe('applySessionUrlEnv', () => {
    it('sets both APLUS_SESSION_URL and APLUS_SESSION_ID when unset', () => {
        const env: NodeJS.ProcessEnv = {};
        applySessionUrlEnv(env, 'abc123', 'https://saycode.ai');
        expect(env.APLUS_SESSION_URL).toBe('https://saycode.ai/session/abc123');
        expect(env.APLUS_SESSION_ID).toBe('abc123');
    });

    it('does not overwrite an existing APLUS_SESSION_URL', () => {
        const env: NodeJS.ProcessEnv = { APLUS_SESSION_URL: 'https://injected.example/session/other' };
        applySessionUrlEnv(env, 'abc123', 'https://saycode.ai');
        expect(env.APLUS_SESSION_URL).toBe('https://injected.example/session/other');
        // The other key is still filled in independently.
        expect(env.APLUS_SESSION_ID).toBe('abc123');
    });

    it('does not overwrite an existing APLUS_SESSION_ID', () => {
        const env: NodeJS.ProcessEnv = { APLUS_SESSION_ID: 'injected-id' };
        applySessionUrlEnv(env, 'abc123', 'https://saycode.ai');
        expect(env.APLUS_SESSION_ID).toBe('injected-id');
        expect(env.APLUS_SESSION_URL).toBe('https://saycode.ai/session/abc123');
    });

    it('treats an empty string as unset', () => {
        const env: NodeJS.ProcessEnv = { APLUS_SESSION_URL: '', APLUS_SESSION_ID: '' };
        applySessionUrlEnv(env, 'abc123', 'https://saycode.ai');
        expect(env.APLUS_SESSION_URL).toBe('https://saycode.ai/session/abc123');
        expect(env.APLUS_SESSION_ID).toBe('abc123');
    });
});
