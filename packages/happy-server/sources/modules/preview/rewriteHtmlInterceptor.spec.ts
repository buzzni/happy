import { describe, it, expect, beforeEach } from 'vitest';
import vm from 'node:vm';
import { rewriteHtml } from '@/modules/preview/rewriteHtml';

/**
 * Integration tests for the interceptor IIFE that rewriteHtml injects.
 *
 * Why this exists: the rest of the suite only asserts that the interceptor
 * STRING contains expected substrings. That catches refactors that change
 * the structure but not subtle runtime bugs (off-by-one in slice, missing
 * idempotency, wrong attribute case match, etc.). Here we evaluate the
 * interceptor body in a controlled `vm.Context` against a minimal DOM
 * stub and observe behavior. No jsdom dependency — keeps the submodule
 * lean.
 *
 * The stub mimics just the surface area the interceptor touches:
 * src/href getter+setter on HTMLScript / HTMLLink / HTMLImage prototypes,
 * setAttribute on Element.prototype, and a no-op WebSocket / fetch /
 * XMLHttpRequest so the interceptor's monkey-patches don't crash.
 */

const PREFIX = '/v1/preview/m1/3000';

interface FakeElement {
    attributes: Map<string, string>;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
}

function buildSandbox() {
    // --- Minimal DOM stub -------------------------------------------------
    class FakeElement {
        attributes: Map<string, string> = new Map();
        getAttribute(name: string): string | null {
            return this.attributes.get(name.toLowerCase()) ?? null;
        }
        setAttribute(name: string, value: string): void {
            this.attributes.set(name.toLowerCase(), String(value));
        }
    }

    // `declare` keeps the type-only declaration (no field emitted at
    // runtime) so it doesn't shadow the accessor we install on the
    // prototype via defineUrlAccessor below.
    class FakeScriptElement extends FakeElement {
        declare src: string;
    }
    class FakeLinkElement extends FakeElement {
        declare href: string;
    }
    class FakeImageElement extends FakeElement {
        declare src: string;
        declare srcset: string;
    }
    class FakeSourceElement extends FakeElement {
        declare srcset: string;
    }

    // The real DOM exposes `src` / `href` as accessor properties on the
    // *element prototype* (HTMLScriptElement.prototype.src etc.) that
    // delegate to the underlying attribute. Mimic that — the interceptor's
    // patchSetter uses Object.getOwnPropertyDescriptor(proto, attr) to find
    // and wrap this accessor.
    function defineUrlAccessor(proto: any, attr: string) {
        Object.defineProperty(proto, attr, {
            configurable: true,
            get(this: FakeElement) {
                return this.getAttribute(attr) ?? '';
            },
            set(this: FakeElement, v: string) {
                this.setAttribute(attr, v);
            },
        });
    }
    defineUrlAccessor(FakeScriptElement.prototype, 'src');
    defineUrlAccessor(FakeLinkElement.prototype, 'href');
    defineUrlAccessor(FakeImageElement.prototype, 'src');
    defineUrlAccessor(FakeImageElement.prototype, 'srcset');
    defineUrlAccessor(FakeSourceElement.prototype, 'srcset');

    // No-op WebSocket / XMLHttpRequest / fetch so monkey-patches don't blow up.
    class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
    }
    class FakeXHR {
        open(_method: string, _url: string) {}
    }
    function fakeFetch() {
        return Promise.resolve();
    }

    // History / location minimal stub: pathname must be settable indirectly
    // via history.replaceState (interceptor uses this to strip the prefix).
    const fakeWindow: any = {
        WebSocket: FakeWebSocket,
        fetch: fakeFetch,
        XMLHttpRequest: FakeXHR,
        location: { pathname: '/' },
        setTimeout: (fn: () => void) => fn(),
    };
    fakeWindow.window = fakeWindow;

    const sandbox = {
        window: fakeWindow,
        HTMLScriptElement: FakeScriptElement,
        HTMLLinkElement: FakeLinkElement,
        HTMLImageElement: FakeImageElement,
        HTMLSourceElement: FakeSourceElement,
        Element: FakeElement,
        history: {
            replaceState: (_state: unknown, _title: string, url: string) => {
                fakeWindow.location.pathname = url;
            },
        },
        WebSocket: FakeWebSocket,
        XMLHttpRequest: FakeXHR,
        setTimeout: fakeWindow.setTimeout,
        // Expose Object / etc. as-is (the interceptor uses them directly,
        // not via window.Object).
        Object,
        Promise,
    };
    return { sandbox, FakeScriptElement, FakeLinkElement, FakeImageElement, FakeSourceElement };
}

function runInterceptor(sandbox: Record<string, unknown>) {
    const html = rewriteHtml('<html><head></head></html>', PREFIX);
    const m = html.match(/<script>([\s\S]+?)<\/script>/);
    if (!m) throw new Error('no interceptor <script> found');
    const ctx = vm.createContext(sandbox);
    vm.runInContext(m[1], ctx);
}

describe('rewriteHtml interceptor — runtime behavior in stubbed DOM', () => {
    let bag: ReturnType<typeof buildSandbox>;

    beforeEach(() => {
        bag = buildSandbox();
        runInterceptor(bag.sandbox);
    });

    describe('script.src setter (broadened via rw())', () => {
        it('prefixes a /_next/ absolute path', () => {
            const s = new bag.FakeScriptElement();
            s.src = '/_next/foo.js';
            // getAttribute strip narrow to /_next/ → returns canonical
            expect(s.getAttribute('src')).toBe('/_next/foo.js');
        });

        it('prefixes a /api/ absolute path (the broadening)', () => {
            const s = new bag.FakeScriptElement();
            s.src = '/api/widget.js';
            // No Turbopack strip for /api/ → attribute stays prefixed
            expect(s.getAttribute('src')).toBe(`${PREFIX}/api/widget.js`);
        });

        it('does NOT double-prefix already-prefixed paths (idempotency via rw)', () => {
            const s = new bag.FakeScriptElement();
            s.src = `${PREFIX}/_next/foo.js`;
            // attribute stays as the prefixed form; rw skipped re-prefixing
            expect(s.getAttribute('src')).toBe('/_next/foo.js');
        });

        it('leaves protocol-relative // URLs untouched', () => {
            const s = new bag.FakeScriptElement();
            s.src = '//cdn.example.com/lib.js';
            expect(s.getAttribute('src')).toBe('//cdn.example.com/lib.js');
        });

        it('leaves absolute external URLs untouched', () => {
            const s = new bag.FakeScriptElement();
            s.src = 'https://example.com/lib.js';
            expect(s.getAttribute('src')).toBe('https://example.com/lib.js');
        });
    });

    describe('link.href setter', () => {
        it('prefixes /_next/ paths', () => {
            const l = new bag.FakeLinkElement();
            l.href = '/_next/style.css';
            // No Turbopack strip on link.href → stays prefixed
            expect(l.getAttribute('href')).toBe(`${PREFIX}/_next/style.css`);
        });

        it('prefixes arbitrary /api/ paths', () => {
            const l = new bag.FakeLinkElement();
            l.href = '/api/manifest.json';
            expect(l.getAttribute('href')).toBe(`${PREFIX}/api/manifest.json`);
        });
    });

    describe('img.src setter (Next.js Image dynamic swap)', () => {
        it('prefixes /_next/image preview path', () => {
            const i = new bag.FakeImageElement();
            i.src = '/_next/image?url=foo&w=128';
            expect(i.getAttribute('src')).toBe(`${PREFIX}/_next/image?url=foo&w=128`);
        });
    });

    describe('img.srcset / source.srcset setter — multi-URL rewrite via rwSet', () => {
        it('prefixes both URLs in img.srcset (next/image responsive variants)', () => {
            const i = new bag.FakeImageElement();
            i.srcset = '/_next/image?url=foo&w=96 1x, /_next/image?url=foo&w=256 2x';
            expect(i.getAttribute('srcset')).toBe(
                `${PREFIX}/_next/image?url=foo&w=96 1x, ${PREFIX}/_next/image?url=foo&w=256 2x`,
            );
        });

        it('prefixes URLs in <source> srcset (<picture> element)', () => {
            const s = new bag.FakeSourceElement();
            s.srcset = '/a.webp 1x, /b.webp 2x';
            expect(s.getAttribute('srcset')).toBe(`${PREFIX}/a.webp 1x, ${PREFIX}/b.webp 2x`);
        });

        it('leaves external + protocol-relative + already-prefixed URLs untouched', () => {
            const i = new bag.FakeImageElement();
            i.srcset = `https://cdn/x.png 1x, //cdn/y.png 2x, ${PREFIX}/already.png 3x, /local.png 4x`;
            expect(i.getAttribute('srcset')).toBe(
                `https://cdn/x.png 1x, //cdn/y.png 2x, ${PREFIX}/already.png 3x, ${PREFIX}/local.png 4x`,
            );
        });

        it('handles single URL without descriptor', () => {
            const i = new bag.FakeImageElement();
            i.srcset = '/only.png';
            expect(i.getAttribute('srcset')).toBe(`${PREFIX}/only.png`);
        });
    });

    describe('setAttribute (narrowed to Script / Link / Image)', () => {
        it('script.setAttribute(src, "/_next/...") fires rw', () => {
            const s = new bag.FakeScriptElement();
            s.setAttribute('src', '/_next/bar.js');
            // Turbopack strip on script src getAttribute
            expect(s.getAttribute('src')).toBe('/_next/bar.js');
        });

        it('script.setAttribute("SRC", ...) is case-insensitive', () => {
            const s = new bag.FakeScriptElement();
            s.setAttribute('SRC', '/_next/baz.js');
            expect(s.getAttribute('src')).toBe('/_next/baz.js');
        });

        it('script.setAttribute(action, ...) ALSO covered by rw via lowercase match', () => {
            const s = new bag.FakeScriptElement();
            s.setAttribute('action', '/api/submit');
            expect(s.getAttribute('action')).toBe(`${PREFIX}/api/submit`);
        });

        it('link.setAttribute(href, ...) (the RSC HL[] path)', () => {
            const l = new bag.FakeLinkElement();
            l.setAttribute('href', '/_next/static/x.css');
            expect(l.getAttribute('href')).toBe(`${PREFIX}/_next/static/x.css`);
        });

        it('script.setAttribute(id, "/_next/...") — non-resource attr untouched', () => {
            const s = new bag.FakeScriptElement();
            s.setAttribute('id', '/_next/looks-like-path');
            expect(s.getAttribute('id')).toBe('/_next/looks-like-path');
        });

        it('img.setAttribute(srcset, multi-URL) — the next/image post-hydration path', () => {
            // This is the bug the user reported: next/image swaps srcset
            // attribute via setAttribute after hydration → bypasses the
            // .srcset property setter, so we also intercept setAttribute.
            const i = new bag.FakeImageElement();
            i.setAttribute('srcset', '/_next/image?url=foo&w=96 1x, /_next/image?url=foo&w=256 2x');
            expect(i.getAttribute('srcset')).toBe(
                `${PREFIX}/_next/image?url=foo&w=96 1x, ${PREFIX}/_next/image?url=foo&w=256 2x`,
            );
        });

        it('img.setAttribute(imagesrcset, ...) — lowercase HTML form', () => {
            const i = new bag.FakeImageElement();
            i.setAttribute('imagesrcset', '/a 1x, /b 2x');
            expect(i.getAttribute('imagesrcset')).toBe(`${PREFIX}/a 1x, ${PREFIX}/b 2x`);
        });
    });

    describe('history.replaceState — strips prefix from pathname so SPA routers see clean paths', () => {
        it('runs replaceState when current pathname starts with the proxy prefix', () => {
            // The interceptor runs on script execution. We set pathname before
            // running and verify the side effect via the sandbox's window.
            // Reset and re-run with a prefixed pathname.
            const fresh = buildSandbox();
            fresh.sandbox.window.location.pathname = `${PREFIX}/some/route`;
            runInterceptor(fresh.sandbox);
            expect(fresh.sandbox.window.location.pathname).toBe('/some/route');
        });

        it('leaves an unprefixed pathname unchanged', () => {
            const fresh = buildSandbox();
            fresh.sandbox.window.location.pathname = '/some/route';
            runInterceptor(fresh.sandbox);
            expect(fresh.sandbox.window.location.pathname).toBe('/some/route');
        });

        it('replaces a prefix-only pathname with "/" (root, not empty)', () => {
            const fresh = buildSandbox();
            fresh.sandbox.window.location.pathname = PREFIX;
            runInterceptor(fresh.sandbox);
            expect(fresh.sandbox.window.location.pathname).toBe('/');
        });
    });

    describe('forward-compat sentinel — warns if Turbopack hydration silently fails', () => {
        // Helper: build a sandbox that records setTimeout callbacks instead
        // of running them, so we can inspect the deferred warning logic.
        function buildSandboxWithDeferredTimer() {
            const bag = buildSandbox();
            const deferred: Array<{ fn: () => void; ms: number }> = [];
            const sandbox = bag.sandbox as any;
            // Replace the always-immediate setTimeout with a recorder
            sandbox.setTimeout = (fn: () => void, ms: number) => {
                deferred.push({ fn, ms });
            };
            sandbox.window.setTimeout = sandbox.setTimeout;
            // Mock console + document so the sentinel can introspect
            const warnings: string[] = [];
            sandbox.console = { warn: (msg: string) => warnings.push(String(msg)) };
            const scripts: Array<{ src: string }> = [];
            sandbox.document = {
                querySelector: (sel: string) => {
                    // Match `script[src*="_next/static/chunks"]` only
                    if (sel.includes('_next/static/chunks')) {
                        return scripts.find((s) => s.src.includes('_next/static/chunks')) || null;
                    }
                    return null;
                },
            };
            return { sandbox, deferred, warnings, scripts };
        }

        it('does NOT warn when window.next.turbopack is set (happy path)', () => {
            const { sandbox, deferred, warnings, scripts } = buildSandboxWithDeferredTimer();
            scripts.push({ src: '/v1/preview/m1/3000/_next/static/chunks/foo.js' });
            runInterceptor(sandbox);
            // Hydration succeeded
            sandbox.window.next = { turbopack: true };
            // Fire the deferred sentinel
            expect(deferred.length).toBe(1);
            expect(deferred[0].ms).toBe(8000);
            deferred[0].fn();
            expect(warnings).toEqual([]);
        });

        it('does NOT warn when no Turbopack chunk scripts in the document (non-Next app)', () => {
            const { sandbox, deferred, warnings, scripts } = buildSandboxWithDeferredTimer();
            // No /_next/static/chunks scripts → not a Next.js page
            void scripts;
            runInterceptor(sandbox);
            deferred[0].fn();
            expect(warnings).toEqual([]);
        });

        it('WARNS when Turbopack chunks are present but window.next.turbopack never sets', () => {
            const { sandbox, deferred, warnings, scripts } = buildSandboxWithDeferredTimer();
            scripts.push({ src: '/v1/preview/m1/3000/_next/static/chunks/foo.js' });
            runInterceptor(sandbox);
            // Hydration never completed (sentinel-trigger condition)
            deferred[0].fn();
            expect(warnings.length).toBe(1);
            expect(warnings[0]).toContain('hydration did not complete');
            expect(warnings[0]).toContain('specs/preview-nextjs-turbopack-hydration');
        });
    });

    describe('WebSocket shim — Vite/Next HMR protocols swap in NoopWS', () => {
        it('vite-hmr protocol returns a NoopWS instance', () => {
            const w = new bag.sandbox.window.WebSocket('ws://anything', 'vite-hmr');
            expect(w.readyState).toBe(1);
            // NoopWS has a no-op send
            expect(typeof w.send).toBe('function');
            w.send('test'); // must not throw
        });

        it('vite-ping protocol returns NoopWS', () => {
            const w = new bag.sandbox.window.WebSocket('ws://anything', 'vite-ping');
            expect(w.readyState).toBe(1);
        });

        it('URL containing /_next/webpack returns NoopWS', () => {
            const w = new bag.sandbox.window.WebSocket('ws://host/_next/webpack-hmr', '');
            expect(w.readyState).toBe(1);
        });

        it('arbitrary WebSocket URL falls through to native (here: our stub)', () => {
            // Our stub FakeWebSocket has no constructor args/instance state.
            // The shim path: `return p?new _WS(u,p):new _WS(u)` — calls the
            // saved native ctor. With FakeWebSocket it returns an instance
            // without our NoopWS shape, but with the static constants.
            const w = new bag.sandbox.window.WebSocket('ws://host/something-else', '');
            expect(w).toBeInstanceOf(bag.sandbox.WebSocket);
        });
    });
});
