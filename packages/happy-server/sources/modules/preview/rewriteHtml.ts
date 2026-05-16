/**
 * HTML / JS / CSS path rewriting for remote preview.
 *
 * Upstream dev servers emit absolute paths (e.g. `src="/main.js"`) that would
 * resolve to happy-server's own origin when served through the preview route.
 * This module rewrites those paths to include the per-request prefix
 * (`/v1/preview/{machineId}/{port}`) and injects a small browser-side shim
 * that:
 *
 * - rewrites `fetch(...)` / `XMLHttpRequest.open(...)` to go through the
 *   prefix so app-level API calls end up at the same dev server
 * - strips the prefix from `window.location.pathname` so SPA routers see
 *   clean paths
 * - stubs `WebSocket` for known HMR protocols (Vite / Next.js / Webpack)
 *
 * Auth is delivered via a per-preview HttpOnly cookie set by the relay on
 * the first response (see previewCookie.ts, Phase 9). The rewriter no
 * longer touches the auth secret — URLs stay clean so they don't leak into
 * browser history / referrer / DevTools / CDN cache keys.
 *
 * Kept in sync with the `preview-api-proxy` spec (R5 / R7).
 */

// Each regex captures three groups: (prefix/keyword, path, closing-delimiter)
// so the replacement can check `path.startsWith(prefix)` and avoid doubling
// an already-prefixed URL without a separate post-pass.
const ABS_PATH_ATTRS = /((?:src|href|action)\s*=\s*["'])(\/(?!\/)[^"']*?)(["'])/g;
const ABS_PATH_IMPORT = /((?:from|import)\s*\(?\s*["'])(\/(?!\/)[^"']*?)(["'])/g;
const ABS_PATH_CSS_URL = /(url\(\s*["']?)(\/(?!\/)[^"')\s]*)(["']?\s*\))/g;

// `srcset`, `imagesrcset` (HTML), `imageSrcSet` (React JSX camelCase) carry
// comma-separated URL+descriptor pairs (e.g. `/a.png 1x, /b.png 2x`). They
// don't fit ABS_PATH_ATTRS's single-URL shape, so we handle them with a
// dedicated pass that tokenizes each pair, rewrites the URL part if it's
// an absolute path, and preserves the descriptor verbatim.
const MULTI_URL_ATTRS = /((?:srcset|imagesrcset|imageSrcSet)\s*=\s*["'])([^"']+)(["'])/g;

function rewriteSrcSetValue(value: string, prefix: string): string {
    return value
        .split(',')
        .map((part) => {
            const trimmed = part.trim();
            if (!trimmed) return part;
            const spaceIdx = trimmed.search(/\s/);
            const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
            const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
            // Only rewrite absolute paths starting with `/` but not `//`
            const shouldRewrite =
                url.startsWith('/') && !url.startsWith('//') && !url.startsWith(prefix);
            const rewritten = shouldRewrite ? `${prefix}${url}` : url;
            return `${rewritten}${descriptor}`;
        })
        .join(', ');
}

// NOTE on RSC flight stream: Next.js App Router emits the React Server
// Components flight stream as inline <script>self.__next_f.push([1, "<JSON>"])</script>
// containing absolute /_next/... paths inside `I[...]` import directives.
// We deliberately do NOT rewrite those paths even though they "look like"
// absolute URLs — the Turbopack runtime uses them as resolver keys that
// must match `getChunkRelativeUrl(chunkPath) === "/_next/" + chunkPath`.
// Rewriting them to `/v1/preview/.../3001/_next/...` causes the resolver
// to wait on a key that BACKEND.registerChunk never resolves, silently
// stalling hydration. See specs/preview-nextjs-turbopack-hydration/
// Phase 2.5 for the diagnosis. The actual fetch is redirected through
// the proxy via the interceptor's HTMLScriptElement.src setter patch.

function makeReplacer(prefix: string) {
    return (_match: string, pre: string, path: string, tail: string): string => {
        const prefixed = path.startsWith(prefix) ? path : `${prefix}${path}`;
        return `${pre}${prefixed}${tail}`;
    };
}

export function rewriteJsCss(text: string, prefix: string): string {
    const rep = makeReplacer(prefix);
    return text
        .replace(ABS_PATH_IMPORT, rep)
        .replace(ABS_PATH_CSS_URL, rep);
}

export function rewriteHtml(html: string, prefix: string): string {
    const rep = makeReplacer(prefix);
    let out = html
        .replace(ABS_PATH_ATTRS, rep)
        .replace(ABS_PATH_IMPORT, rep)
        .replace(MULTI_URL_ATTRS, (_match, head: string, list: string, tail: string) =>
            `${head}${rewriteSrcSetValue(list, prefix)}${tail}`,
        );

    // <base> pins the document base URL so relative-path resources
    // (`<script src="app.js">`) survive the interceptor's history.replaceState.
    const baseHref = `<base href="${prefix}/">`;
    const headInjection = baseHref + buildInterceptorScript(prefix);
    if (out.includes('<head>')) {
        out = out.replace('<head>', `<head>${headInjection}`);
    } else if (out.includes('<html>')) {
        out = out.replace('<html>', `<html>${headInjection}`);
    } else {
        out = headInjection + out;
    }
    return out;
}

function buildInterceptorScript(prefix: string): string {
    // Kept as a single string so the rewriter doesn't accidentally patch its
    // own path literals. Escape single quotes in prefix so the embedded
    // `var P='…'` stays syntactically valid.
    const p = prefix.replace(/'/g, "\\'");
    return (
        `<script>(function(){` +
        `var P='${p}';` +
        `function rw(u){` +
        `if(typeof u!=='string'||u.charAt(0)!=='/'||u.charAt(1)==='/')return u;` +
        `return u.indexOf(P)===0?u:P+u` +
        `}` +
        `var loc=window.location.pathname;` +
        `if(loc.indexOf(P)===0){history.replaceState(null,'',loc.slice(P.length)||'/')}` +
        `var _WS=window.WebSocket;` +
        `function NoopWS(){` +
        `this.readyState=1;this.protocol='';this.extensions='';this.bufferedAmount=0;this.binaryType='blob';` +
        `this.onopen=null;this.onclose=null;this.onmessage=null;this.onerror=null;` +
        `this.send=function(){};this.close=function(){this.readyState=3};` +
        `var self=this;this._listeners={};` +
        `this.addEventListener=function(t,fn){if(!self._listeners[t])self._listeners[t]=[];self._listeners[t].push(fn)};` +
        `this.removeEventListener=function(t,fn){if(self._listeners[t])self._listeners[t]=self._listeners[t].filter(function(f){return f!==fn})};` +
        `this.dispatchEvent=function(e){var ls=self._listeners[e.type]||[];ls.forEach(function(fn){fn(e)});return true};` +
        `setTimeout(function(){if(self.onopen)self.onopen({type:'open'});self.dispatchEvent({type:'open'})},0)` +
        `}` +
        `NoopWS.CONNECTING=0;NoopWS.OPEN=1;NoopWS.CLOSING=2;NoopWS.CLOSED=3;` +
        `window.WebSocket=function(u,p){` +
        `if(p==='vite-hmr'||p==='vite-ping'||` +
        `(u&&(u.indexOf('__vite')!==-1||u.indexOf('/_next/webpack')!==-1||u.indexOf('hot-update')!==-1)))return new NoopWS();` +
        `return p?new _WS(u,p):new _WS(u)};` +
        `window.WebSocket.prototype=_WS.prototype;` +
        `window.WebSocket.CONNECTING=0;window.WebSocket.OPEN=1;window.WebSocket.CLOSING=2;window.WebSocket.CLOSED=3;` +
        `var oF=window.fetch;window.fetch=function(i,n){if(typeof i==='string')i=rw(i);return oF.call(this,i,n)};` +
        `var oO=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==='string')arguments[1]=rw(u);return oO.apply(this,arguments)};` +
        // Phase 2.5 fix for Next.js / Turbopack: the runtime's getPathFromScript
        // strips a hardcoded "/_next/" prefix from script.src to derive the
        // chunk registry key. Our HTML rewrite turns "/_next/foo.js" into
        // "${P}/_next/foo.js", so the runtime fails to strip → registry key
        // becomes the full prefixed path, doesn't match the chunkList entry
        // ("static/chunks/foo.js"), entry chunk never executes, hydration
        // never starts. We work around by (a) intercepting dynamic
        // HTMLScriptElement.src / HTMLLinkElement.href setters and adding the
        // prefix when the runtime tries to load "/_next/..." chunks, and
        // (b) overriding HTMLScriptElement.prototype.getAttribute so that
        // reading src returns the unprefixed "/_next/..." form Turbopack
        // expects. See specs/preview-nextjs-turbopack-hydration/ Phase 2.5.
        `function patchSetter(proto,attr){` +
        `var d=Object.getOwnPropertyDescriptor(proto,attr);if(!d||!d.set)return;` +
        `Object.defineProperty(proto,attr,{configurable:true,` +
        `get:function(){return d.get.call(this)},` +
        `set:function(v){if(typeof v==='string'&&v.indexOf('/_next/')===0)v=P+v;d.set.call(this,v)}})` +
        `}` +
        `patchSetter(HTMLScriptElement.prototype,'src');` +
        `patchSetter(HTMLLinkElement.prototype,'href');` +
        // setAttribute bypasses the property setter — React's RSC reader
        // uses `link.setAttribute('href', '/_next/...')` for HL[] preload
        // directives, so we also intercept setAttribute. Without this,
        // RSC-driven preloads target location.origin (the relay host) and
        // log "preloaded using link preload but not used" warnings.
        `var oSA=Element.prototype.setAttribute;` +
        `Element.prototype.setAttribute=function(n,v){` +
        `if((n==='src'||n==='href')&&typeof v==='string'&&v.indexOf('/_next/')===0)v=P+v;` +
        `return oSA.call(this,n,v)};` +
        `var oGA=Element.prototype.getAttribute;` +
        `HTMLScriptElement.prototype.getAttribute=function(n){` +
        `var v=oGA.call(this,n);` +
        `if(n==='src'&&typeof v==='string'&&v.indexOf(P+'/_next/')===0)return v.slice(P.length);` +
        `return v};` +
        `})()</script>`
    );
}
