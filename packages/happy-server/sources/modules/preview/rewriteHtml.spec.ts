import { describe, it, expect } from 'vitest';
import { rewriteHtml, rewriteJsCss } from '@/modules/preview/rewriteHtml';

const PREFIX = '/v1/preview/m1/3000';
const PTOKEN = 'tkn-abc123';
// Every subresource the iframe pulls through the relay needs its own ptoken
// — the browser only carries the query string of the initial iframe src,
// so rewritten URLs must bake the token in. See plan.md Phase 8 H1.
const T = `ptoken=${encodeURIComponent(PTOKEN)}`;

describe('rewriteHtml — absolute path rewriting', () => {
    it('rewrites src="/..." to prefix + ptoken', () => {
        const out = rewriteHtml('<img src="/logo.png">', PREFIX, PTOKEN);
        expect(out).toContain(`src="${PREFIX}/logo.png?${T}"`);
    });

    it('rewrites href="/..." to prefix + ptoken', () => {
        const out = rewriteHtml('<link href="/main.css">', PREFIX, PTOKEN);
        expect(out).toContain(`href="${PREFIX}/main.css?${T}"`);
    });

    it('rewrites action="/..." to prefix + ptoken', () => {
        const out = rewriteHtml('<form action="/submit">', PREFIX, PTOKEN);
        expect(out).toContain(`action="${PREFIX}/submit?${T}"`);
    });

    it('uses & separator when the path already has a query string', () => {
        const out = rewriteHtml('<script src="/a.js?v=1"></script>', PREFIX, PTOKEN);
        expect(out).toContain(`src="${PREFIX}/a.js?v=1&${T}"`);
    });

    it('does not append ptoken a second time when it is already present', () => {
        const already = `<img src="/logo.png?${T}">`;
        const out = rewriteHtml(already, PREFIX, PTOKEN);
        expect(out).toContain(`src="${PREFIX}/logo.png?${T}"`);
        // The src attribute must carry exactly one ptoken — scope the count
        // to the attribute so the interceptor script's literals don't leak
        // into the assertion.
        const srcAttr = out.match(/src="[^"]+"/)?.[0] ?? '';
        expect(srcAttr.match(/ptoken=/g) ?? []).toHaveLength(1);
    });

    it('leaves protocol-relative paths (//cdn/...) untouched — no prefix, no ptoken', () => {
        const out = rewriteHtml('<script src="//cdn.example.com/lib.js"></script>', PREFIX, PTOKEN);
        expect(out).toContain('src="//cdn.example.com/lib.js"');
        expect(out).not.toContain(`${PREFIX}//cdn`);
        expect(out).not.toContain(`cdn.example.com/lib.js?${T}`);
    });

    it('does not double-rewrite already-prefixed paths but DOES add ptoken', () => {
        const already = `<img src="${PREFIX}/logo.png">`;
        const out = rewriteHtml(already, PREFIX, PTOKEN);
        expect(out).toContain(`src="${PREFIX}/logo.png?${T}"`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('rewrites ES module imports starting with /', () => {
        const out = rewriteHtml(`<script type="module">import foo from '/src/foo.js'</script>`, PREFIX, PTOKEN);
        expect(out).toContain(`'${PREFIX}/src/foo.js?${T}'`);
    });

    it('rewrites from "/..." in dynamic imports', () => {
        const out = rewriteHtml(`<script>import('/x.js')</script>`, PREFIX, PTOKEN);
        expect(out).toContain(`'${PREFIX}/x.js?${T}'`);
    });

    it('leaves external absolute URLs untouched — no ptoken', () => {
        const out = rewriteHtml('<a href="https://example.com/x">ok</a>', PREFIX, PTOKEN);
        expect(out).toContain('href="https://example.com/x"');
        expect(out).not.toContain(`example.com/x?${T}`);
    });
});

describe('rewriteHtml — interceptor injection', () => {
    it('injects the interceptor script after <head>', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX, PTOKEN);
        expect(out).toMatch(/<head><script>/);
    });

    it('injects after <html> when <head> is absent', () => {
        const out = rewriteHtml('<html><body></body></html>', PREFIX, PTOKEN);
        expect(out).toMatch(/<html><script>/);
    });

    it('prepends interceptor when neither <head> nor <html> is present', () => {
        const out = rewriteHtml('<div>naked fragment</div>', PREFIX, PTOKEN);
        expect(out.startsWith('<script>')).toBe(true);
        expect(out).toContain('<div>naked fragment</div>');
    });

    it('interceptor embeds the configured prefix', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX, PTOKEN);
        expect(out).toContain(`var P='${PREFIX}'`);
    });

    it('interceptor embeds the configured ptoken', () => {
        const out = rewriteHtml('<html><head></head><body></body></html>', PREFIX, PTOKEN);
        expect(out).toContain(`var T='${PTOKEN}'`);
    });

    it('interceptor patches fetch and XMLHttpRequest', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX, PTOKEN);
        expect(out).toContain('window.fetch');
        expect(out).toContain('XMLHttpRequest.prototype.open');
    });

    it('interceptor stubs WebSocket for HMR protocols', () => {
        const out = rewriteHtml('<html><head></head></html>', PREFIX, PTOKEN);
        expect(out).toContain('NoopWS');
        expect(out).toContain('vite-hmr');
    });
});

describe('rewriteJsCss', () => {
    it('rewrites ES import paths with ptoken', () => {
        const out = rewriteJsCss(`import x from '/lib/x.js'`, PREFIX, PTOKEN);
        expect(out).toContain(`'${PREFIX}/lib/x.js?${T}'`);
    });

    it('rewrites CSS url() references with ptoken', () => {
        const out = rewriteJsCss(`.bg{background:url("/img/bg.png")}`, PREFIX, PTOKEN);
        expect(out).toContain(`url("${PREFIX}/img/bg.png?${T}")`);
    });

    it('leaves protocol-relative paths untouched; already-prefixed paths get ptoken only', () => {
        const input = `import a from '//cdn/lib.js'; import b from '${PREFIX}/local.js';`;
        const out = rewriteJsCss(input, PREFIX, PTOKEN);
        expect(out).toContain("'//cdn/lib.js'");
        expect(out).toContain(`'${PREFIX}/local.js?${T}'`);
        expect(out).not.toContain(`${PREFIX}${PREFIX}`);
    });

    it('preserves existing query strings and appends ptoken with &', () => {
        const out = rewriteJsCss(`@import url("/theme.css?v=2")`, PREFIX, PTOKEN);
        expect(out).toContain(`url("${PREFIX}/theme.css?v=2&${T}")`);
    });
});
