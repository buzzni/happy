import { describe, it, expect } from 'vitest';
import { stripResponseHeaders } from '@/app/api/routes/previewRoutes';

// Phase 3 (specs/preview-nextjs-turbopack-hydration/): the preview relay
// proxies upstream response headers verbatim except for a small drop list.
// This spec pins the drop list so future edits don't accidentally
// reintroduce noisy/broken behavior (e.g. dropping `Link` was added to
// silence "preloaded using link preload but not used" warnings from
// platform-origin preloads we can't rewrite).
describe('stripResponseHeaders', () => {
    it('drops content-length (body may be rewritten to a different size)', () => {
        const out = stripResponseHeaders({ 'content-length': '123', 'content-type': 'text/html' });
        expect(out['content-length']).toBeUndefined();
        expect(out['content-type']).toBe('text/html');
    });

    it('drops content-encoding (body has already been decoded upstream)', () => {
        const out = stripResponseHeaders({ 'content-encoding': 'gzip', 'content-type': 'text/html' });
        expect(out['content-encoding']).toBeUndefined();
    });

    it('drops x-frame-options (would block iframe embedding)', () => {
        const out = stripResponseHeaders({ 'x-frame-options': 'DENY', 'content-type': 'text/html' });
        expect(out['x-frame-options']).toBeUndefined();
    });

    it('drops Link response header (early-hint preloads against the wrong origin)', () => {
        const linkValue = '</_next/static/chunks/foo.css>; rel=preload; as="style"';
        const out = stripResponseHeaders({ Link: linkValue, 'content-type': 'text/html' });
        expect(out['Link']).toBeUndefined();
        expect(out['link']).toBeUndefined();
    });

    it('drops lowercase `link` header too (case-insensitive match)', () => {
        const out = stripResponseHeaders({ link: '</a.css>; rel=preload', 'content-type': 'text/html' });
        expect(out['link']).toBeUndefined();
    });

    it('preserves cache-control, etag, content-type, and arbitrary headers', () => {
        const out = stripResponseHeaders({
            'cache-control': 'no-store',
            'etag': 'W/"abc"',
            'content-type': 'application/javascript',
            'x-custom-header': 'value',
        });
        expect(out['cache-control']).toBe('no-store');
        expect(out['etag']).toBe('W/"abc"');
        expect(out['content-type']).toBe('application/javascript');
        expect(out['x-custom-header']).toBe('value');
    });
});
