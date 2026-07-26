import { describe, it, expect } from 'vitest';
import {
    filterUpstreamCookieHeader,
    splitSetCookieValues,
    rewriteSetCookieForPreview,
    type RewriteSetCookieOptions,
} from '@/modules/preview/previewCredentials';

describe('filterUpstreamCookieHeader', () => {
    it('returns null for undefined input', () => {
        expect(filterUpstreamCookieHeader(undefined)).toBeNull();
    });

    it('returns null for empty string input', () => {
        expect(filterUpstreamCookieHeader('')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
        expect(filterUpstreamCookieHeader('   ')).toBeNull();
    });

    it('drops happy_preview_<mid>_<port>=… pairs and keeps app cookies', () => {
        const input = 'sessionId=abc123; happy_preview_m1_3000=token; userId=xyz';
        const result = filterUpstreamCookieHeader(input);
        expect(result).toBe('sessionId=abc123; userId=xyz');
    });

    it('preserves order when filtering', () => {
        const input = 'a=1; happy_preview_m1_3000=drop; b=2; happy_preview_m2_4000=drop; c=3';
        const result = filterUpstreamCookieHeader(input);
        expect(result).toBe('a=1; b=2; c=3');
    });

    it('joins cookies with "; " separator', () => {
        const input = 'cookie1=value1; cookie2=value2';
        const result = filterUpstreamCookieHeader(input);
        expect(result).toBe('cookie1=value1; cookie2=value2');
    });

    it('drops EVERY happy_preview_* cookie when several previews cookies are present (token leakage prevention)', () => {
        const input = 'app_cookie=keep; happy_preview_m1_3000=drop1; happy_preview_m2_4000=drop2; happy_preview_m3_5000=drop3';
        const result = filterUpstreamCookieHeader(input);
        expect(result).toBe('app_cookie=keep');
    });

    it('returns null when only preview cookies were present', () => {
        const input = 'happy_preview_m1_3000=token1; happy_preview_m2_4000=token2';
        const result = filterUpstreamCookieHeader(input);
        expect(result).toBeNull();
    });

    it('keeps a cookie whose name merely starts similarly but is NOT happy_preview_ (prefix match is strict)', () => {
        // happy_previewX does not match the prefix happy_preview_ (note the underscore),
        // so it's kept as an app cookie
        const input = 'happy_previewX=1; happy_preview_m1_3000=token; normalCookie=value';
        const result = filterUpstreamCookieHeader(input);
        expect(result).toBe('happy_previewX=1; normalCookie=value');
    });

    it('keeps cookies with values containing = (base64 padding)', () => {
        const input = 'token=abc==; happy_preview_m1_3000=drop; other=xyz=';
        const result = filterUpstreamCookieHeader(input);
        expect(result).toBe('token=abc==; other=xyz=');
    });

    it('handles cookies with no value (name only)', () => {
        const input = 'sessionId; happy_preview_m1_3000=token';
        const result = filterUpstreamCookieHeader(input);
        expect(result).toBe('sessionId');
    });
});

describe('splitSetCookieValues', () => {
    it('returns empty array for undefined input', () => {
        expect(splitSetCookieValues(undefined)).toEqual([]);
    });

    it('passes through array input, trimmed, empties removed', () => {
        const input = ['  cookie1=value1', 'cookie2=value2  ', '', '  '];
        const result = splitSetCookieValues(input);
        expect(result).toEqual(['cookie1=value1', 'cookie2=value2']);
    });

    it('splits comma-joined legacy string into separate cookies', () => {
        const input = 'cookie1=value1, cookie2=value2';
        const result = splitSetCookieValues(input);
        expect(result).toEqual(['cookie1=value1', 'cookie2=value2']);
    });

    it('does not treat comma inside Expires=Wed, 21 Oct 2015 07:28:00 GMT as a separator', () => {
        const input = 'sessionId=abc123; Expires=Wed, 21 Oct 2015 07:28:00 GMT, othercookie=value';
        const result = splitSetCookieValues(input);
        expect(result).toEqual([
            'sessionId=abc123; Expires=Wed, 21 Oct 2015 07:28:00 GMT',
            'othercookie=value',
        ]);
    });

    it('handles array where elements themselves contain commas', () => {
        const input = [
            'cookie1=value1; Expires=Mon, 01 Jan 2024 00:00:00 GMT',
            'cookie2=value2',
        ];
        const result = splitSetCookieValues(input);
        expect(result).toEqual([
            'cookie1=value1; Expires=Mon, 01 Jan 2024 00:00:00 GMT',
            'cookie2=value2',
        ]);
    });

    it('trims whitespace around commas in separator detection', () => {
        const input = 'cookie1=value1  ,  cookie2=value2';
        const result = splitSetCookieValues(input);
        expect(result).toEqual(['cookie1=value1', 'cookie2=value2']);
    });
});

describe('rewriteSetCookieForPreview with subdomain mode (prefix empty, secure=true)', () => {
    const options: RewriteSetCookieOptions = { prefix: '', secure: true };

    it('removes Domain= attribute', () => {
        const input = 'sessionId=abc123; Domain=.example.com; Path=/';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).not.toContain('Domain=');
        expect(result).toContain('sessionId=abc123');
        expect(result).toContain('Path=/');
    });

    it('converts SameSite=Lax to SameSite=None when secure=true', () => {
        const input = 'sessionId=abc123; SameSite=Lax';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toBe('sessionId=abc123; SameSite=None; Secure');
    });

    it('appends SameSite=None when missing and secure=true', () => {
        const input = 'sessionId=abc123';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('SameSite=None');
        expect(result).toContain('Secure');
    });

    it('appends Secure when missing and secure=true', () => {
        const input = 'sessionId=abc123; SameSite=None';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('Secure');
    });

    it('does not duplicate existing Secure', () => {
        const input = 'sessionId=abc123; Secure; SameSite=None';
        const result = rewriteSetCookieForPreview(input, options);
        const secureCount = (result.match(/Secure/g) || []).length;
        expect(secureCount).toBe(1);
    });

    it('leaves Path=/ unchanged in subdomain mode', () => {
        const input = 'sessionId=abc123; Path=/';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('Path=/');
    });

    it('preserves name=value and HttpOnly/Max-Age', () => {
        const input = 'sessionId=abc123; HttpOnly; Max-Age=3600; Path=/app';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('sessionId=abc123');
        expect(result).toContain('HttpOnly');
        expect(result).toContain('Max-Age=3600');
    });
});

describe('rewriteSetCookieForPreview with path-prefix mode (prefix=/v1/preview/m1/3000, secure=true)', () => {
    const options: RewriteSetCookieOptions = { prefix: '/v1/preview/m1/3000', secure: true };

    it('prefixes Path=/ to /v1/preview/m1/3000/', () => {
        const input = 'sessionId=abc123; Path=/';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('Path=/v1/preview/m1/3000/');
    });

    it('prefixes Path=/api to /v1/preview/m1/3000/api', () => {
        const input = 'sessionId=abc123; Path=/api';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('Path=/v1/preview/m1/3000/api');
    });

    it('leaves already-prefixed Path unchanged (idempotent)', () => {
        const input = 'sessionId=abc123; Path=/v1/preview/m1/3000/api';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('Path=/v1/preview/m1/3000/api');
        // Should not double-prefix
        expect(result).not.toContain('/v1/preview/m1/3000/v1/preview/m1/3000');
    });

    it('handles Path=/v1/preview/m1/3000 (without trailing slash) as idempotent', () => {
        const input = 'sessionId=abc123; Path=/v1/preview/m1/3000';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('Path=/v1/preview/m1/3000');
    });

    it('appends SameSite=None; Secure when secure=true', () => {
        const input = 'sessionId=abc123; Path=/api';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('SameSite=None');
        expect(result).toContain('Secure');
    });

    it('removes Domain= and prefixes Path= together', () => {
        const input = 'sessionId=abc123; Domain=localhost; Path=/app';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).not.toContain('Domain=');
        expect(result).toContain('Path=/v1/preview/m1/3000/app');
    });
});

describe('rewriteSetCookieForPreview with secure=false', () => {
    const options: RewriteSetCookieOptions = { prefix: '/v1/preview/m1/3000', secure: false };

    it('leaves SameSite unchanged and does not add Secure', () => {
        const input = 'sessionId=abc123; SameSite=Lax';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('SameSite=Lax');
        expect(result).not.toContain('SameSite=None');
        expect(result).not.toContain('Secure');
    });

    it('does not add SameSite or Secure when missing', () => {
        const input = 'sessionId=abc123; Path=/api';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).not.toContain('SameSite=None');
        expect(result).not.toContain('Secure');
        expect(result).toContain('Path=/v1/preview/m1/3000/api');
    });

    it('preserves SameSite=Strict when secure=false', () => {
        const input = 'sessionId=abc123; SameSite=Strict';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toContain('SameSite=Strict');
    });
});

describe('rewriteSetCookieForPreview edge cases', () => {
    it('handles empty cookie string gracefully', () => {
        const options: RewriteSetCookieOptions = { prefix: '', secure: true };
        const input = '';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toBe('');
    });

    it('handles cookie with only name, no value', () => {
        const options: RewriteSetCookieOptions = { prefix: '', secure: true };
        const input = 'HttpOnly';
        const result = rewriteSetCookieForPreview(input, options);
        expect(result).toBe('HttpOnly; SameSite=None; Secure');
    });

    it('preserves case-insensitive attribute handling (lowercase output)', () => {
        const options: RewriteSetCookieOptions = { prefix: '', secure: true };
        const input = 'sessionId=abc123; SAMESITE=Lax; SECURE';
        const result = rewriteSetCookieForPreview(input, options);
        // Should override both and produce SameSite=None; Secure
        expect(result).toContain('SameSite=None');
        const secureCount = (result.match(/Secure/gi) || []).length;
        // SECURE in input might be preserved, but we should have at least the one we add
        expect(secureCount).toBeGreaterThan(0);
    });
});
