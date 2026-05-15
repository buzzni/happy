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
//
// Attribute coverage matches the vite preview-proxy middleware in aplus-dev-studio
// (vite.config.ts ABS_PATH_ATTRS): src/href/action plus poster/data/formaction/
// background. Missing `poster` / `data` / `background` caused <video poster>,
// <object data>, and inline `style="background:url(/...)"` outside <style>
// blocks to leak through with absolute paths. srcset is handled separately
// below because it carries a comma-list of URL+descriptor pairs.
const ABS_PATH_ATTRS = /((?:src|href|action|poster|data|formaction|background)\s*=\s*["'])(\/(?!\/)[^"']*?)(["'])/g;
const ABS_PATH_IMPORT = /((?:from|import)\s*\(?\s*["'])(\/(?!\/)[^"']*?)(["'])/g;
const ABS_PATH_CSS_URL = /(url\(\s*["']?)(\/(?!\/)[^"')\s]*)(["']?\s*\))/g;
const SRCSET_ATTR = /(srcset\s*=\s*)(["'])([^"']+)\2/gi;

function makeReplacer(prefix: string) {
    return (_match: string, pre: string, path: string, tail: string): string => {
        const prefixed = path.startsWith(prefix) ? path : `${prefix}${path}`;
        return `${pre}${prefixed}${tail}`;
    };
}

/**
 * Rewrite each comma-separated entry of a `srcset` attribute. Each entry is
 * `<url> <descriptor>` (descriptor optional, e.g. `2x`, `100w`). Only the
 * URL part can be a path — descriptors stay untouched.
 */
function rewriteSrcset(prefix: string) {
    return (_match: string, head: string, quote: string, list: string): string => {
        const rewritten = list
            .split(',')
            .map((entry) => {
                const trimmed = entry.trim();
                const spaceIdx = trimmed.search(/\s/);
                const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
                const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);
                const isAbsolute =
                    url.startsWith('/') && !url.startsWith('//') && !url.startsWith(prefix);
                const rewrittenUrl = isAbsolute ? `${prefix}${url}` : url;
                return `${rewrittenUrl}${descriptor}`;
            })
            .join(', ');
        return `${head}${quote}${rewritten}${quote}`;
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
        .replace(SRCSET_ATTR, rewriteSrcset(prefix))
        .replace(ABS_PATH_IMPORT, rep)
        .replace(ABS_PATH_CSS_URL, rep);

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
        `})()</script>`
    );
}
