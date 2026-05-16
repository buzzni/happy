import { describe, it, expect } from 'vitest';
import { rewriteHtml, rewriteJsCss } from '@/modules/preview/rewriteHtml';

const PREFIX = '/v1/preview/m1/3000';

// Phase 9: the auth secret no longer travels via URL — the relay sets a
// path-scoped HttpOnly cookie on the first response, and every subsequent
// subresource request picks it up automatically. The rewriter must stop
// appending ?ptoken= to rewritten URLs. See plan.md Phase 9 step 3.

describe('rewriteHtml — absolute path rewriting', () => {
    it('rewrites src="/..." to prefix', () => {
        const out = rewriteHtml('<img src="/logo.png">', PREFIX);
        expect(out).toContain(`src="${PREFIX}/logo.png"`);
    });

    it('rewrites href="/..." to prefix', () => {
        const out = rewriteHtml('<link href="/main.css">', PREFIX);
        expect(out).toContain(`href="${PREFIX}/main.css"`);
    });

    it('rewrites action="/..." to prefix', () => {
        const out = rewriteHtml('<form action="/submit">', PREFIX);
        expect(out).toContain(`action="${PREFIX}/submit"`);
    });

    it('preserves the original query string on rewritten paths', () => {
        const out = rewriteHtml('<script src="/a.js?v=1"></script>', PREFIX);
        expect(out).toContain(`src="${PREFIX}/a.js?v=1"`);
    });

    it('leaves protocol-relative paths (//cdn/...) untouched', () => {
        const out = rewriteHtml('<script src="//cdn.example.com/lib.js"></script>', PREFIX);
        expect(out).toContain('src="//cdn.example.com/lib.js"');
        expect(out).not.toContain(`${PREFIX}//cdn`);
    });

    it('does not double-rewrite already-prefixed paths', () => {
        const already = `<img src="${PREFIX}/logo.png">`;
        const out = rewriteHtml(already, PREFIX);
        expect(out).toContain(`src="${PREFIX}/logo.png"`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('rewrites ES module imports starting with /', () => {
        const out = rewriteHtml(`<script type="module">import foo from '/src/foo.js'</script>`, PREFIX);
        expect(out).toContain(`'${PREFIX}/src/foo.js'`);
    });

    it('rewrites from "/..." in dynamic imports', () => {
        const out = rewriteHtml(`<script>import('/x.js')</script>`, PREFIX);
        expect(out).toContain(`'${PREFIX}/x.js'`);
    });

    it('leaves external absolute URLs untouched', () => {
        const out = rewriteHtml('<a href="https://example.com/x">ok</a>', PREFIX);
        expect(out).toContain('href="https://example.com/x"');
    });

    it('does not append ?ptoken= to any rewritten src/href/action attribute', () => {
        // Phase 9: URLs must stay clean — cookie-based auth replaces it.
        const input = '<img src="/a.png"><link href="/b.css"><form action="/c"></form>';
        const out = rewriteHtml(input, PREFIX);
        // Scope the assertion to the attribute values so the interceptor
        // script's internal literals (there are none for ptoken in Phase 9,
        // but keep the check explicit) can't cross-contaminate.
        const attrValues = (out.match(/(?:src|href|action)="[^"]+"/g) ?? []).join('\n');
        expect(attrValues).not.toContain('ptoken=');
    });
});

describe('rewriteHtml — interceptor injection', () => {
    it('injects <base href> before the interceptor script after <head>', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).toMatch(new RegExp(`<head><base href="${PREFIX}/"><script>`));
    });

    it('injects after <html> when <head> is absent', () => {
        const out = rewriteHtml('<html><body></body></html>', PREFIX);
        expect(out).toMatch(new RegExp(`<html><base href="${PREFIX}/"><script>`));
    });

    it('prepends <base> + interceptor when neither <head> nor <html> is present', () => {
        const out = rewriteHtml('<div>naked fragment</div>', PREFIX);
        expect(out.startsWith(`<base href="${PREFIX}/"><script>`)).toBe(true);
        expect(out).toContain('<div>naked fragment</div>');
    });

    // <base href> pins the document base URL so that relative-path resources
    // (<script src="app.js">, <link href="style.css">) keep resolving through
    // the relay even after the interceptor's history.replaceState mutates
    // location.pathname. Without this, app.js requests fall back to the
    // platform origin and the browser hits a SPA-fallback HTML page that
    // fails JS parsing with "Unexpected token '<'".
    // See specs/preview-api-proxy/ Phase 5 (R9).
    it('injects <base href> with the configured prefix and trailing slash', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`<base href="${PREFIX}/">`);
    });

    it('places <base href> ahead of the interceptor script in document order', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        const baseIdx = out.indexOf('<base href=');
        const scriptIdx = out.indexOf('<script>');
        expect(baseIdx).toBeGreaterThanOrEqual(0);
        expect(scriptIdx).toBeGreaterThanOrEqual(0);
        expect(baseIdx).toBeLessThan(scriptIdx);
    });

    it('interceptor embeds the configured prefix', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).toContain(`var P='${PREFIX}'`);
    });

    it('interceptor no longer embeds a ptoken constant (cookie replaces it)', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX);
        expect(out).not.toContain(`var T=`);
        expect(out).not.toContain('ptoken=');
    });

    it('interceptor patches fetch and XMLHttpRequest', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain('window.fetch');
        expect(out).toContain('XMLHttpRequest.prototype.open');
    });

    it('interceptor stubs WebSocket for HMR protocols', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain('NoopWS');
        expect(out).toContain('vite-hmr');
    });
});

// Phase 2.5 (specs/preview-nextjs-turbopack-hydration/): Next.js App Router /
// Turbopack uses paths inside __next_f.push as resolver keys that must remain
// in their canonical "/_next/..." form so BACKEND.registerChunk's `chunkUrl =
// getChunkRelativeUrl(chunkPath)` matches the resolver created at fetch time.
// We deliberately do NOT rewrite these paths. Instead, the interceptor's
// HTMLScriptElement.src setter patch (below) redirects the actual fetch
// through the proxy while preserving the canonical attribute value.
describe('rewriteHtml — RSC flight stream MUST NOT be rewritten (Phase 2.5)', () => {
    it('leaves \\"/_next/...\\" paths inside __next_f.push JSON unchanged', () => {
        const input = `<script>self.__next_f.push([1,"7:I[\\"/_next/static/chunks/app.js\\"]"])</script>`;
        const out = rewriteHtml(input, PREFIX);
        // The path inside the JSON-escaped script body must remain "/_next/..."
        // because Turbopack uses it as a resolver key.
        expect(out).toContain(`7:I[\\"/_next/static/chunks/app.js\\"]`);
        expect(out).not.toContain(`${PREFIX}/_next/static/chunks/app.js`);
    });

    it('leaves real-world Next.js RSC HL+I payload unchanged', () => {
        const input = `<script>self.__next_f.push([1,":HL[\\"/_next/static/chunks/%5Broot-of-the-server%5D__d56404ae._.css\\",\\"style\\"]\\n7:I[\\"/_next/static/chunks/953a0._.js\\"]"])</script>`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`HL[\\"/_next/static/chunks/%5Broot-of-the-server%5D__d56404ae._.css\\"`);
        expect(out).toContain(`I[\\"/_next/static/chunks/953a0._.js\\"]`);
    });

    it('does still rewrite external <script src="/_next/..."> attributes (ABS_PATH_ATTRS regression)', () => {
        const input = `<script src="/_next/static/foo.js"></script>`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`src="${PREFIX}/_next/static/foo.js"`);
    });
});

// Phase 3 (specs/preview-nextjs-turbopack-hydration/): multi-URL attributes
// like `srcset`, `imagesrcset` (lowercase HTML form) and `imageSrcSet`
// (React/JSX form) are comma-separated URL+descriptor pairs. ABS_PATH_ATTRS
// can't rewrite them as a single string — each URL token must be
// rewritten independently while preserving the descriptor (1x, 2x, 300w).
describe('rewriteHtml — srcset / imageSrcSet multi-URL rewriting (Phase 3)', () => {
    it('rewrites both URLs in a simple srcset attribute', () => {
        const out = rewriteHtml('<img srcset="/a.png 1x, /b.png 2x">', PREFIX);
        expect(out).toContain(`srcset="${PREFIX}/a.png 1x, ${PREFIX}/b.png 2x"`);
    });

    it('rewrites URLs in imageSrcSet (JSX camelCase form Next.js emits)', () => {
        const input = `<link rel="preload" as="image" imageSrcSet="/_next/image?url=%2Fx.png&amp;w=96 1x, /_next/image?url=%2Fx.png&amp;w=256 2x"/>`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`${PREFIX}/_next/image?url=%2Fx.png&amp;w=96 1x`);
        expect(out).toContain(`${PREFIX}/_next/image?url=%2Fx.png&amp;w=256 2x`);
    });

    it('rewrites URLs in imagesrcset (lowercase HTML form)', () => {
        const out = rewriteHtml(`<link rel="preload" as="image" imagesrcset="/a.png 1x, /b.png 2x">`, PREFIX);
        expect(out).toContain(`${PREFIX}/a.png 1x`);
        expect(out).toContain(`${PREFIX}/b.png 2x`);
    });

    it('leaves external + protocol-relative URLs untouched, rewrites absolute ones', () => {
        const out = rewriteHtml(
            `<img srcset="https://cdn.example.com/x.png 1x, //cdn/y.png 2x, /local.png 3x">`,
            PREFIX,
        );
        expect(out).toContain('https://cdn.example.com/x.png 1x');
        expect(out).toContain('//cdn/y.png 2x');
        expect(out).toContain(`${PREFIX}/local.png 3x`);
        // No double-prefix on protocol-relative
        expect(out).not.toContain(`${PREFIX}//cdn`);
    });

    it('preserves srcset URLs already prefixed (idempotent)', () => {
        const input = `<img srcset="${PREFIX}/a.png 1x">`;
        const out = rewriteHtml(input, PREFIX);
        expect(out).toContain(`srcset="${PREFIX}/a.png 1x"`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('handles a single URL without descriptor in srcset', () => {
        const out = rewriteHtml(`<img srcset="/only.png">`, PREFIX);
        expect(out).toContain(`srcset="${PREFIX}/only.png"`);
    });
});

describe('rewriteHtml — interceptor script src/href/setAttribute patches', () => {
    it('patches src setter on HTMLScriptElement / HTMLImageElement', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`patchSetter(HTMLScriptElement.prototype,'src')`);
        expect(out).toContain(`patchSetter(HTMLImageElement.prototype,'src')`);
    });

    it('patches href setter on HTMLLinkElement', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`patchSetter(HTMLLinkElement.prototype,'href')`);
    });

    it('setter delegates to rw() so it covers every absolute / path, not just /_next/', () => {
        // The rw() helper is already defined for fetch/XHR — reusing it makes
        // setter behavior symmetric and idempotent. Without this, user code
        // like `script.src = '/api/widget.js'` would bypass the proxy.
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`set:function(v){d.set.call(this,rw(v))}`);
    });

    it('narrows setAttribute patch to HTMLScript / HTMLLink / HTMLImage prototypes (no global Element.prototype patch)', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`patchSetAttr(HTMLScriptElement.prototype)`);
        expect(out).toContain(`patchSetAttr(HTMLLinkElement.prototype)`);
        expect(out).toContain(`patchSetAttr(HTMLImageElement.prototype)`);
        // Must NOT install on Element.prototype (would slow every setAttribute call)
        expect(out).not.toMatch(/Element\.prototype\.setAttribute\s*=/);
    });

    it('setAttribute patch covers src / href / action and is case-insensitive on attr name', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`(nl==='src'||nl==='href'||nl==='action')`);
        expect(out).toContain(`n.toLowerCase()`);
        expect(out).toContain(`v=rw(v)`);
    });

    it('keeps HTMLScriptElement.getAttribute(src) strip narrow to /_next/ (Turbopack-specific)', () => {
        // Stripping the prefix back is only needed for Turbopack's
        // getPathFromScript, which expects the canonical "/_next/" form.
        // For user-code paths like /api/foo, callers expect what they set.
        const out = rewriteHtml('<html><head></head></html>', PREFIX);
        expect(out).toContain(`HTMLScriptElement.prototype.getAttribute=function`);
        expect(out).toContain(`v.indexOf(P+'/_next/')===0`);
        expect(out).toContain(`v.slice(P.length)`);
    });
});

describe('rewriteJsCss', () => {
    it('rewrites ES import paths', () => {
        const out = rewriteJsCss(`import x from '/lib/x.js'`, PREFIX);
        expect(out).toContain(`'${PREFIX}/lib/x.js'`);
    });

    it('rewrites CSS url() references', () => {
        const out = rewriteJsCss(`.bg{background:url("/img/bg.png")}`, PREFIX);
        expect(out).toContain(`url("${PREFIX}/img/bg.png")`);
    });

    it('leaves protocol-relative paths untouched and does not double-prefix', () => {
        const input = `import a from '//cdn/lib.js'; import b from '${PREFIX}/local.js';`;
        const out = rewriteJsCss(input, PREFIX);
        expect(out).toContain("'//cdn/lib.js'");
        expect(out).toContain(`'${PREFIX}/local.js'`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('preserves existing query strings on rewritten paths', () => {
        const out = rewriteJsCss(`@import url("/theme.css?v=2")`, PREFIX);
        expect(out).toContain(`url("${PREFIX}/theme.css?v=2")`);
    });

    it('does not append ?ptoken= to rewritten URLs', () => {
        const input = `import x from '/a.js'; .bg{background:url("/img/b.png")}`;
        const out = rewriteJsCss(input, PREFIX);
        expect(out).not.toContain('ptoken=');
    });
});
