import { describe, it, expect } from 'vitest';
import { rewriteLinkHeader } from '@/modules/preview/rewriteLinkHeader';

const PREFIX = '/v1/preview/m1/3000';

describe('rewriteLinkHeader — preload entries (the noisy case)', () => {
    it('returns null when the only entry is rel=preload (drop header)', () => {
        const v = '</_next/static/x.css>; rel=preload; as="style"';
        expect(rewriteLinkHeader(v, PREFIX)).toBeNull();
    });

    it('returns null for multiple preload entries (typical Next.js dev)', () => {
        const v =
            '</_next/static/x.css>; rel=preload; as="style", ' +
            '</_next/static/y.woff2>; rel=preload; as="font"; crossorigin="", ' +
            '</_next/image?url=z>; rel=preload; as="image"';
        expect(rewriteLinkHeader(v, PREFIX)).toBeNull();
    });

    it('matches quoted "preload" rel value too', () => {
        const v = '</_next/x.css>; rel="preload"; as="style"';
        expect(rewriteLinkHeader(v, PREFIX)).toBeNull();
    });
});

describe('rewriteLinkHeader — non-preload entries (preserve + rewrite)', () => {
    it('keeps rel=canonical and rewrites absolute-path URL through proxy', () => {
        const v = '</canonical>; rel=canonical';
        expect(rewriteLinkHeader(v, PREFIX)).toBe(`<${PREFIX}/canonical>; rel=canonical`);
    });

    it('keeps rel=manifest and rewrites the URL', () => {
        const v = '</manifest.json>; rel=manifest';
        expect(rewriteLinkHeader(v, PREFIX)).toBe(`<${PREFIX}/manifest.json>; rel=manifest`);
    });

    it('leaves absolute external URLs untouched', () => {
        const v = '<https://example.com/canonical>; rel=canonical';
        expect(rewriteLinkHeader(v, PREFIX)).toBe('<https://example.com/canonical>; rel=canonical');
    });

    it('leaves protocol-relative URLs untouched', () => {
        const v = '<//cdn.example.com/x.json>; rel=manifest';
        expect(rewriteLinkHeader(v, PREFIX)).toBe('<//cdn.example.com/x.json>; rel=manifest');
    });

    it('does not double-prefix already-prefixed URLs (idempotent)', () => {
        const v = `<${PREFIX}/canonical>; rel=canonical`;
        expect(rewriteLinkHeader(v, PREFIX)).toBe(v);
    });
});

describe('rewriteLinkHeader — mixed preload + non-preload', () => {
    it('drops preload entries and keeps + rewrites the rest', () => {
        const v =
            '</_next/x.css>; rel=preload; as="style", ' +
            '</manifest.json>; rel=manifest, ' +
            '</_next/y.woff2>; rel=preload; as="font", ' +
            '<https://example.com/canonical>; rel=canonical';
        expect(rewriteLinkHeader(v, PREFIX)).toBe(
            `<${PREFIX}/manifest.json>; rel=manifest, <https://example.com/canonical>; rel=canonical`,
        );
    });
});

describe('rewriteLinkHeader — parsing edge cases', () => {
    it('handles commas inside quoted parameter values without splitting entries', () => {
        // `rel="alternate, draft"` should NOT split the entry — that comma is
        // inside a double-quoted value.
        const v = '</alt>; rel="alternate, draft"';
        expect(rewriteLinkHeader(v, PREFIX)).toBe(`<${PREFIX}/alt>; rel="alternate, draft"`);
    });

    it('handles entries with multiple parameters preserved in order', () => {
        const v = '</a.js>; rel="preload"; as="script"; integrity="sha256-abc"';
        // It IS preload, so dropped
        expect(rewriteLinkHeader(v, PREFIX)).toBeNull();
        const v2 = '</a.js>; rel=manifest; type="application/json"; crossorigin';
        expect(rewriteLinkHeader(v2, PREFIX)).toBe(
            `<${PREFIX}/a.js>; rel=manifest; type="application/json"; crossorigin`,
        );
    });

    it('returns null for empty input', () => {
        expect(rewriteLinkHeader('', PREFIX)).toBeNull();
    });

    it('ignores malformed entries (missing <URL>)', () => {
        const v = 'no-brackets; rel=canonical, </ok>; rel=manifest';
        expect(rewriteLinkHeader(v, PREFIX)).toBe(`<${PREFIX}/ok>; rel=manifest`);
    });

    it('handles entry without parameters (just URL)', () => {
        const v = '</bare>';
        expect(rewriteLinkHeader(v, PREFIX)).toBe(`<${PREFIX}/bare>`);
    });

    it('handles whitespace variations around commas and semicolons', () => {
        const v = '</a>; rel=manifest  ,  </b>; rel=canonical';
        expect(rewriteLinkHeader(v, PREFIX)).toBe(`<${PREFIX}/a>; rel=manifest, <${PREFIX}/b>; rel=canonical`);
    });
});
