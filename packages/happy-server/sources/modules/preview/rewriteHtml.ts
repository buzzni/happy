/**
 * HTML / JS / CSS path rewriting for remote preview.
 *
 * Upstream dev servers emit absolute paths (e.g. `src="/main.js"`) that would
 * resolve to happy-server's own origin when served through the preview route.
 * This module rewrites those paths to include the per-request prefix
 * (`/v1/preview/{machineId}/{port}`) AND the per-session `ptoken` query param
 * (otherwise every subresource request would fail auth with 401 — see
 * specs/remote-preview-relay Phase 8 H1), and injects a small browser-side
 * shim that:
 *
 * - rewrites `fetch(...)` / `XMLHttpRequest.open(...)` to go through the
 *   prefix + ptoken so app-level API calls end up at the same dev server
 * - strips the prefix from `window.location.pathname` so SPA routers see
 *   clean paths
 * - stubs `WebSocket` for known HMR protocols (Vite / Next.js / Webpack)
 *
 * Ported from `packages/web-ui/vite.config.ts` `/preview-proxy` middleware —
 * kept in sync with the `preview-api-proxy` spec (R5 / R7).
 */

// Each regex captures three groups: (prefix/keyword, path, closing-delimiter).
// Capturing the full path lets us prefix AND tack on ?ptoken in a single pass.
const ABS_PATH_ATTRS = /((?:src|href|action)\s*=\s*["'])(\/(?!\/)[^"']*?)(["'])/g;
const ABS_PATH_IMPORT = /((?:from|import)\s*\(?\s*["'])(\/(?!\/)[^"']*?)(["'])/g;
const ABS_PATH_CSS_URL = /(url\(\s*["']?)(\/(?!\/)[^"')\s]*)(["']?\s*\))/g;

function appendPtoken(url: string, ptoken: string): string {
    // Idempotent: never stack ptoken twice on the same URL. Matches at start
    // or after ? / & to be safe.
    if (/(?:^|[?&])ptoken=/.test(url)) return url;
    const sep = url.indexOf('?') >= 0 ? '&' : '?';
    return `${url}${sep}ptoken=${encodeURIComponent(ptoken)}`;
}

function makeReplacer(prefix: string, ptoken: string) {
    return (_match: string, pre: string, path: string, tail: string): string => {
        const prefixed = path.startsWith(prefix) ? path : `${prefix}${path}`;
        return `${pre}${appendPtoken(prefixed, ptoken)}${tail}`;
    };
}

export function rewriteJsCss(text: string, prefix: string, ptoken: string): string {
    const rep = makeReplacer(prefix, ptoken);
    return text
        .replace(ABS_PATH_IMPORT, rep)
        .replace(ABS_PATH_CSS_URL, rep);
}

export function rewriteHtml(html: string, prefix: string, ptoken: string): string {
    const rep = makeReplacer(prefix, ptoken);
    let out = html
        .replace(ABS_PATH_ATTRS, rep)
        .replace(ABS_PATH_IMPORT, rep);

    const interceptor = buildInterceptorScript(prefix, ptoken);
    if (out.includes('<head>')) {
        out = out.replace('<head>', `<head>${interceptor}`);
    } else if (out.includes('<html>')) {
        out = out.replace('<html>', `<html>${interceptor}`);
    } else {
        out = interceptor + out;
    }
    return out;
}

function buildInterceptorScript(prefix: string, ptoken: string): string {
    // Kept as a single string so the rewriter doesn't accidentally patch its
    // own path literals. Escape single quotes inside prefix/ptoken so the
    // embedded `var P='…'`/`var T='…'` stay syntactically valid.
    const p = prefix.replace(/'/g, "\\'");
    const t = ptoken.replace(/'/g, "\\'");
    return (
        `<script>(function(){` +
        `var P='${p}';var T='${t}';` +
        `function rw(u){` +
        `if(typeof u!=='string'||u.charAt(0)!=='/'||u.charAt(1)==='/')return u;` +
        `var x=u.indexOf(P)===0?u:P+u;` +
        `if(/(?:^|[?&])ptoken=/.test(x))return x;` +
        `return x+(x.indexOf('?')>=0?'&':'?')+'ptoken='+encodeURIComponent(T)` +
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
